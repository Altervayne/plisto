/*
 * Who listens to which topic: per plugin, the topics its frames subscribed to and the ones its child
 * did, each with its delivery lane. The mask of every subscribed topic is mirrored in an atomic, so
 * an app event nobody listens to costs its listener one load and nothing else. The queue's revision
 * lives here too: it counts every `player:queue_state` while anyone listens to `queue`, and moves once
 * when the last listener leaves, so a value read after a quiet stretch never equals one read before it.
 *
 * Every delivery carries a sequence number and every subscribe leaves a mark on its side, both from
 * one counter that never goes back. The answer to a subscribe reaches its receiver on a channel not
 * ordered with the events, or after events already queued, so the receiver drops an event under the
 * mark: it was produced before the answer's seed. It can still be newer than the answer, which is
 * read before the seed; the refresh that follows every subscribe reads again and sends what differs.
 */

// -- Library Imports --
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use crossbeam_channel::Sender;
use serde_json::{json, Value};

// -- Local Imports --
use super::coalesce::{Lane, Rule};
use super::compose::{key, merge_library, order};
use super::{Input, Topic};
use crate::plugins::api::state::lock;
use crate::plugins::api::Caller;

/// Which receiver of a plugin a subscription belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Side {
    Frame,
    Child,
}

impl From<Caller> for Side {
    fn from(caller: Caller) -> Side {
        match caller {
            Caller::Frame => Side::Frame,
            Caller::Child => Side::Child,
        }
    }
}

/// A value leaving a lane for one receiver.
#[derive(Clone, Debug, PartialEq)]
pub struct Delivery {
    pub id: String,
    pub side: Side,
    pub topic: Topic,
    pub data: Value,
    /// What the lane compared the value by, kept for a retry.
    pub key: Option<Value>,
    /// Its place among every delivery and every mark, strictly increasing process-wide.
    pub seq: u64,
}

#[derive(Default)]
struct PluginSubs {
    frame: BTreeMap<Topic, Lane>,
    child: BTreeMap<Topic, Lane>,
    // The sequence mark of each side's last subscribe: what was produced at or under it is
    // superseded by that subscribe's answer.
    frame_mark: u64,
    child_mark: u64,
}

impl PluginSubs {
    fn side(&mut self, side: Side) -> &mut BTreeMap<Topic, Lane> {
        match side {
            Side::Frame => &mut self.frame,
            Side::Child => &mut self.child,
        }
    }

    fn mark(&mut self, side: Side) -> &mut u64 {
        match side {
            Side::Frame => &mut self.frame_mark,
            Side::Child => &mut self.child_mark,
        }
    }

    fn sides(&mut self) -> [(Side, &mut BTreeMap<Topic, Lane>); 2] {
        [
            (Side::Frame, &mut self.frame),
            (Side::Child, &mut self.child),
        ]
    }

    fn is_empty(&self) -> bool {
        self.frame.is_empty() && self.child.is_empty()
    }
}

/// How a topic's values are compared, ordered and folded. A `now_playing` value is compared together
/// with `item`, the seated item it describes, which its payload does not always name: two items in a
/// row with equal payloads, such as two opened files, still differ.
fn rule(topic: Topic, data: &Value, item: Option<i64>) -> Rule {
    if !topic.is_state() {
        return Rule::edge(merge_library);
    }
    let compared = key(topic, data);
    let compared = match topic {
        Topic::NowPlaying => json!([compared, item]),
        _ => compared,
    };
    Rule {
        order: order(topic, data),
        ..Rule::state(compared)
    }
}

#[derive(Default)]
pub struct EventSubs {
    plugins: Mutex<HashMap<String, PluginSubs>>,
    // The last sequence number given to a delivery. Never reset; read and advanced only under the
    // `plugins` lock, so a mark and every delivery are ordered by it.
    seq: AtomicU64,
    mask: AtomicU8,
    queue_rev: AtomicU64,
    feed: OnceLock<Sender<Input>>,
}

impl EventSubs {
    /// Connects the hub's input. Until then every input is dropped.
    pub fn attach(&self, feed: Sender<Input>) {
        let _ = self.feed.set(feed);
    }

    /// Hands `input` to the hub when anyone listens to a topic it can change; otherwise returns
    /// after one atomic load.
    pub fn feed(&self, input: Input) {
        if self.mask.load(Ordering::Acquire) & input.bits() == 0 {
            return;
        }
        if let Some(feed) = self.feed.get() {
            let _ = feed.send(input);
        }
    }

    /// The bits of every subscribed topic.
    pub fn mask(&self) -> u8 {
        self.mask.load(Ordering::Acquire)
    }

    pub fn queue_rev(&self) -> u64 {
        self.queue_rev.load(Ordering::Acquire)
    }

    /// Counts one change of the queue's contents or order.
    pub fn bump_queue_rev(&self) -> u64 {
        self.queue_rev.fetch_add(1, Ordering::AcqRel) + 1
    }

    /// `replace_seated` with no seated item.
    pub fn replace(
        &self,
        id: &str,
        side: Side,
        topics: &BTreeSet<Topic>,
        current: &[(Topic, Value)],
    ) -> u64 {
        self.replace_seated(id, side, topics, current, None)
    }

    /// Replaces one side's topics. A kept topic keeps its lane; `current`, what the caller was
    /// answered with `item` the seated item it was read with, seeds the lanes of state topics. A
    /// state topic left out of `current`, its read having failed, forgets what it sent, so its next
    /// value goes out whatever it was before.
    ///
    /// Returns the side's new mark, a sequence number of its own: every delivery numbered under it
    /// was produced before the seed and its receiver drops it.
    pub fn replace_seated(
        &self,
        id: &str,
        side: Side,
        topics: &BTreeSet<Topic>,
        current: &[(Topic, Value)],
        item: Option<i64>,
    ) -> u64 {
        let mut plugins = lock(&self.plugins);
        let mark = self.next_seq();
        let subs = plugins.entry(id.to_string()).or_default();
        *subs.mark(side) = mark;
        let lanes = subs.side(side);
        lanes.retain(|topic, _| topics.contains(topic));
        for &topic in topics {
            lanes.entry(topic).or_default();
        }
        for (&topic, lane) in lanes.iter_mut() {
            match current.iter().find(|(answered, _)| *answered == topic) {
                Some((_, value)) => lane.seed(rule(topic, value, item)),
                None if topic.is_state() => lane.forget_sent(),
                None => {}
            }
        }
        if subs.is_empty() {
            plugins.remove(id);
        }
        self.refresh_mask(&plugins);
        mark
    }

    /// The next sequence number. Called only with the `plugins` lock held.
    fn next_seq(&self) -> u64 {
        self.seq.fetch_add(1, Ordering::AcqRel) + 1
    }

    /// Drops one side of plugin `id`.
    pub fn drop_side(&self, id: &str, side: Side) {
        let mut plugins = lock(&self.plugins);
        if let Some(subs) = plugins.get_mut(id) {
            subs.side(side).clear();
            if subs.is_empty() {
                plugins.remove(id);
            }
        }
        self.refresh_mask(&plugins);
    }

    /// Drops one topic of one side, as a lost grant does.
    pub fn drop_topic(&self, id: &str, side: Side, topic: Topic) {
        let mut plugins = lock(&self.plugins);
        if let Some(subs) = plugins.get_mut(id) {
            subs.side(side).remove(&topic);
            if subs.is_empty() {
                plugins.remove(id);
            }
        }
        self.refresh_mask(&plugins);
    }

    /// Drops both sides of plugin `id`.
    pub fn forget(&self, id: &str) {
        let mut plugins = lock(&self.plugins);
        plugins.remove(id);
        self.refresh_mask(&plugins);
    }

    fn refresh_mask(&self, plugins: &HashMap<String, PluginSubs>) {
        let mask = plugins
            .values()
            .flat_map(|subs| subs.frame.keys().chain(subs.child.keys()))
            .fold(0, |mask, topic| mask | topic.bit());
        let queue = Topic::Queue.bit();
        let was = self.mask.swap(mask, Ordering::AcqRel);
        if was & queue != 0 && mask & queue == 0 {
            self.queue_rev.fetch_add(1, Ordering::AcqRel);
        }
    }

    /// `offer_seated` with no seated item.
    pub fn offer(
        &self,
        topic: Topic,
        now: Instant,
        value_for: &dyn Fn(&str) -> Value,
    ) -> Vec<Delivery> {
        self.offer_seated(topic, now, None, value_for)
    }

    /// Offers a new value of `topic` to every lane of it; `value_for` gives the payload for a plugin
    /// and `item` is the seated item it was composed with. Returns what goes out now.
    pub fn offer_seated(
        &self,
        topic: Topic,
        now: Instant,
        item: Option<i64>,
        value_for: &dyn Fn(&str) -> Value,
    ) -> Vec<Delivery> {
        let mut out = Vec::new();
        for (id, subs) in lock(&self.plugins).iter_mut() {
            for (side, lanes) in subs.sides() {
                let Some(lane) = lanes.get_mut(&topic) else {
                    continue;
                };
                let data = value_for(id);
                let rule = rule(topic, &data, item);
                let key = rule.key.clone();
                if let Some(data) = lane.offer(data, rule, now) {
                    out.push(Delivery {
                        id: id.clone(),
                        side,
                        topic,
                        data,
                        key,
                        seq: self.next_seq(),
                    });
                }
            }
        }
        out
    }

    /// Every pending value whose gap has passed.
    pub fn due(&self, now: Instant) -> Vec<Delivery> {
        let mut out = Vec::new();
        for (id, subs) in lock(&self.plugins).iter_mut() {
            for (side, lanes) in subs.sides() {
                for (&topic, lane) in lanes.iter_mut() {
                    if let Some((data, key)) = lane.due(now) {
                        out.push(Delivery {
                            id: id.clone(),
                            side,
                            topic,
                            data,
                            key,
                            seq: self.next_seq(),
                        });
                    }
                }
            }
        }
        out
    }

    /// The earliest time a pending value may go out.
    pub fn next_due(&self) -> Option<Instant> {
        lock(&self.plugins)
            .values()
            .flat_map(|subs| subs.frame.values().chain(subs.child.values()))
            .filter_map(Lane::next_due)
            .min()
    }

    /// Takes back a delivery its receiver could not take at `now`; it is retried once its gap has
    /// passed, with a new sequence number. One at or under its side's mark is superseded by that
    /// subscribe's answer and is dropped.
    pub fn defer(&self, delivery: Delivery, now: Instant) {
        let mut plugins = lock(&self.plugins);
        let Some(subs) = plugins.get_mut(&delivery.id) else {
            return;
        };
        if delivery.seq <= *subs.mark(delivery.side) {
            return;
        }
        if let Some(lane) = subs.side(delivery.side).get_mut(&delivery.topic) {
            let rule = Rule {
                key: delivery.key,
                ..rule(delivery.topic, &delivery.data, None)
            };
            lane.defer(delivery.data, rule, now);
        }
    }

    /// The topics of one side, in topic order.
    pub fn topics_of(&self, id: &str, side: Side) -> Vec<Topic> {
        lock(&self.plugins)
            .get_mut(id)
            .map(|subs| subs.side(side).keys().copied().collect())
            .unwrap_or_default()
    }

    /// The mark of one side; 0 for a plugin with no subscription.
    pub fn mark_of(&self, id: &str, side: Side) -> u64 {
        lock(&self.plugins)
            .get_mut(id)
            .map_or(0, |subs| *subs.mark(side))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::api::state::ApiState;
    use serde_json::json;

    const A: &str = "com.example.a";
    const B: &str = "com.example.b";

    fn set(topics: &[Topic]) -> BTreeSet<Topic> {
        topics.iter().copied().collect()
    }

    #[test]
    fn forget_clears_both_sides_and_forget_run_the_child_side() {
        let api = ApiState::default();
        let events = api.events();
        events.replace(A, Side::Frame, &set(&[Topic::Theme, Topic::Queue]), &[]);
        events.replace(A, Side::Child, &set(&[Topic::Locale]), &[]);
        events.replace(B, Side::Frame, &set(&[Topic::AppMode]), &[]);

        api.forget_run(A);
        assert_eq!(
            events.topics_of(A, Side::Frame),
            [Topic::Queue, Topic::Theme]
        );
        assert!(events.topics_of(A, Side::Child).is_empty());
        assert_eq!(events.mask() & Topic::Locale.bit(), 0);

        events.replace(A, Side::Child, &set(&[Topic::Locale]), &[]);
        api.forget(A);
        assert!(events.topics_of(A, Side::Frame).is_empty());
        assert!(events.topics_of(A, Side::Child).is_empty());
        assert_eq!(events.topics_of(B, Side::Frame), [Topic::AppMode]);
        assert_eq!(events.mask(), Topic::AppMode.bit());
        api.forget(B);
        assert_eq!(events.mask(), 0);
    }

    #[test]
    fn idle_hub_reads_nothing() {
        let events = EventSubs::default();
        let (tx, rx) = crossbeam_channel::unbounded();
        events.attach(tx);
        let inputs = || {
            [
                Input::Status,
                Input::Queue,
                Input::Stream,
                Input::Ambient,
                Input::Library(Default::default()),
                Input::Refresh(u8::MAX),
            ]
        };
        for input in inputs() {
            events.feed(input);
        }
        assert!(rx.try_iter().next().is_none());
        // A subscription lets through only the inputs that can change its topics.
        events.replace(A, Side::Frame, &set(&[Topic::Theme]), &[]);
        for input in inputs() {
            events.feed(input);
        }
        let passed: Vec<Input> = rx.try_iter().collect();
        assert!(
            matches!(passed[..], [Input::Ambient, Input::Refresh(_)]),
            "{passed:?}"
        );
    }

    #[test]
    fn the_queue_rev_moves_when_the_last_listener_leaves() {
        let events = EventSubs::default();
        assert_eq!(events.queue_rev(), 0);
        events.replace(A, Side::Frame, &set(&[Topic::Queue]), &[]);
        events.replace(B, Side::Frame, &set(&[Topic::Queue]), &[]);
        assert_eq!(events.bump_queue_rev(), 1);
        events.forget(A);
        assert_eq!(events.queue_rev(), 1);
        events.forget(B);
        assert_eq!(events.queue_rev(), 2);
    }

    #[test]
    fn a_kept_topic_keeps_its_lane_and_a_seed_holds_the_answer() {
        let events = EventSubs::default();
        let t0 = Instant::now();
        let theme = |name: &str| json!({ "theme": name });
        events.replace(
            A,
            Side::Frame,
            &set(&[Topic::Theme]),
            &[(Topic::Theme, theme("dark"))],
        );
        assert!(events
            .offer(Topic::Theme, t0, &|_| theme("dark"))
            .is_empty());
        let sent = events.offer(Topic::Theme, t0, &|_| theme("light"));
        assert_eq!(sent.len(), 1);
        assert_eq!((sent[0].side, sent[0].topic), (Side::Frame, Topic::Theme));
        // Within the gap the change waits. A replace that keeps the topic but answered no value for
        // it drops the wait and what was sent; the lane keeps its pace, and the next value lands.
        assert!(events
            .offer(Topic::Theme, t0, &|_| theme("dark"))
            .is_empty());
        events.replace(A, Side::Frame, &set(&[Topic::Theme, Topic::Locale]), &[]);
        assert_eq!(events.next_due(), None);
        let gap = super::super::coalesce::GAP;
        assert!(events.offer(Topic::Theme, t0 + gap / 2, &|_| theme("light")).is_empty());
        let due = events.due(t0 + gap);
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].data, theme("light"));
        // Only a subscribed topic is offered.
        assert_eq!(events.offer(Topic::Locale, t0, &|_| json!(1)).len(), 1);
        assert!(events.offer(Topic::Queue, t0, &|_| json!(1)).is_empty());
    }
}
