/*
 * Delivery of an app event topic to a native plugin's child. The event hub names the plugin by id, so
 * the value goes to whichever run of that plugin is current and running when it is sent. Unlike a
 * stream event, a value the outbox has no room for is not dropped: the hub is told, keeps it and
 * sends the latest value at its next tick.
 *
 * Each run's event gate orders events against the answers to the child's `events.subscribe`. While a
 * subscribe is between its admission and its answer, every event is held back like a full outbox.
 * The answer records the subscribe's sequence mark under the gate in the same step that queues it, so
 * an event produced before the answer's seed (sequence at or under the mark) is dropped, and every
 * event queued after the answer was produced after the seed. A dropped event can be newer than the
 * answer, which is read before the seed; the refresh after the subscribe sends what differs. The
 * check and the queueing of an event happen under the gate too, so no answer can come between them.
 * A mark is recorded only when its answer was queued: a child that never got the answer keeps
 * hearing events under it.
 */

// -- Library Imports --
use std::sync::atomic::Ordering;
use std::sync::Arc;

use serde_json::Value;

// -- Local Imports --
use super::child::SendError;
use super::protocol::HostMessage;
use super::status::HostState;
use super::{lock, NativeHost, Run};
use crate::plugins::api::events::{ChildDelivery, MARK_FIELD};

/// A run's event subscribes in flight and the mark of the last one answered. A new run starts with
/// neither.
#[derive(Debug, Default)]
pub(super) struct EventGate {
    subscribing: u32,
    mark: u64,
}

impl NativeHost {
    /// Sends `topic` with `data`, produced as delivery `seq`, to plugin `id`'s child while it is in
    /// the running state.
    pub fn deliver_event(&self, id: &str, topic: &str, data: &Value, seq: u64) -> ChildDelivery {
        let Some((run, child)) = self.ready_run(id) else {
            return ChildDelivery::NotRunning;
        };
        if run.ending.load(Ordering::SeqCst) || self.board.host(id) != Some(HostState::Running) {
            return ChildDelivery::NotRunning;
        }
        let gate = lock(&run.event_gate);
        if gate.subscribing > 0 {
            return ChildDelivery::Full;
        }
        if seq <= gate.mark {
            return ChildDelivery::Stale;
        }
        let message = HostMessage::Event {
            topic: topic.to_string(),
            data: data.clone(),
        };
        // A value over the frame cap can never be sent, so it reads like a child that is gone.
        match child.send(&message) {
            Ok(()) => ChildDelivery::Sent,
            Err(SendError::Full) => ChildDelivery::Full,
            Err(SendError::Closed | SendError::TooLarge) => ChildDelivery::NotRunning,
        }
    }
}

/// One event subscribe of a run between its admission and its answer. While any is open the run's
/// events are held back.
pub(super) struct Subscribing(Option<Arc<Run>>);

impl Subscribing {
    pub(super) fn begin(run: &Arc<Run>) -> Subscribing {
        lock(&run.event_gate).subscribing += 1;
        Subscribing(Some(run.clone()))
    }

    /// Takes the mark out of a subscribe's result, then, under the gate, runs `send`, which queues
    /// the answer and says whether it was queued, records the mark if it was, and ends the hold. The
    /// child never sees the mark. Returns the mark the subscribe set, if any.
    pub(super) fn answer<T>(
        mut self,
        mut result: Result<Value, T>,
        send: impl FnOnce(Result<Value, T>) -> bool,
    ) -> Option<u64> {
        let mark = match &mut result {
            Ok(Value::Object(fields)) => fields.remove(MARK_FIELD).and_then(|m| m.as_u64()),
            _ => None,
        };
        let run = self.0.take()?;
        let mut gate = lock(&run.event_gate);
        let queued = send(result);
        if let (true, Some(mark)) = (queued, mark) {
            gate.mark = gate.mark.max(mark);
        }
        gate.subscribing -= 1;
        mark
    }
}

impl Drop for Subscribing {
    fn drop(&mut self) {
        if let Some(run) = self.0.take() {
            lock(&run.event_gate).subscribing -= 1;
        }
    }
}

#[cfg(test)]
impl Run {
    /// The subscribes in flight and the last mark, for tests.
    pub(super) fn event_gate_state(&self) -> (u32, u64) {
        let gate = lock(&self.event_gate);
        (gate.subscribing, gate.mark)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_mark_is_recorded_only_when_its_answer_was_queued() {
        let run = Arc::new(Run::new());
        let answered = || Ok::<Value, ()>(json!({ "topics": [], "mark": 9 }));
        let hold = Subscribing::begin(&run);
        assert_eq!(run.event_gate_state(), (1, 0));
        // The outbox had no room for the answer: the hold ends, the mark is not recorded.
        let mark = hold.answer(answered(), |result| {
            assert!(result.unwrap().get(MARK_FIELD).is_none());
            false
        });
        assert_eq!(mark, Some(9));
        assert_eq!(run.event_gate_state(), (0, 0));
        // Queued, it is.
        let hold = Subscribing::begin(&run);
        hold.answer(answered(), |_| true);
        assert_eq!(run.event_gate_state(), (0, 9));
        // A refusal carries no mark and leaves the last one.
        let hold = Subscribing::begin(&run);
        assert_eq!(hold.answer(Err::<Value, ()>(()), |_| true), None);
        assert_eq!(run.event_gate_state(), (0, 9));
    }
}
