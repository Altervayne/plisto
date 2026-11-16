/*
 * One delivery lane: what one side of one plugin receives on one topic. A value goes out at once when
 * the lane was quiet for `GAP`; inside the gap it waits as the pending value, replaced (or, for an edge
 * topic, merged) by later ones, and goes out when the gap ends, so at most four values go out per
 * second and the last one always lands. A state topic is compared by its key: a value whose key is
 * the one the receiver already holds, or is about to, is not sent. A value whose counters are behind
 * ones the lane already sent or was seeded with is older than what the receiver holds and is dropped.
 * The clock is passed in.
 */

// -- Library Imports --
use std::time::{Duration, Instant};

use serde_json::Value;

/// The shortest time between two deliveries on one lane.
pub const GAP: Duration = Duration::from_millis(250);

/// Folds a newer edge value into an older one.
pub type Merge = fn(Value, Value) -> Value;

/// Counters that only move forward, compared one by one.
pub type Order = [u64; 2];

/// How a lane treats one value.
#[derive(Clone, Debug, Default)]
pub struct Rule {
    /// What a state value is compared by; None on an edge topic, which is never compared.
    pub key: Option<Value>,
    /// How an edge value folds into a pending one.
    pub merge: Option<Merge>,
    /// The value's counters; None when it has none.
    pub order: Option<Order>,
}

impl Rule {
    pub fn state(key: Value) -> Rule {
        Rule {
            key: Some(key),
            ..Rule::default()
        }
    }

    pub fn edge(merge: Merge) -> Rule {
        Rule {
            merge: Some(merge),
            ..Rule::default()
        }
    }
}

#[derive(Debug)]
struct Pending {
    data: Value,
    key: Option<Value>,
}

#[derive(Debug, Default)]
pub struct Lane {
    sent_at: Option<Instant>,
    // The key of what the receiver holds; None when unknown or on an edge topic.
    sent: Option<Value>,
    pending: Option<Pending>,
    // The highest counters offered or seeded.
    floor: Option<Order>,
}

impl Lane {
    /// Records that the receiver holds the value `rule` describes without a delivery, as a
    /// subscribe reply does. A pending value is superseded by it.
    pub fn seed(&mut self, rule: Rule) {
        self.sent = rule.key;
        self.pending = None;
        self.raise(rule.order);
    }

    /// Forgets what the receiver holds and any pending value, so the next value offered goes out
    /// even when it equals the last one sent.
    pub fn forget_sent(&mut self) {
        self.sent = None;
        self.pending = None;
    }

    /// Offers a value. Returns the value to send now, if any.
    pub fn offer(&mut self, data: Value, rule: Rule, now: Instant) -> Option<Value> {
        if self.behind(rule.order) {
            return None;
        }
        if let Some(key) = &rule.key {
            let latest = match &self.pending {
                Some(pending) => pending.key.as_ref(),
                None => self.sent.as_ref(),
            };
            if latest == Some(key) {
                return None;
            }
        }
        self.raise(rule.order);
        let data = match (rule.merge, self.pending.take()) {
            (Some(merge), Some(older)) => merge(older.data, data),
            _ => data,
        };
        if self.open(now) {
            self.mark(rule.key, now);
            return Some(data);
        }
        self.pending = Some(Pending {
            data,
            key: rule.key,
        });
        None
    }

    /// The pending value once the gap has passed, unless the receiver already holds it, with the
    /// key it was compared by.
    pub fn due(&mut self, now: Instant) -> Option<(Value, Option<Value>)> {
        if self.pending.is_none() || !self.open(now) {
            return None;
        }
        let pending = self.pending.take()?;
        if pending.key.is_some() && pending.key == self.sent {
            return None;
        }
        self.mark(pending.key.clone(), now);
        Some((pending.data, pending.key))
    }

    /// When the pending value may go out; None with nothing pending.
    pub fn next_due(&self) -> Option<Instant> {
        self.pending.as_ref()?;
        self.sent_at.map(|at| at + GAP)
    }

    /// Takes back a value the receiver could not take at `now`, to retry once the gap has passed. A
    /// newer pending value wins over it, or absorbs it on an edge topic.
    pub fn defer(&mut self, data: Value, rule: Rule, now: Instant) {
        self.sent = None;
        self.sent_at = Some(now);
        self.pending = Some(match (self.pending.take(), rule.merge) {
            (Some(newer), Some(merge)) => Pending {
                data: merge(data, newer.data),
                key: None,
            },
            (Some(newer), None) => newer,
            (None, _) => Pending {
                data,
                key: rule.key,
            },
        });
    }

    /// Whether counters are behind the highest the lane has seen.
    fn behind(&self, order: Option<Order>) -> bool {
        match (order, self.floor) {
            (Some(order), Some(floor)) => order[0] < floor[0] || order[1] < floor[1],
            _ => false,
        }
    }

    fn open(&self, now: Instant) -> bool {
        self.sent_at
            .is_none_or(|at| now.saturating_duration_since(at) >= GAP)
    }

    fn mark(&mut self, key: Option<Value>, now: Instant) {
        self.sent = key;
        self.sent_at = Some(now);
    }

    fn raise(&mut self, order: Option<Order>) {
        if let Some(order) = order {
            let floor = self.floor.unwrap_or_default();
            self.floor = Some([floor[0].max(order[0]), floor[1].max(order[1])]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    impl Lane {
        fn due_data(&mut self, now: Instant) -> Option<Value> {
            self.due(now).map(|(data, _)| data)
        }
    }

    fn state(lane: &mut Lane, value: i64, now: Instant) -> Option<Value> {
        lane.offer(json!(value), Rule::state(json!(value)), now)
    }

    fn sum(a: Value, b: Value) -> Value {
        json!(a.as_i64().unwrap() + b.as_i64().unwrap())
    }

    #[test]
    fn coalesce_leading_then_trailing_last_value_lands() {
        let t0 = Instant::now();
        let mut lane = Lane::default();
        // The leading edge goes out at once.
        assert_eq!(state(&mut lane, 1, t0), Some(json!(1)));
        // Inside the gap each value replaces the pending one.
        assert_eq!(state(&mut lane, 2, t0 + ms(50)), None);
        assert_eq!(state(&mut lane, 3, t0 + ms(100)), None);
        assert_eq!(lane.next_due(), Some(t0 + GAP));
        assert_eq!(lane.due_data(t0 + ms(249)), None);
        // The trailing edge carries the latest.
        assert_eq!(lane.due_data(t0 + GAP), Some(json!(3)));
        assert_eq!(lane.next_due(), None);
        assert_eq!(lane.due_data(t0 + ms(900)), None);
        // A quiet lane sends at once again.
        assert_eq!(state(&mut lane, 4, t0 + ms(900)), Some(json!(4)));

        // An edge topic merges inside the gap and the merge lands.
        let mut edge = Lane::default();
        let offer = |lane: &mut Lane, n: i64, at| lane.offer(json!(n), Rule::edge(sum), at);
        assert_eq!(offer(&mut edge, 1, t0), Some(json!(1)));
        assert_eq!(offer(&mut edge, 2, t0 + ms(10)), None);
        assert_eq!(offer(&mut edge, 3, t0 + ms(20)), None);
        assert_eq!(edge.due_data(t0 + GAP), Some(json!(5)));
        // An edge topic is never deduplicated.
        assert_eq!(offer(&mut edge, 1, t0 + ms(600)), Some(json!(1)));
        assert_eq!(offer(&mut edge, 1, t0 + ms(900)), Some(json!(1)));
    }

    #[test]
    fn coalesce_never_exceeds_four_per_second() {
        let t0 = Instant::now();
        let mut lane = Lane::default();
        let mut sent: Vec<(Duration, Value)> = Vec::new();
        let mut last = 0;
        for step in 0..300u64 {
            let at = t0 + ms(step * 10);
            last = step as i64 + 1;
            if let Some(value) = lane.due_data(at) {
                sent.push((at - t0, value));
            }
            if let Some(value) = state(&mut lane, last, at) {
                sent.push((at - t0, value));
            }
        }
        let end = t0 + ms(3000) + GAP;
        if let Some(value) = lane.due_data(end) {
            sent.push((end - t0, value));
        }
        for (start, _) in &sent {
            let window = sent
                .iter()
                .filter(|(at, _)| *at >= *start && *at < *start + ms(1000))
                .count();
            assert!(
                window <= 4,
                "{window} deliveries in a second from {start:?}"
            );
        }
        assert_eq!(sent.last().map(|(_, v)| v.clone()), Some(json!(last)));
    }

    #[test]
    fn identical_payloads_are_not_resent() {
        let t0 = Instant::now();
        let mut lane = Lane::default();
        assert_eq!(state(&mut lane, 1, t0), Some(json!(1)));
        assert_eq!(state(&mut lane, 1, t0 + ms(500)), None);
        // Back to the held value inside the gap: nothing goes out at its end.
        assert_eq!(state(&mut lane, 2, t0 + ms(600)), Some(json!(2)));
        assert_eq!(state(&mut lane, 3, t0 + ms(650)), None);
        assert_eq!(state(&mut lane, 2, t0 + ms(700)), None);
        assert_eq!(lane.due_data(t0 + ms(900)), None);
        // A seed counts as held.
        lane.seed(Rule::state(json!(9)));
        assert_eq!(state(&mut lane, 9, t0 + ms(2000)), None);
        assert_eq!(state(&mut lane, 8, t0 + ms(2000)), Some(json!(8)));
        // The key decides, not the payload.
        let mut keyed = Lane::default();
        let offer =
            |lane: &mut Lane, data: Value, at| lane.offer(data, Rule::state(json!("k")), at);
        assert_eq!(offer(&mut keyed, json!(1), t0), Some(json!(1)));
        assert_eq!(offer(&mut keyed, json!(2), t0 + ms(500)), None);
    }

    #[test]
    fn a_value_behind_the_counters_is_dropped() {
        let t0 = Instant::now();
        let ordered = |n: i64, order: Order| Rule {
            order: Some(order),
            ..Rule::state(json!(n))
        };
        let mut lane = Lane::default();
        // Seeded with a newer reading than the one offered next: the older never goes out.
        lane.seed(ordered(2, [3, 1]));
        assert_eq!(lane.offer(json!(1), ordered(1, [3, 0]), t0), None);
        assert_eq!(lane.offer(json!(1), ordered(1, [2, 5]), t0), None);
        assert_eq!(lane.offer(json!(3), ordered(3, [3, 1]), t0), Some(json!(3)));
        // Inside the gap an older value neither replaces the pending one nor goes out.
        assert_eq!(lane.offer(json!(4), ordered(4, [4, 1]), t0 + ms(10)), None);
        assert_eq!(lane.offer(json!(5), ordered(5, [3, 1]), t0 + ms(20)), None);
        assert_eq!(lane.due_data(t0 + GAP), Some(json!(4)));
        // A value with no counters is never held back by them.
        assert_eq!(
            lane.offer(json!(6), Rule::state(json!(6)), t0 + ms(600)),
            Some(json!(6))
        );
    }

    #[test]
    fn a_deferred_value_is_retried_and_a_newer_one_wins() {
        let t0 = Instant::now();
        let mut lane = Lane::default();
        let sent = state(&mut lane, 1, t0).unwrap();
        lane.defer(sent, Rule::state(json!(1)), t0);
        assert_eq!(lane.next_due(), Some(t0 + GAP));
        assert_eq!(lane.due_data(t0 + GAP), Some(json!(1)));

        let sent = state(&mut lane, 2, t0 + ms(600)).unwrap();
        assert_eq!(state(&mut lane, 3, t0 + ms(650)), None);
        lane.defer(sent, Rule::state(json!(2)), t0 + ms(600));
        assert_eq!(lane.due_data(t0 + ms(850)), Some(json!(3)));

        let mut edge = Lane::default();
        let sent = edge.offer(json!(1), Rule::edge(sum), t0).unwrap();
        assert_eq!(edge.offer(json!(2), Rule::edge(sum), t0 + ms(10)), None);
        edge.defer(sent, Rule::edge(sum), t0);
        assert_eq!(edge.due_data(t0 + GAP), Some(json!(3)));
    }

    #[test]
    fn a_deferred_value_always_has_a_due_time() {
        let t0 = Instant::now();
        // A lane that never sent: the retry still comes one gap after the failed attempt.
        let mut lane = Lane::default();
        lane.defer(json!(1), Rule::state(json!(1)), t0);
        assert_eq!(lane.next_due(), Some(t0 + GAP));
        assert_eq!(lane.due_data(t0 + ms(100)), None);
        assert_eq!(lane.due_data(t0 + GAP), Some(json!(1)));
    }
}
