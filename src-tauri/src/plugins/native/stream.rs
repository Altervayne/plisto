/*
 * Delivery of the seated playback stream's events to a native owner's child. The hub names the owner
 * by plugin id, so the event goes to whichever run of that plugin is current and ready when it is
 * sent; a child that was replaced, is still starting or is ending hears nothing. A full outbox drops
 * the event and counts it, so the hub never waits on a child.
 */

// -- Library Imports --
use std::sync::atomic::Ordering;

// -- Local Imports --
use super::protocol::HostMessage;
use super::pump::bump;
use super::{lock, NativeHost};
use crate::plugins::api::stream::StreamEvent;
use crate::plugins::manifest::Tier;

impl NativeHost {
    /// Sends `event` to plugin `id`'s child when the plugin is a serving native one with a current,
    /// ready child. The owner's page frame gets the event separately.
    pub fn deliver_stream(&self, id: &str, event: &StreamEvent) {
        let native = self
            .with_plugins(|plugins| {
                plugins
                    .enabled_set()
                    .serving(id)
                    .is_some_and(|serving| serving.tier == Tier::Native)
            })
            .unwrap_or(false);
        if !native {
            return;
        }
        let Ok(event) = serde_json::to_value(event) else {
            return;
        };
        let children = lock(&self.children);
        let Some(run) = children.get(id) else {
            return;
        };
        let ready = lock(&run.heartbeat).is_some();
        let Some(child) = run.child.get().filter(|_| ready && !run.ending.load(Ordering::SeqCst))
        else {
            return;
        };
        if child.send(&HostMessage::Stream { event }).is_err() {
            bump(&run.stats.stream_dropped);
        }
    }
}
