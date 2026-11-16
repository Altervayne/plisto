/*
 * What happens to the seated item without a call: the engine's signals, the decoder's end, the
 * item's limits and its artwork. One thread, `plisto-stream`, takes the engine's signals and runs the
 * limits between them; it holds the hub only weakly, so it ends with the hub.
 *
 * The limits are the hub's own clocks, kept apart from the decode helper's: a helper whose reads are
 * paced by bytes that keep arriving can stay busy without ever yielding audio, and neither of its
 * clocks then runs. An item with no decoded audio `NO_AUDIO_MS` after its start ends `no_audio`; one
 * that waits for more audio for `STALL_MS`, in buffering or still connecting after its first audio,
 * ends `stalled`. A paused item never waits, and a pending seek restarts the clock, since a seek
 * ahead of the bytes waits for them. Neither clock runs while a fetched item reconnects.
 */

// -- Library Imports --
use std::io;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use crossbeam_channel::RecvTimeoutError;

// -- Local Imports --
use super::hub::{Feed, Item, StreamHub, Teller};
use super::link::StreamLink;
use super::{NowState, StreamEvent, DECODER, FORMAT};
use crate::audio::stream::{DecodeEnd, Fault, Unsupported, LIVE_RING, NO_AUDIO_MS, STALL_MS};
use crate::audio::{PlayerCmd, StreamEndReason, StreamSignal};
use crate::plugins::api::net::CLOSED;

/// How often the limits are checked.
const TICK: Duration = Duration::from_millis(200);
/// The longest length a stream item may show: seven days.
pub const DURATION_MAX_SECS: f64 = 7.0 * 24.0 * 3_600.0;
/// How long a plugin can read its previous item's end.
pub(super) const LAST_END_HOLD: Duration = Duration::from_secs(60);

/// Starts the thread that follows the engine's signals and the limits.
pub fn spawn_watch(hub: &StreamHub) -> io::Result<()> {
    let weak = Arc::downgrade(&hub.0);
    let signals = hub.0.signals.1.clone();
    thread::Builder::new()
        .name("plisto-stream".into())
        .spawn(move || {
            let mut ticked = Instant::now();
            loop {
                let signal = signals.recv_timeout(TICK);
                let Some(shared) = weak.upgrade() else {
                    return;
                };
                let hub = StreamHub(shared);
                // The limits read the hub's clock; only the tick's pace is wall time.
                let now = hub.clock().now();
                match signal {
                    Ok(signal) => hub.handle(signal, now),
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => return,
                }
                if ticked.elapsed() >= TICK {
                    hub.tick(now);
                    ticked = Instant::now();
                }
            }
        })
        .map(drop)
}

/// What a decoder's end means for the item; None when it ends nothing.
fn end_for(end: DecodeEnd, push: bool) -> Option<(StreamEndReason, Option<&'static str>)> {
    let unsupported = |detail| Some((StreamEndReason::Unsupported, Some(detail)));
    match end {
        // The queue holds `End`: the engine ends the item once it has played it.
        DecodeEnd::Finished => None,
        // Whoever cancelled or dropped the reader has already ended the item.
        DecodeEnd::Cancelled | DecodeEnd::ReaderGone => None,
        DecodeEnd::SourceBroken if push => Some((StreamEndReason::ProducerGone, None)),
        DecodeEnd::SourceBroken => Some((StreamEndReason::Network, Some(CLOSED))),
        DecodeEnd::Corrupt | DecodeEnd::Panicked => unsupported(FORMAT),
        DecodeEnd::Failed(why) => unsupported(match why {
            Unsupported::ContentType => "content_type",
            Unsupported::Playlist => "playlist",
            Unsupported::Format => FORMAT,
            Unsupported::Codec => "codec",
            Unsupported::Seek => "seek",
        }),
        DecodeEnd::Isolated(Fault::Spawn) => unsupported(DECODER),
        DecodeEnd::Isolated(Fault::Hung) => Some((StreamEndReason::Stalled, None)),
        DecodeEnd::Isolated(Fault::Memory | Fault::Crashed | Fault::Spun | Fault::Protocol) => {
            unsupported(FORMAT)
        }
    }
}

impl StreamHub {
    /// One engine signal.
    pub(super) fn handle(&self, signal: StreamSignal, now: Instant) {
        let Some(link) = self.link() else {
            return;
        };
        let mut session = self.lock();
        match signal {
            StreamSignal::Phase(id, phase) => {
                let Some(item) = session.item.as_mut().filter(|item| item.id == id) else {
                    return;
                };
                let state = NowState::from(phase);
                if item.state == state {
                    return;
                }
                let shown = item.shown();
                item.state = state;
                item.waiting_since = (state == NowState::Buffering).then_some(now);
                if state == NowState::Playing {
                    item.awaiting_audio = false;
                }
                let state = item.shown();
                if state == shown {
                    return;
                }
                item.rev += 1;
                link.now(Some(&item.snapshot()));
                link.owner(&item.plugin_id, StreamEvent::State { item: id, state });
            }
            StreamSignal::Skip(id, direction) => {
                if let Some(item) = session.item.as_ref().filter(|item| item.id == id) {
                    link.owner(
                        &item.plugin_id,
                        StreamEvent::Skip {
                            item: id,
                            direction,
                        },
                    );
                }
            }
            StreamSignal::Ended(id, reason) => {
                self.end_current(&mut session, &*link, id, reason, None, Teller::Engine, now);
            }
        }
    }

    /// The decoder of item `id` ended. A pull item whose plugin no longer serves is left to
    /// `forget`.
    pub(super) fn decode_ended(&self, id: i64, end: DecodeEnd, now: Instant) {
        let Some(link) = self.link() else {
            return;
        };
        let mut session = self.lock();
        let Some(item) = session.item.as_ref().filter(|item| item.id == id) else {
            return;
        };
        // The fetch stopped quietly, which broke the decoder's source.
        if !item.is_push() && !self.serves(&item.plugin_id) {
            return;
        }
        if let Some((reason, detail)) = end_for(end, item.is_push()) {
            self.end_current(&mut session, &*link, id, reason, detail, Teller::Hub, now);
        }
    }

    /// Checks the seated item's limits, tells a waiting pusher there is room again, takes a length
    /// the decoder reported, starts a waiting artwork decode and drops ends no plugin can read any
    /// more.
    pub(super) fn tick(&self, now: Instant) {
        let Some(link) = self.link() else {
            return;
        };
        let mut session = self.lock();
        session
            .last_end
            .retain(|_, end| now.saturating_duration_since(end.at) < LAST_END_HOLD);
        let Some(item) = session.item.as_mut() else {
            return;
        };
        let id = item.id;
        if let Some(reason) = over_limit(item, now) {
            self.end_current(&mut session, &*link, id, reason, None, Teller::Hub, now);
            return;
        }
        if let Feed::Push {
            writer: Some(writer),
            wants_room,
        } = &mut item.feed
        {
            let room = writer.room();
            if *wants_room && room >= LIVE_RING / 2 {
                *wants_room = false;
                link.owner(&item.plugin_id, StreamEvent::Room { item: id, room });
            }
        }
        take_length(item, &*link);
        self.pump_art(&mut session, &link, now);
    }

    /// Takes every waiting engine signal, then checks the limits at `now`.
    #[cfg(test)]
    pub(super) fn drain(&self, now: Instant) {
        while let Ok(signal) = self.0.signals.1.try_recv() {
            self.handle(signal, now);
        }
        self.tick(now);
    }
}

/// A length the decoder reported, as a finite pull item shows it: finite, above zero and at most
/// `DURATION_MAX_SECS`. Anything else reads as unknown.
pub(super) fn usable_length(secs: f64) -> Option<f64> {
    (secs.is_finite() && secs > 0.0 && secs <= DURATION_MAX_SECS).then_some(secs)
}

/// Takes the length the current epoch's decoder reported for a finite pull item, once: the item
/// shows it and the engine gets it in a second `StreamFacts`. A live item and an unusable length
/// are left as they are.
fn take_length(item: &mut Item, link: &dyn StreamLink) {
    if item.live || item.duration.is_some() || item.is_push() {
        return;
    }
    let Some(secs) = item.control.media_secs().and_then(usable_length) else {
        return;
    };
    item.duration = Some(secs);
    item.rev += 1;
    link.send(PlayerCmd::StreamFacts {
        id: item.id,
        live: false,
        seekable: item.seekable,
        duration_secs: Some(secs),
    });
    link.now(Some(&item.snapshot()));
}

/// The limit the item has run into, if any.
fn over_limit(item: &mut Item, now: Instant) -> Option<StreamEndReason> {
    // A reconnect has its own bounded tries, and restarts the audio clock when it lands.
    if item.reconnecting {
        item.waiting_since = None;
        return None;
    }
    if !item.heard {
        if item.control.chunks_queued() > 0 {
            item.heard = true;
        } else if now.saturating_duration_since(item.accepted) >= Duration::from_millis(NO_AUDIO_MS)
        {
            return Some(StreamEndReason::NoAudio);
        }
    }
    // Once audio came, waiting for more is a stall, whether or not any has played yet.
    let waiting = match item.state {
        NowState::Buffering => true,
        NowState::Connecting => item.heard,
        NowState::Playing | NowState::Paused | NowState::Reconnecting => false,
    };
    if !waiting {
        item.waiting_since = None;
        return None;
    }
    if item.control.seek_pending() {
        item.waiting_since = Some(now);
    }
    let since = *item.waiting_since.get_or_insert(now);
    if now.saturating_duration_since(since) >= Duration::from_millis(STALL_MS) {
        return Some(StreamEndReason::Stalled);
    }
    None
}
