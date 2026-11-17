/*
 * The stream seat: a plugin stream played through the engine over the local queue, which is parked
 * under it as it is and comes back paused when the stream ends. The seat only consumes decoded PCM
 * from a queue another party fills; it never starts or stops a producer, and cancels the stream's
 * control on every way out, engine shutdown included.
 *
 * A stream plays as a run of sources: a `Break` in the queue, a seek, a preview or a device change
 * ends one and the tick starts the next, cold. The seat keeps its own reader and control for as long
 * as any of its sources can still be in the sink, and an ended seat waits in `retired` until the sink
 * has let go of them, so nothing a stream owns is freed on the audio thread.
 *
 * `run` holds the transport and the tick, `preview` the editor's preview and restore, `parked` the
 * edits of the parked queue.
 */

// -- Library Imports --
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use crossbeam_channel::Sender;

// -- Local Imports --
use super::{Engine, SourceHandles};
use crate::audio::feed::{FeedCause, FeedSource};
use crate::audio::queue::Anchor;
use crate::audio::source::{self, EdgeCell};
use crate::audio::stream::{PcmReader, StreamControl};
use crate::audio::{
    ParkedStatus, PlayerCmd, PlayerStatus, SkipDir, SkipFlags, StreamEndReason, StreamItem,
    StreamPhase, StreamSignal, StreamStatus,
};

// -- Module Declarations --
mod parked;
mod preview;
mod run;

/// The seated stream, owned by the engine thread.
pub(super) struct Seat {
    id: i64,
    live: bool,
    seekable: bool,
    duration: Option<f64>,
    // Outlives every source of the stream, so a source dropped by the sink never frees the queue.
    reader: PcmReader,
    control: Arc<StreamControl>,
    skip: Arc<SkipFlags>,
    signals: Sender<StreamSignal>,
    phase: StreamPhase,
    // Whether audio has played. The first start waits for `START_MS`, a later one for `REBUFFER_MS`.
    started: bool,
    // Paused by a pause command, as opposed to held under a preview. Only this keeps the item
    // paused once a preview stops sounding.
    paused_by_user: bool,
    // The attached source's edge, cancel flag and live spec. None while no source of the stream is
    // on the sink.
    attached: Option<Attached>,
    // Detached sources the sink may still hold. The sink holds the only other clone of each cancel.
    gone: Vec<Attached>,
    // Readers of earlier producers, kept until the sink has let go of every detached source.
    held: Vec<PcmReader>,
    // The listened time or play head while no source is attached: the seed of the next one.
    carried: f64,
    // The seek the next start waits for: until the producer has answered it, nothing queued is
    // current.
    awaiting: Option<u64>,
    // The latest seek requested. A run started after it passes over its `Break`.
    last_seek: Option<u64>,
    // The feed cause the next cold start sends.
    next_cause: FeedCause,
}

/// The engine's handles on one source of the stream.
struct Attached {
    edge: Arc<EdgeCell>,
    cancel: Arc<AtomicBool>,
    // The source's current spec, packed, which can change mid-source.
    spec: Arc<AtomicU64>,
}

impl Seat {
    fn new(item: StreamItem) -> Self {
        Self {
            id: item.id,
            live: item.live,
            seekable: item.seekable,
            duration: item.duration_secs.filter(|d| d.is_finite() && *d > 0.0),
            reader: item.pcm,
            control: item.control,
            skip: item.skip,
            signals: item.signals,
            phase: StreamPhase::Connecting,
            started: false,
            paused_by_user: false,
            attached: None,
            gone: Vec::new(),
            held: Vec::new(),
            carried: 0.0,
            awaiting: None,
            last_seek: None,
            next_cause: FeedCause::Start,
        }
    }

    fn signal(&self, signal: StreamSignal) {
        let _ = self.signals.try_send(signal);
    }

    // Moves the attached source to `gone`, cancelled so it takes nothing more from the queue.
    fn let_go(&mut self) -> bool {
        match self.attached.take() {
            Some(source) => {
                source.cancel.store(true, Ordering::Relaxed);
                self.gone.push(source);
                true
            }
            None => false,
        }
    }

    // Drops the detached sources the sink has let go of. True when none is left.
    fn sweep(&mut self) -> bool {
        self.gone
            .retain(|source| Arc::strong_count(&source.cancel) > 1);
        if self.gone.is_empty() {
            self.held.clear();
        }
        self.gone.is_empty()
    }
}

impl Drop for Seat {
    fn drop(&mut self) {
        self.control.cancel();
    }
}

/// A library track and its position, as the engine itself read it.
#[derive(Clone, Copy)]
struct Parked {
    track_id: i64,
    block: Option<u64>,
    secs: f64,
}

/// What the next `RestoreLibrary` does after an item ended. Its values were read while the item
/// played, so they never start or move the library.
enum AfterItem {
    // Re-seat this track paused at its own position.
    Parked(Parked),
    Stopped,
}

/// The stream side of the engine: the seat, the parked slot and the seats waiting to be freed.
#[derive(Default)]
pub(super) struct Seating {
    seat: Option<Seat>,
    parked: Option<Parked>,
    parked_cleared: bool,
    // Where the loaded library track stood when a preview displaced it, kept until a stream parks
    // it, a `RestoreLibrary`, a local play or a load.
    library: Option<Parked>,
    // Set when an item ends, until the next `RestoreLibrary` or transport command.
    after_item: Option<AfterItem>,
    retired: Vec<Seat>,
}

impl Seating {
    pub(super) fn is_seated(&self) -> bool {
        self.seat.is_some()
    }

    /// Drops where a displaced library track stood: another track became current.
    pub(super) fn forget_library(&mut self) {
        self.library = None;
    }
}

impl Engine {
    /// The copy the queue cursor follows, as (id, block): the parked one while a stream is seated.
    pub(super) fn queue_anchor(&self) -> Option<Anchor> {
        if self.seating.is_seated() {
            self.seating.parked.map(|p| (p.track_id, p.block))
        } else {
            self.cur_track_id.map(|id| (id, self.cur_block))
        }
    }

    fn previewing(&self) -> bool {
        self.stop_at_frame.is_some()
    }

    /// Lays the seated stream over a snapshot built from the engine state. A sounding preview is
    /// reported as it is with no stream, and the item as paused.
    pub(super) fn stream_snapshot(&self, status: &mut PlayerStatus) {
        let Some(seat) = &self.seating.seat else {
            return;
        };
        let previewing = self.previewing();
        if !previewing {
            status.playing = seat.phase == StreamPhase::Playing;
            status.track_id = Some(seat.id);
            status.position_secs = self.stream_position(seat);
            status.duration_secs = seat.duration.unwrap_or(0.0);
        }
        status.stream = Some(StreamStatus {
            live: seat.live,
            seekable: seat.seekable,
            phase: if previewing {
                StreamPhase::Paused
            } else {
                seat.phase
            },
            parked: self.seating.parked.map(|p| ParkedStatus {
                track_id: p.track_id,
                secs: p.secs,
            }),
            parked_cleared: self.seating.parked_cleared,
        });
    }

    /// What the feed says plays, and whether it waits for audio.
    pub(super) fn stream_feed(&self) -> (FeedSource, bool, bool) {
        match &self.seating.seat {
            Some(seat) => (
                FeedSource::Stream,
                seat.live,
                matches!(seat.phase, StreamPhase::Connecting | StreamPhase::Buffering),
            ),
            None => (FeedSource::Track, false, false),
        }
    }

    fn stream_position(&self, seat: &Seat) -> f64 {
        if seat.attached.is_some() {
            self.position_secs()
        } else {
            seat.carried
        }
    }

    /// Handles a command while a stream is seated, and keeps the preview bookkeeping for every
    /// command. Returns the command when the ordinary path should run it.
    pub(super) fn seated(&mut self, cmd: PlayerCmd) -> Option<PlayerCmd> {
        if matches!(
            cmd,
            PlayerCmd::Play { .. } | PlayerCmd::Jump(_) | PlayerCmd::Load { .. }
        ) {
            self.seating.library = None;
        }
        if matches!(
            cmd,
            PlayerCmd::Play { .. }
                | PlayerCmd::Jump(_)
                | PlayerCmd::Load { .. }
                | PlayerCmd::TogglePlay
                | PlayerCmd::Pause
                | PlayerCmd::Resume
                | PlayerCmd::Seek(_)
        ) {
            self.seating.after_item = None;
        }
        match cmd {
            PlayerCmd::Preview {
                path,
                start_secs,
                end_secs,
            } => {
                self.stream_preview(path, start_secs, end_secs);
                return None;
            }
            PlayerCmd::RestoreLibrary { secs, playing } => {
                return self.restore_after_preview(secs, playing);
            }
            _ => {}
        }
        let Some(seat) = &self.seating.seat else {
            return Some(cmd);
        };
        let paused = seat.phase == StreamPhase::Paused;
        let previewing = self.previewing();
        match cmd {
            PlayerCmd::Play { .. } | PlayerCmd::Jump(_) => {
                self.end_stream(StreamEndReason::Replaced, true, false);
                Some(cmd)
            }
            PlayerCmd::Load { queue, index, secs } => {
                self.load_parked(queue, index, secs);
                None
            }
            // A sounding preview owns the transport; the item waits paused under it.
            PlayerCmd::TogglePlay | PlayerCmd::Pause | PlayerCmd::Resume if previewing => Some(cmd),
            PlayerCmd::TogglePlay => {
                self.stream_pause(!paused);
                None
            }
            PlayerCmd::Pause => {
                self.stream_pause(true);
                None
            }
            PlayerCmd::Resume => {
                self.stream_pause(false);
                None
            }
            PlayerCmd::Stop if previewing => {
                self.stop_preview();
                None
            }
            PlayerCmd::Stop => {
                self.end_stream(StreamEndReason::User, true, true);
                None
            }
            PlayerCmd::Next => {
                self.stream_skip(SkipDir::Next);
                None
            }
            PlayerCmd::Prev => {
                self.stream_skip(SkipDir::Prev);
                None
            }
            PlayerCmd::Enqueue(tracks) => {
                self.park_tracks(tracks, false);
                None
            }
            PlayerCmd::InsertNext(tracks) => {
                self.park_tracks(tracks, true);
                None
            }
            PlayerCmd::RemoveQueueItem { index } => {
                self.remove_parked(index);
                None
            }
            PlayerCmd::Seek(secs) => {
                if !previewing {
                    self.stream_seek(secs);
                }
                None
            }
            other => Some(other),
        }
    }

    // ---- Seat and end ----

    /// Seats `item`. Over a library session the session is parked; over a stream the old one is
    /// dropped and its parked slot kept. Under a sounding preview the sink is left to the preview.
    pub(super) fn stream_start(&mut self, item: StreamItem) {
        let previewing = self.previewing();
        self.seating.after_item = None;
        let library = self.seating.library.take();
        match self.seating.seat.take() {
            Some(old) => {
                old.signal(StreamSignal::Ended(old.id, StreamEndReason::Replaced));
                self.retire(old);
            }
            None => {
                self.seating.parked_cleared = false;
                self.seating.parked = if self.has_library_track() {
                    self.cur_track_id.map(|id| Parked {
                        track_id: id,
                        block: self.cur_block,
                        secs: self.position_secs(),
                    })
                } else {
                    // A preview displaced the library: park it where it stood then, while the
                    // cursor still names it. Any track started since dropped the record.
                    library.filter(|p| {
                        self.queue
                            .get(self.index)
                            .is_some_and(|t| (t.id, t.block) == (p.track_id, p.block))
                    })
                };
                if !previewing {
                    self.record_manual_end();
                }
            }
        }
        let seat = Seat::new(item);
        seat.signal(StreamSignal::Phase(seat.id, StreamPhase::Connecting));
        self.seating.seat = Some(seat);
        if !previewing {
            self.clear_pending();
            if let Some(sink) = &self.sink {
                sink.clear();
            }
            self.enter_seat();
            self.feed(FeedCause::Buffering);
        }
        self.emit(true);
    }

    /// The owner's end of the item: ignored unless `id` is the one seated.
    pub(super) fn stream_end(&mut self, id: i64, reason: StreamEndReason) {
        if self.seating.seat.as_ref().is_some_and(|s| s.id == id) {
            self.end_stream(reason, false, true);
        }
    }

    /// The owner's own pause or resume: ignored unless `id` is the one seated.
    pub(super) fn stream_owner_pause(&mut self, id: i64, pause: bool) {
        if self.seating.seat.as_ref().is_some_and(|s| s.id == id) {
            self.stream_pause(pause);
        }
    }

    /// Ends the seated stream. With `restore` the parked track comes back paused, or the engine
    /// stops when there is none or its file does not open; a sounding preview keeps the sink until
    /// the next `RestoreLibrary`. With `tell` the owner gets `Ended`.
    fn end_stream(&mut self, reason: StreamEndReason, tell: bool, restore: bool) {
        let Some(seat) = self.seating.seat.take() else {
            return;
        };
        let (id, signals) = (seat.id, seat.signals.clone());
        self.retire(seat);
        let parked = self.seating.parked.take();
        self.seating.parked_cleared = false;
        let previewing = self.previewing();
        if restore {
            self.seating.after_item = Some(match parked {
                Some(p) => AfterItem::Parked(p),
                None => AfterItem::Stopped,
            });
        }
        if !previewing {
            self.clear_pending();
            if let Some(sink) = &self.sink {
                sink.clear();
            }
            self.leave_seat();
            let reseated = restore && parked.is_some_and(|p| self.reseat_parked(p));
            if !reseated {
                self.feed(FeedCause::Stop);
            }
        }
        if tell {
            let _ = signals.try_send(StreamSignal::Ended(id, reason));
        }
        self.emit(true);
    }

    /// Cancels a seat that left and keeps it until the sink has dropped its sources.
    fn retire(&mut self, mut seat: Seat) {
        seat.control.cancel();
        seat.let_go();
        if !seat.sweep() {
            self.seating.retired.push(seat);
        }
    }

    /// Frees the retired seats whose sources the sink has dropped. Engine thread only.
    pub(super) fn sweep_retired(&mut self) {
        self.seating.retired.retain_mut(|seat| !seat.sweep());
    }

    /// Points the engine state at the seated stream, with no source yet.
    fn enter_seat(&mut self) {
        self.drop_opened();
        let Some(seat) = &self.seating.seat else {
            return;
        };
        self.cur_track_id = Some(seat.id);
        self.cur_duration = seat.duration.unwrap_or(0.0);
        self.cur_frames = None;
        self.cur_spectrum = None;
        self.cur_ended = None;
        self.cur_rate = 0;
        self.cur_channels = 0;
        self.stop_at_frame = None;
        self.played_half = false;
        self.listen_recorded = false;
        self.playing = true;
        self.paused = seat.phase != StreamPhase::Playing;
        self.emit_spectrum_rest();
    }

    /// Clears the engine state the stream held. The sink is the caller's.
    fn leave_seat(&mut self) {
        self.playing = false;
        self.paused = false;
        self.cur_frames = None;
        self.cur_spectrum = None;
        self.cur_ended = None;
        self.cur_rate = 0;
        self.cur_channels = 0;
        self.cur_duration = 0.0;
        self.cur_track_id = None;
        self.emit_spectrum_rest();
    }
}

#[cfg(test)]
mod tests;
