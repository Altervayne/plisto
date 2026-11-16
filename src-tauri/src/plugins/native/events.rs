/*
 * Delivery of an app event topic to a native plugin's child. The event hub names the plugin by id, so
 * the value goes to whichever run of that plugin is current and running when it is sent. Unlike a
 * stream event, a value the outbox has no room for is not dropped: the hub is told, keeps it and
 * sends the latest value at its next tick.
 */

// -- Library Imports --
use std::sync::atomic::Ordering;

use serde_json::Value;

// -- Local Imports --
use super::child::SendError;
use super::protocol::HostMessage;
use super::status::HostState;
use super::NativeHost;
use crate::plugins::api::events::ChildDelivery;

impl NativeHost {
    /// Sends `topic` with `data` to plugin `id`'s child while it is in the running state.
    pub fn deliver_event(&self, id: &str, topic: &str, data: &Value) -> ChildDelivery {
        let Some((run, child)) = self.ready_run(id) else {
            return ChildDelivery::NotRunning;
        };
        if run.ending.load(Ordering::SeqCst) || self.board.host(id) != Some(HostState::Running) {
            return ChildDelivery::NotRunning;
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
