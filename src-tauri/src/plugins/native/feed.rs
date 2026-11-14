/*
 * Playback feed delivery to a native plugin. A plugin granted `audio.tap` or `audio.events` gets a feed
 * consumer before its launch, so the tap name is on its argv, and loses it before its process is
 * killed, so the tap turns off with its last reader. After `ready` one thread per run drains the
 * consumer: with `audio.events` it forwards each snapshot as a `feed` frame, otherwise it discards it.
 * The engine only `try_send`s into the consumer and this thread only `try_send`s into the child's
 * outbox, so neither the engine nor the child ever waits on the other.
 */

// -- Library Imports --
use std::sync::{Arc, Mutex, Weak};
use std::thread;
use std::time::Duration;

use crossbeam_channel::{Receiver, RecvTimeoutError};

// -- Local Imports --
use super::child::{Child, SendError};
use super::link::HostLink;
use super::lock;
use super::protocol::HostMessage;
use crate::audio::{FeedConsumer, FeedEvent, PlayerCmd};
use crate::plugins::manifest::Capability;

// How long one wait for a snapshot lasts before the forwarder checks whether its run ended.
const WAIT: Duration = Duration::from_millis(250);

/// What a plugin's grant asks of the feed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct FeedGrant {
    pub tap: bool,
    pub events: bool,
    /// The device name and id are sent only with this.
    pub device: bool,
}

impl FeedGrant {
    pub fn of(granted: &[Capability]) -> FeedGrant {
        FeedGrant {
            tap: granted.contains(&Capability::AudioTap),
            events: granted.contains(&Capability::AudioEvents),
            device: granted.contains(&Capability::AudioDevice),
        }
    }

    fn wanted(self) -> bool {
        self.tap || self.events
    }
}

#[derive(Default)]
struct SlotState {
    consumer: Option<u64>,
    // The consumer's receiving side, until the forwarder takes it.
    waiting: Option<Receiver<FeedEvent>>,
    grant: FeedGrant,
}

/// A run's feed consumer, from its attach to its one detach.
#[derive(Default)]
pub(super) struct FeedSlot(Mutex<SlotState>);

impl FeedSlot {
    /// Attaches a consumer when the grant asks for one, and returns the tap name. An attach error is
    /// logged and leaves the plugin without a feed.
    pub fn attach(&self, link: &dyn HostLink, id: &str, grant: FeedGrant) -> Option<String> {
        if !grant.wanted() {
            return None;
        }
        match link.attach_feed(grant.tap) {
            Ok(FeedConsumer {
                id: consumer,
                tap_name,
                events,
                ..
            }) => {
                *lock(&self.0) = SlotState {
                    consumer: Some(consumer),
                    waiting: Some(events),
                    grant,
                };
                tap_name
            }
            Err(e) => {
                eprintln!("plugins: {id}: started without the audio feed: {e}");
                None
            }
        }
    }

    /// Detaches the consumer. Only the first call does anything.
    pub fn detach(&self, link: &dyn HostLink) {
        let consumer = {
            let mut state = lock(&self.0);
            state.waiting = None;
            state.consumer.take()
        };
        if let Some(consumer) = consumer {
            link.detach_feed(consumer);
        }
    }

    fn is_detached(&self) -> bool {
        lock(&self.0).consumer.is_none()
    }
}

/// Starts the run's forwarder once the child is ready and, with `audio.events`, asks the engine for a
/// snapshot so the plugin learns the current state without waiting for a change. Nothing happens when
/// the run has no consumer or it was already detached.
pub(super) fn forward(slot: &Arc<FeedSlot>, link: &dyn HostLink, id: &str, child: &Arc<Child>) {
    let (waiting, grant) = {
        let mut state = lock(&slot.0);
        (state.waiting.take(), state.grant)
    };
    let Some(waiting) = waiting else {
        return;
    };
    let owned = slot.clone();
    // Weak, so a run that ended does not keep its child's pipes alive through this thread.
    let child = Arc::downgrade(child);
    let spawned = thread::Builder::new()
        .name(format!("plugin-feed-{id}"))
        .spawn(move || run(&owned, &waiting, &child, grant));
    match spawned {
        Ok(_) if grant.events => link.player(PlayerCmd::FeedSnapshot),
        Ok(_) => {}
        Err(e) => {
            eprintln!("plugins: {id}: started without the audio feed: {e}");
            slot.detach(link);
        }
    }
}

fn run(slot: &FeedSlot, events: &Receiver<FeedEvent>, child: &Weak<Child>, grant: FeedGrant) {
    let mut lost = Lost::default();
    loop {
        let received = events.recv_timeout(WAIT);
        if slot.is_detached() {
            return;
        }
        let event = match received {
            Ok(event) => event,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => return,
        };
        if !grant.events {
            continue;
        }
        let Some(child) = child.upgrade() else {
            return;
        };
        let seq = event.seq;
        let Some(frame) = frame(event, grant.device, lost.before(seq)) else {
            continue;
        };
        match child.send(&frame) {
            Ok(()) => lost.sent(seq),
            Err(SendError::Full | SendError::TooLarge) => {}
            Err(SendError::Closed) => return,
        }
    }
}

/// The `feed` frame for `event`. Without `audio.device` the device name and id are null: a device
/// name often carries a person's name.
fn frame(mut event: FeedEvent, device: bool, lost: u64) -> Option<HostMessage> {
    if !device {
        event.state.device = None;
        event.state.device_id = None;
    }
    let event = serde_json::to_value(&event).ok()?;
    Some(HostMessage::Feed { event, lost })
}

/// What a child missed since its last `feed`, from the seq gap. Every snapshot goes to every attached
/// consumer, so a gap is exactly the snapshots the channel dropped plus the frames the outbox refused.
/// Nothing before the first event taken counts: the channel drops only when full, so it never drops
/// a snapshot older than one it still holds.
#[derive(Debug, Default)]
struct Lost {
    last_sent: Option<u64>,
}

impl Lost {
    /// The count for a frame carrying `seq`. The first event taken sets the starting point.
    fn before(&mut self, seq: u64) -> u64 {
        let last = *self.last_sent.get_or_insert(seq.saturating_sub(1));
        seq.saturating_sub(last + 1)
    }

    fn sent(&mut self, seq: u64) {
        self.last_sent = Some(seq);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::{FeedCause, FeedState, Transport};

    fn event() -> FeedEvent {
        FeedEvent {
            seq: 4,
            cause: FeedCause::Device,
            tap_epoch: 1,
            tap_cursor: 10,
            state: FeedState {
                transport: Transport::Playing,
                sample_rate: 48_000,
                channels: 2,
                position_secs: 1.5,
                volume: 0.8,
                device: Some("John's AirPods".into()),
                device_id: Some("{0.0.0.00000000}.{airpods}".into()),
                latency_ms: 10.0,
            },
        }
    }

    #[test]
    fn device_fields_are_null_without_audio_device() {
        let Some(HostMessage::Feed { event: json, lost }) = frame(event(), false, 2) else {
            panic!("no frame");
        };
        assert_eq!(lost, 2);
        assert!(json["device"].is_null());
        assert!(json["device_id"].is_null());
        assert_eq!(json["latency_ms"], 10.0);
        assert_eq!(json["cause"], "device");
        assert_eq!(json["seq"], 4);

        let Some(HostMessage::Feed { event: json, .. }) = frame(event(), true, 0) else {
            panic!("no frame");
        };
        assert_eq!(json["device"], "John's AirPods");
        assert_eq!(json["device_id"], "{0.0.0.00000000}.{airpods}");
    }

    #[test]
    fn a_channel_drop_shows_on_the_frame_after_the_gap() {
        let hub = crate::audio::FeedHub::new();
        let consumer = hub.attach(false).expect("attaches");
        // A full channel during the handshake: 64 queued, the next 6 dropped.
        for _ in 0..crate::audio::feed::FEED_CAPACITY + 6 {
            hub.publish(FeedCause::Volume, event().state);
        }
        let mut lost = Lost::default();
        let mut carried = Vec::new();
        for event in consumer.events.try_iter() {
            carried.push(lost.before(event.seq));
            lost.sent(event.seq);
        }
        hub.publish(FeedCause::Volume, event().state);
        let next = consumer.events.try_recv().expect("queued");
        assert!(carried.iter().all(|n| *n == 0), "{carried:?}");
        assert_eq!(lost.before(next.seq), 6);
        hub.detach(consumer.id);
    }

    #[test]
    fn a_refused_frame_counts_on_the_next_frame_sent() {
        let mut lost = Lost::default();
        // The first event taken starts the count, whatever its seq.
        assert_eq!(lost.before(40), 0);
        // 40 refused by a full outbox, 41 sent.
        assert_eq!(lost.before(41), 1);
        lost.sent(41);
        assert_eq!(lost.before(42), 0);
        lost.sent(42);
        // 43 and 44 dropped by the channel, 45 refused, 46 sent.
        assert_eq!(lost.before(46), 3);
    }

    #[test]
    fn the_grant_names_what_the_feed_carries() {
        let none = FeedGrant::of(&[Capability::Background]);
        assert!(!none.wanted());
        let tap = FeedGrant::of(&[Capability::AudioTap]);
        assert!(tap.wanted() && tap.tap && !tap.events);
        let events = FeedGrant::of(&[Capability::AudioEvents, Capability::AudioDevice]);
        assert!(events.wanted() && !events.tap && events.events && events.device);
    }
}
