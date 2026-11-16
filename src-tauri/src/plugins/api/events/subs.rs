/*
 * Who listens to which topic: per plugin, the topics its frames subscribed to and the ones its child
 * did, each with its delivery lane. The mask of every subscribed topic is mirrored in an atomic, so
 * an app event nobody listens to costs its listener one load and nothing else. The queue's revision
 * lives here too: it counts every `player:queue` while anyone listens to `queue`, and moves once when
 * the last listener leaves, so a value read after a quiet stretch never equals one read before it.
 */

// -- Library Imports --
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use crossbeam_channel::Sender;
use serde_json::Value;

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
}

#[derive(Default)]
struct PluginSubs {
    frame: BTreeMap<Topic, Lane>,
    child: BTreeMap<Topic, Lane>,
}

impl PluginSubs {
    fn side(&mut self, side: Side) -> &mut BTreeMap<Topic, Lane> {
        match side {
            Side::Frame => &mut self.frame,
            Side::Child => &mut self.child,
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

/// How a topic's values are compared, ordered and folded.
fn rule(topic: Topic, data: &Value) -> Rule {
    if topic.is_state() {
        Rule {
            order: order(topic, data),
            ..Rule::state(key(topic, data))
        }
    } else {
        Rule::edge(merge_library)
    }
}

#[derive(Default)]
pub struct EventSubs {
    plugins: Mutex<HashMap<String, PluginSubs>>,
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

    /// Replaces one side's topics. A kept topic keeps its lane; `current` seeds the lanes of state
    /// topics with what the caller was answered.
    pub fn replace(
        &self,
        id: &str,
        side: Side,
        topics: &BTreeSet<Topic>,
        current: &[(Topic, Value)],
    ) {
        let mut plugins = lock(&self.plugins);
        let subs = plugins.entry(id.to_string()).or_default();
        let lanes = subs.side(side);
        lanes.retain(|topic, _| topics.contains(topic));
        for &topic in topics {
            lanes.entry(topic).or_default();
        }
        for (topic, value) in current {
            if let Some(lane) = lanes.get_mut(topic) {
                lane.seed(rule(*topic, value));
            }
        }
        if subs.is_empty() {
            plugins.remove(id);
        }
        self.refresh_mask(&plugins);
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

    /// Offers a new value of `topic` to every lane of it; `value_for` gives the payload for a plugin.
    /// Returns what goes out now.
    pub fn offer(
        &self,
        topic: Topic,
        now: Instant,
        value_for: &dyn Fn(&str) -> Value,
    ) -> Vec<Delivery> {
        let mut out = Vec::new();
        for (id, subs) in lock(&self.plugins).iter_mut() {
            for (side, lanes) in subs.sides() {
                let Some(lane) = lanes.get_mut(&topic) else {
                    continue;
                };
                let data = value_for(id);
                let rule = rule(topic, &data);
                if let Some(data) = lane.offer(data, rule, now) {
                    out.push(Delivery {
                        id: id.clone(),
                        side,
                        topic,
                        data,
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
                    if let Some(data) = lane.due(now) {
                        out.push(Delivery {
                            id: id.clone(),
                            side,
                            topic,
                            data,
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
    /// passed.
    pub fn defer(&self, delivery: Delivery, now: Instant) {
        let mut plugins = lock(&self.plugins);
        let lane = plugins
            .get_mut(&delivery.id)
            .and_then(|subs| subs.side(delivery.side).get_mut(&delivery.topic));
        if let Some(lane) = lane {
            let rule = rule(delivery.topic, &delivery.data);
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
        // Within the gap the change waits; replacing the set with the topic kept keeps it waiting.
        assert!(events
            .offer(Topic::Theme, t0, &|_| theme("dark"))
            .is_empty());
        events.replace(A, Side::Frame, &set(&[Topic::Theme, Topic::Locale]), &[]);
        assert_eq!(events.next_due(), Some(t0 + super::super::coalesce::GAP));
        let due = events.due(t0 + super::super::coalesce::GAP);
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].data, theme("dark"));
        // Only a subscribed topic is offered.
        assert_eq!(events.offer(Topic::Locale, t0, &|_| json!(1)).len(), 1);
        assert!(events.offer(Topic::Queue, t0, &|_| json!(1)).is_empty());
    }
}
