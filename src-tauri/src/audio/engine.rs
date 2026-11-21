/*
 * The resident player engine, on one dedicated thread that owns the audio output. The frontend drives
 * it only through the command channel and reads back a shared status snapshot plus throttled
 * `player:status` events. rodio's OutputStream is !Send, which is why the engine is a thread and not a
 * value in AppState: the device is built, lives, and drops here.
 */

// -- Library Imports --
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use crossbeam_channel::{Receiver, RecvTimeoutError};
use rodio::cpal::traits::{DeviceTrait, HostTrait};
use rodio::{cpal, OutputStream, Sink, Source};
use tauri::Emitter;

// -- Local Imports --
use super::dsp::{DspParams, DspShared};
use super::feed::{self, DeviceReport, FeedCause, FeedHub, FeedSource, FeedState, Transport};
use super::queue::{
    advance_index, block_spans, clamp_index, enqueue_tracks, index_after_move, index_after_remove,
    insert_after_current, mint_blocks, move_queue_item, on_track_end, pending_slot, preload_target,
    prev_index, remove_queue_item, reseat_index, unit_shuffle_order, EndAction, Xorshift,
};
use super::source::{
    self, Arrival, Cut, DecoderSource, Entry, Packets, SpectrumTap, TrackSource, BAND_COUNT,
    FINE_BAND_COUNT, SPECTRUM_RING, SPECTRUM_WINDOW,
};
use super::tap::{TapSlot, TapWriter};
use super::{
    feed_hub, spectrum, AudioSpec, LevelFrame, PlayReport, PlayerCmd, PlayerNotice, PlayerStatus, QueueMirror,
    QueueTrack, RepeatMode,
};
use crate::adhoc::is_ad_hoc;
use crate::scan::progress::ProgressThrottle;

// -- Module Declarations --
mod events;
mod opened;
mod seat;
mod wave;

use events::AppEvents;
use opened::OpenedSource;
use wave::{Waveform, WAVE_LEN};

// The engine's tick period while audible, the cadence of the spectrum and level frames.
const AUDIBLE_TICK: Duration = Duration::from_millis(33);

// How close to its end the current track gets before the next one is opened and queued behind it.
const PRELOAD_SECS: f64 = 10.0;

// ---- The resident engine ----

/// The engine's read side of one source, taken before the source moves into the sink.
struct SourceHandles {
    frames: Arc<AtomicU64>,
    spectrum: Arc<SpectrumTap>,
    ended: Arc<AtomicBool>,
    cut: Cut,
    rate: u32,
    channels: u16,
    duration: f64,
    opened: Option<OpenedSource>,
}

impl SourceHandles {
    fn of<P: Packets>(src: &DecoderSource<P>) -> Self {
        Self {
            frames: Arc::clone(&src.frames),
            spectrum: Arc::clone(&src.spectrum),
            ended: Arc::clone(&src.ended),
            cut: Cut::of(src),
            rate: src.spec.sample_rate,
            channels: src.spec.channels,
            duration: src.duration.map(|d| d.as_secs_f64()).unwrap_or(0.0),
            opened: OpenedSource::of(src),
        }
    }
}

/// The next track, opened ahead and queued on the sink behind the current source so it starts on the
/// current one's last sample. `slot` follows the track through queue edits.
struct Pending {
    slot: usize,
    id: i64,
    handles: SourceHandles,
    cancel: Arc<AtomicBool>,
}

/// All playback state, single-owner on the audio thread and never locked. `_stream` is held only to
/// keep the device alive - dropping it silences output - and it is what forces this struct to stay
/// on its thread. `sink` is None when the device failed to open; every transport then no-ops.
struct Engine {
    _stream: Option<OutputStream>,
    sink: Option<Sink>,
    queue: Vec<QueueTrack>,
    index: usize,
    // The pristine Play-time order, captured on every Play regardless of shuffle. Restoring shuffle
    // off replays this exact insertion/album order - the user's mental model of the queue.
    original_order: Vec<QueueTrack>,
    shuffle: bool,
    // One instance for the whole thread's life, seeded once at spawn. Only shuffle draws from it.
    rng: Xorshift,
    // The next block token. Every token in the queue comes from here, so two intakes never share one.
    next_block: u64,
    repeat: RepeatMode,
    paused: bool,
    playing: bool,
    // The user's volume. Takeover never writes it, so a release restores exactly this value.
    volume: f32,
    // Set while another player renders the music: library output plays on at volume 0.
    taken_over: bool,
    cur_frames: Option<Arc<AtomicU64>>,
    // The current source's spectrum tap, tracked alongside cur_frames and read by emit_spectrum. None
    // when nothing plays.
    cur_spectrum: Option<Arc<SpectrumTap>>,
    // The last emitted band frame, the baseline the next frame's flux is measured against. Zeroed on
    // every rest edge, matching what the visualizers last drew.
    prev_bands: [f32; BAND_COUNT],
    // Whether a visualizer asked for the fine spectrum frame alongside the regular bands.
    fine_spectrum: bool,
    // The waveform snapshot picker; on only while a visualizer asked for the `player:wave` window.
    wave: Waveform,
    // The live DSP parameters every source's stage reads.
    dsp: Arc<DspShared>,
    // The audio tap every library source writes while it is active. Previews never feed it.
    tap: Arc<TapSlot>,
    // Where transport snapshots go, and the hub that owns `tap`.
    feed: &'static FeedHub,
    // The bound device's identity and period, read once per device and only while a feed consumer
    // is attached.
    device_report: Option<DeviceReport>,
    cur_rate: u32,
    cur_channels: u16,
    cur_duration: f64,
    cur_track_id: Option<i64>,
    // The block token of the queue row playing, which tells apart two copies of the same track.
    cur_block: Option<u64>,
    // The current source's drained flag. Once set with a preload queued, the sink is already playing
    // the preload and the engine promotes it.
    cur_ended: Option<Arc<AtomicBool>>,
    // The source the sink last played, kept past a stop: a clear leaves the output converter
    // finishing its block, which the next cold start's primer has to cover.
    cut: Option<Cut>,
    pending: Option<Pending>,
    // The (slot, id) of the last preload attempt, so a dead or mismatched next file is opened once per
    // window rather than on every tick. Cleared with `pending`.
    preload_tried: Option<(usize, i64)>,
    // Latched true once the play head crosses the half mark of the current listen, so a manual end past
    // it counts as a partial play. Reset by begin_listen.
    played_half: bool,
    // Guards the play-log emit to at most once per listen. Reset by begin_listen.
    listen_recorded: bool,
    // Set only while a preview is auditioning: the frame the current source stops at. `tick` ends the
    // preview when the play head reaches it. None for ordinary library playback, which runs to the
    // track's natural end and advances the queue.
    stop_at_frame: Option<u64>,
    status: Arc<Mutex<PlayerStatus>>,
    // The ordered queue track ids and block spans, written only when the queue changes, never on the
    // tick. Mirrors `status` but stays off the frequent snapshot since the id list can run long.
    queue_mirror: Arc<Mutex<QueueMirror>>,
    app: AppEvents,
    throttle: ProgressThrottle,
    // The user's output choice: None follows the system default, Some(name) pins that device.
    device_pref: Option<String>,
    // The name of the device the stream is actually bound to, for the status snapshot and the poll.
    bound_device: Option<String>,
    // The last-seen OS default output. The follow-default poll fires when THIS changes, so a
    // fallback to a non-default endpoint does not thrash a rebuild every tick.
    last_default_name: Option<String>,
    // Wall-clock ms of the last follow-default poll, throttling it to about once a second.
    last_device_poll: u64,
    // The seated plugin stream and the queue parked under it.
    seating: seat::Seating,
    // The decode helper of the current source, when it is an opened file decoded in one.
    opened: Option<OpenedSource>,
    // The status counters: bumped where an item starts (`feed`) and where a user seek took effect.
    start_seq: u64,
    seek_seq: u64,
}

impl Engine {
    /// Builds the current snapshot from engine-local state. Position is derived from the shared
    /// frame counter over the source's sample rate, so it advances without polling the sink.
    fn snapshot(&self) -> PlayerStatus {
        let position_secs = self.position_secs();
        let mut status = PlayerStatus {
            // `playing` here means actively producing sound, so a paused track reports false. Whether
            // a track session is loaded is `track_id`. Internally `self.playing` is the session flag,
            // `self.paused` the pause within it.
            playing: self.playing && !self.paused,
            track_id: self.cur_track_id,
            position_secs,
            duration_secs: self.cur_duration,
            volume: self.volume,
            repeat: self.repeat,
            queue_index: self.index,
            queue_len: self.queue.len(),
            shuffle: self.shuffle,
            output_device: self.bound_device.clone(),
            output_taken_over: self.taken_over,
            stream: None,
            start_seq: self.start_seq,
            seek_seq: self.seek_seq,
        };
        self.stream_snapshot(&mut status);
        status
    }

    /// The play head in seconds, from the current source's frame counter over its rate.
    fn position_secs(&self) -> f64 {
        match (&self.cur_frames, self.cur_rate) {
            (Some(frames), rate) if rate > 0 => frames.load(Ordering::Relaxed) as f64 / rate as f64,
            _ => 0.0,
        }
    }

    /// Mirrors the snapshot into shared state every tick (so `get_player_status` never waits on an
    /// event), then emits the `player:status` event through the throttle. `forced` marks a real
    /// state change: it emits now and resets the interval; the periodic position tick passes false.
    fn emit(&mut self, forced: bool) {
        let snap = self.snapshot();
        if let Ok(mut guard) = self.status.lock() {
            *guard = snap.clone();
        }
        if self.throttle.should_emit(now_ms(), forced) {
            let _ = self.app.emit("player:status", &snap);
        }
    }

    /// Mirrors the current queue's ordered track ids and block spans into shared state, then emits
    /// `player:queue_state` with both, once the lock is dropped.
    /// Called only when the queue's contents or order change, so the id list, which can run long,
    /// never rides the frequent status snapshot. Unthrottled: queue changes are rare.
    fn emit_queue(&mut self) {
        let mirror = QueueMirror {
            ids: self.queue.iter().map(|t| t.id).collect(),
            blocks: block_spans(&self.queue),
        };
        if let Ok(mut guard) = self.queue_mirror.lock() {
            *guard = mirror.clone();
        }
        let _ = self.app.emit("player:queue_state", &mirror);
    }

    /// Whether the engine is actively producing sound right now: a loaded track that is not paused.
    fn is_audible(&self) -> bool {
        self.playing && !self.paused
    }

    /// Whether a library track is seated, playing or paused. A preview is not one.
    fn has_library_track(&self) -> bool {
        self.playing && self.cur_track_id.is_some()
    }

    /// The volume every `sink.set_volume` takes. The one place output volume is decided. A preview is
    /// the source while `stop_at_frame` is set.
    fn output_volume(&self) -> f32 {
        sink_volume(self.volume, self.taken_over, self.stop_at_frame.is_some())
    }

    /// Sends a transport snapshot to the feed consumers. With none attached it returns after one
    /// load, so playback without a consumer is unchanged. Only a library track or a seated stream
    /// feeds the tap, so with none current (stopped, or a preview playing) the snapshot says
    /// stopped, and a pause or a resume there sends nothing.
    fn feed(&mut self, cause: FeedCause) {
        // Counted before the consumer check: the status carries it with no feed attached.
        if matches!(cause, FeedCause::Start | FeedCause::Gapless) {
            self.start_seq += 1;
        }
        if !self.feed.wanted() {
            return;
        }
        let library = self.has_library_track();
        if !library && matches!(cause, FeedCause::Pause | FeedCause::Resume) {
            return;
        }
        let device = self.bound_device.clone();
        let follows_default = self.device_pref.is_none();
        let report = self
            .device_report
            .get_or_insert_with(|| feed::device_report(device.as_deref(), follows_default))
            .clone();
        let (source, live, waiting) = self.stream_feed();
        let transport = if !library {
            Transport::Stopped
        } else if waiting {
            Transport::Buffering
        } else if self.paused {
            Transport::Paused
        } else {
            Transport::Playing
        };
        let state = FeedState {
            transport,
            sample_rate: if library { self.cur_rate } else { 0 },
            channels: if library { self.cur_channels } else { 0 },
            position_secs: if library { self.position_secs() } else { 0.0 },
            volume: self.volume,
            device,
            device_id: report.endpoint_id,
            latency_ms: report.latency_ms,
            source: if library { source } else { FeedSource::Track },
            live: library && live,
        };
        self.feed.publish(cause, state);
    }

    /// Analyzes the trailing window of played audio and emits it as `player:spectrum`, with its level
    /// and flux as `player:level`, plus `player:spectrum_fine` from the same transform while it is
    /// asked for. Gated on active output, so all are silent while paused or stopped.
    /// Snapshots the tap ring without locking: the audio thread may write mid-copy, but a torn window
    /// is immaterial to a visualizer.
    fn emit_spectrum(&mut self) {
        let tap = match &self.cur_spectrum {
            Some(tap) if self.is_audible() => tap,
            _ => return,
        };
        let at = self.position_secs();
        let Some(a) = analyze(tap, self.cur_rate, &self.prev_bands, at) else {
            return;
        };
        for (prev, cur) in self.prev_bands.iter_mut().zip(&a.bands) {
            *prev = *cur;
        }
        let _ = self.app.emit("player:spectrum", &a.bands);
        let _ = self.app.emit("player:level", a.frame);
        if self.fine_spectrum {
            let _ = self
                .app
                .emit("player:spectrum_fine", &a.bins.bands(FINE_BAND_COUNT));
        }
        if let Some(window) = self.wave.snapshot(tap) {
            let _ = self.app.emit("player:wave", &window);
        }
    }

    /// Emits one zeroed spectrum frame and one zeroed level frame so a visualizer settles to rest.
    /// Called on the edge into paused or stopped, never every idle tick.
    fn emit_spectrum_rest(&mut self) {
        self.prev_bands = [0.0; BAND_COUNT];
        let _ = self.app.emit("player:spectrum", &vec![0.0f32; BAND_COUNT]);
        let _ = self.app.emit("player:level", LevelFrame::default());
        if self.fine_spectrum {
            let _ = self
                .app
                .emit("player:spectrum_fine", &vec![0.0f32; FINE_BAND_COUNT]);
        }
        if self.wave.is_on() {
            let _ = self.app.emit("player:wave", &vec![0.0f32; WAVE_LEN]);
        }
    }

    /// Builds a source over `path` on the engine's DSP parameters, writing `tap`. See
    /// `source::open_source`.
    fn open_source(
        &self,
        path: &Path,
        start_secs: Option<f64>,
        gain_db: f32,
        tap: Option<TapWriter>,
    ) -> Option<DecoderSource> {
        source::open_source(path, start_secs, gain_db, &self.dsp, tap)
    }

    /// Loads and starts the track at `start`, skipping forward over any that fail to open until one
    /// plays or the queue exhausts and playback stops. Emits a forced status either way, plus one
    /// `player:error` File notice: on exhaustion when something was asked to play but nothing did, or
    /// on success when an opened ad-hoc file was skipped before this one played. A skipped library
    /// track mid-queue stays silent. `arrival` is how the queue came to `start`; every later slot is
    /// reached by the queue. An opened file that ends before any audio, or that faulted earlier and
    /// is reached by the queue, is passed over silently and counts as no failure.
    fn play_at(&mut self, start: usize, arrival: Arrival) {
        // Set when a skipped track was an opened file (an ad-hoc id), so a partial multi-open still
        // reports the dead one once another plays. A skipped library track leaves it false.
        let mut skipped_opened_file = false;
        let mut failed = false;
        let mut i = start;
        loop {
            if i >= self.queue.len() {
                self.stop_playback();
                self.emit(true);
                // Something was asked to play but nothing did: a lone opened file that will not
                // decode, or a play where every candidate was dead. A Next off the end has
                // start == len, so it stays silent - a natural stop, not a failure.
                if start < self.queue.len() && failed {
                    let _ = self.app.emit("player:error", PlayerNotice::File);
                }
                return;
            }
            let opened_file = is_ad_hoc(self.queue[i].id);
            let tap = Some(self.tap.cold());
            let arrival = if i == start { arrival } else { Arrival::Queue };
            match self.open_entry(&self.queue[i], None, tap, arrival) {
                Entry::Ready(src) => {
                    self.start_source(i, *src);
                    self.feed(FeedCause::Start);
                    self.emit(true);
                    // A dead opened file was skipped before this one played: report it once so the
                    // user learns the failed file did not just vanish.
                    if skipped_opened_file {
                        let _ = self.app.emit("player:error", PlayerNotice::File);
                    }
                    return;
                }
                Entry::Failed => {
                    failed = true;
                    skipped_opened_file |= opened_file;
                    i += 1;
                }
                Entry::Ended | Entry::Faulted => i += 1,
            }
        }
    }

    /// Reseats engine state onto `src` and hands it to the sink. Reads the source's handles before it
    /// is moved into the sink; with no device the state still updates so the snapshot is coherent,
    /// only the append is skipped.
    fn start_source(&mut self, i: usize, src: TrackSource) {
        let cut = self.outgoing();
        self.clear_pending();
        self.begin_listen(i, self.queue[i].id);
        self.seat(SourceHandles::of(&src));
        if let Some(sink) = &self.sink {
            sink.clear();
            source::append_cold(sink, src, cut.as_ref());
            sink.set_volume(self.output_volume());
            sink.play();
        }
        self.paused = false;
        self.playing = true;
    }

    /// Starts a new listen on queue slot `i` holding track `id`: neither the half mark nor the record
    /// has fired for it yet, and a real track supersedes any preview boundary.
    fn begin_listen(&mut self, i: usize, id: i64) {
        self.seating.forget_library();
        self.index = i;
        self.cur_track_id = Some(id);
        self.cur_block = self.queue.get(i).and_then(|t| t.block);
        self.stop_at_frame = None;
        self.played_half = false;
        self.listen_recorded = false;
    }

    /// Points the position, spectrum and end reads at a new source.
    fn seat(&mut self, h: SourceHandles) {
        self.cur_frames = Some(h.frames);
        self.cur_spectrum = Some(h.spectrum);
        self.wave.reset();
        self.cur_ended = Some(h.ended);
        self.cut = Some(h.cut);
        self.cur_rate = h.rate;
        self.cur_channels = h.channels;
        self.cur_duration = h.duration;
        self.seat_opened(h.opened);
    }

    /// The source a clear now would cut: the preload once the sink has crossed into it ahead of the
    /// tick that promotes it, else the last source seated.
    fn outgoing(&self) -> Option<Cut> {
        let drained = self
            .cur_ended
            .as_ref()
            .is_some_and(|e| e.load(Ordering::Relaxed));
        match &self.pending {
            Some(p) if drained => Some(p.handles.cut.clone()),
            _ => self.cut.clone(),
        }
    }

    /// Cancels the queued preload, if any, and forgets the last attempt so the window can re-arm.
    /// Every path that clears or replaces the sink calls this first: a preload outliving its sink
    /// would be promoted onto a source that never plays.
    fn clear_pending(&mut self) {
        if let Some(p) = self.pending.take() {
            p.cancel.store(true, Ordering::Relaxed);
            if let Some(opened) = &p.handles.opened {
                opened.decode.cancel();
            }
        }
        self.preload_tried = None;
    }

    /// Keeps the preload only while it is still the track that plays next, following it to its new
    /// slot after a queue edit. Otherwise it is cancelled, and the next tick arms the right one.
    fn revalidate_pending(&mut self) {
        let id = match &self.pending {
            Some(p) => p.id,
            None => return,
        };
        match pending_slot(&self.queue, self.index, self.repeat, id) {
            Some(slot) => {
                if let Some(p) = &mut self.pending {
                    p.slot = slot;
                }
            }
            None => self.clear_pending(),
        }
    }

    /// Opens the track that plays next and queues it behind the current source, once the current
    /// track is within PRELOAD_SECS of its end, or at once when its length is unknown. A next file
    /// that fails to open, or whose rate or channel count differs from the current source, is left to
    /// the cold end: rodio's queue reads the first block after a layout change in the old layout.
    fn arm_preload(&mut self) {
        let drained = self
            .cur_ended
            .as_ref()
            .is_some_and(|e| e.load(Ordering::Relaxed));
        if self.pending.is_some()
            || self.sink.is_none()
            || !self.playing
            || self.cur_track_id.is_none()
            || self.stop_at_frame.is_some()
            || self.seating.is_seated()
            || drained
        {
            return;
        }
        if self.cur_duration > 0.0 && self.cur_duration - self.position_secs() > PRELOAD_SECS {
            return;
        }
        let slot = match preload_target(self.index, self.queue.len(), self.repeat) {
            Some(slot) => slot,
            None => return,
        };
        let id = self.queue[slot].id;
        if self.preload_tried == Some((slot, id)) {
            return;
        }
        self.preload_tried = Some((slot, id));
        let tap = Some(self.tap.warm());
        let src = match self.open_track(&self.queue[slot], None, tap) {
            Some(s) => s,
            None => return,
        };
        let handles = SourceHandles::of(&src);
        let cancel = Arc::clone(&src.cancel);
        // Read again after the open: a track that ended meanwhile has the sink playing silence. The
        // dropped writer never wrote, so the cold end starts the next track in a new epoch.
        let drained = self
            .cur_ended
            .as_ref()
            .is_some_and(|e| e.load(Ordering::Relaxed));
        if !joins_gapless(src.spec, self.cur_rate, self.cur_channels, drained) {
            return;
        }
        // Appended bare: the queue is busy with the current source, so no primer is needed.
        if let Some(sink) = &self.sink {
            sink.append(src);
        }
        self.pending = Some(Pending {
            slot,
            id,
            handles,
            cancel,
        });
    }

    /// Promotes the preload once the current source has drained into it. The sink never empties
    /// between the two, so the finished track's completed play is recorded here; then every piece of
    /// current-track state moves onto the preload and a forced status retitles the now-playing
    /// surfaces.
    fn promote(&mut self) {
        let drained = self
            .cur_ended
            .as_ref()
            .is_some_and(|e| e.load(Ordering::Relaxed));
        if !drained {
            return;
        }
        let p = match self.pending.take() {
            Some(p) => p,
            None => return,
        };
        self.notice_failed_file();
        self.record_play(true);
        self.preload_tried = None;
        self.begin_listen(p.slot, p.id);
        self.seat(p.handles);
        self.feed(FeedCause::Gapless);
        self.emit(true);
    }

    /// Stops playback and clears the current-track state. The sink is emptied so the next play
    /// starts clean.
    fn stop_playback(&mut self) {
        let was_library = self.has_library_track();
        self.clear_pending();
        self.drop_opened();
        if let Some(sink) = &self.sink {
            sink.clear();
        }
        self.playing = false;
        self.paused = false;
        self.cur_frames = None;
        self.cur_spectrum = None;
        self.cur_ended = None;
        self.cur_rate = 0;
        self.cur_channels = 0;
        self.cur_duration = 0.0;
        self.cur_track_id = None;
        self.stop_at_frame = None;
        // Settle the bars to rest on the edge into stopped, so a visualizer needs no self-decay.
        self.emit_spectrum_rest();
        if was_library {
            self.feed(FeedCause::Stop);
        }
    }

    /// The single choke point for a counted listen. Both guards ride here: it fires at most once per
    /// listen (`listen_recorded`), and never for a preview or stopped engine (`cur_track_id` None) nor
    /// an ad-hoc file (a negative id would violate the plays foreign key). Emits `player:played`; the
    /// engine never opens a connection - a thin listener does the insert on the event thread.
    fn record_play(&mut self, completed: bool) {
        if self.listen_recorded {
            return;
        }
        let id = match self.cur_track_id {
            Some(id) if !is_ad_hoc(id) => id,
            _ => return,
        };
        self.listen_recorded = true;
        let _ = self.app.emit(
            "player:played",
            PlayReport {
                track_id: id,
                completed,
            },
        );
    }

    /// Records a partial play when a listen is ended by hand - a skip, a stop, a new Play - but only
    /// once the head crossed the half mark. Before half, a manual end counts nothing.
    fn record_manual_end(&mut self) {
        if self.played_half {
            self.record_play(false);
        }
    }

    /// Auditions `path` between `start_secs` and `end_secs` on the resident sink: opens the file,
    /// seeks to the in-point, and plays until `tick` catches the out-point frame. Leaves `queue` and
    /// `index` untouched, and holds `cur_track_id` at None since a preview is not a library track, so
    /// library playback restores after. Plays at unity gain, since the audition is of the file itself.
    /// A missing file or a seek failure leaves playback untouched.
    fn preview(&mut self, path: PathBuf, start_secs: f64, end_secs: f64) {
        // The factory seeds the counter at the in-point on the primed rate, the same rate the
        // out-point below uses, so the play head and the boundary agree.
        let src = match self.open_source(&path, Some(start_secs.max(0.0)), 0.0, None) {
            Some(s) => s,
            None => return,
        };
        let rate = src.spec.sample_rate;
        let was_library = self.has_library_track();
        let cut = self.outgoing();
        self.clear_pending();
        self.seat(SourceHandles::of(&src));
        self.cur_track_id = None;
        self.stop_at_frame = if rate > 0 {
            Some((end_secs.max(0.0) * rate as f64).round() as u64)
        } else {
            None
        };
        if let Some(sink) = &self.sink {
            sink.clear();
            source::append_cold(sink, src, cut.as_ref());
            sink.set_volume(self.output_volume());
            sink.play();
        }
        self.paused = false;
        self.playing = true;
        // The library source is gone; the preview itself never reaches the feed.
        if was_library {
            self.feed(FeedCause::Stop);
        }
        self.emit(true);
    }

    /// Reopens the current queue track at `secs` and reseats it as the library source, so a preview
    /// that cleared the sink no longer leaves the library silent. Reuses `start_source`, then sets the
    /// paused state from `playing`. A no-op with an empty queue; a missing file or a seek failure
    /// leaves playback untouched.
    fn restore_library(&mut self, secs: f64, playing: bool) {
        let track = match self.queue.get(self.index) {
            Some(t) => t.clone(),
            None => return,
        };
        let tap = Some(self.tap.cold());
        let src = match self.open_track(&track, Some(secs.max(0.0)), tap) {
            Some(s) => s,
            None => return,
        };
        // start_source reseats the counter, rate, duration and track id, clears any preview boundary,
        // and appends to the sink playing.
        self.start_source(self.index, src);
        if !playing {
            if let Some(sink) = &self.sink {
                sink.pause();
            }
            self.paused = true;
            self.emit_spectrum_rest();
        }
        // One snapshot, taken once the paused state is settled.
        self.feed(FeedCause::Start);
        self.emit(true);
    }

    /// Seats `queue` at `index` on a paused source positioned at `secs`. Records no play and leaves the
    /// half latch clear, so playing on from the restored position counts as usual. The file opens before
    /// any state moves, so a dead file leaves the engine untouched beyond its notice.
    fn load(&mut self, queue: Vec<QueueTrack>, index: usize, secs: f64) {
        if queue.is_empty() {
            return;
        }
        let i = clamp_index(index, queue.len());
        let start = if secs > 0.0 { Some(secs) } else { None };
        let (i, src) = match self.open_onward(&queue, i, start) {
            Some(opened) => opened,
            None => {
                let _ = self.app.emit("player:error", PlayerNotice::File);
                return;
            }
        };
        self.record_manual_end();
        self.queue = queue;
        self.original_order = self.queue.clone();
        self.shuffle = false;
        self.emit_queue();
        let cut = self.outgoing();
        self.clear_pending();
        self.begin_listen(i, self.queue[i].id);
        self.seat(SourceHandles::of(&src));
        if let Some(sink) = &self.sink {
            sink.clear();
            sink.pause();
            source::append_cold(sink, src, cut.as_ref());
            sink.set_volume(self.output_volume());
        }
        self.paused = true;
        self.playing = true;
        self.emit_spectrum_rest();
        self.feed(FeedCause::Start);
        self.emit(true);
    }

    /// Reopens the current file, seeks to `secs`, and restarts the source there while preserving the
    /// paused state; an opened file's helper seeks in place. A missing file or a seek failure leaves
    /// playback untouched, except that a helper that fails the seek ends its file. Returns whether a
    /// source was seated.
    /// `user` marks a seek the user asked for, which counts in `seek_seq`; a device rebind re-seeks
    /// with it false.
    fn seek(&mut self, secs: f64, user: bool) -> bool {
        let track = match self.queue.get(self.index) {
            Some(t) if self.cur_track_id.is_some() => t.clone(),
            _ => return false,
        };
        let tap = Some(self.tap.cold());
        let src = match self.reopen_current(&track, secs, tap) {
            Some(s) => s,
            None => return false,
        };
        let cut = self.outgoing();
        // Inside the window the next tick re-arms the preload this drops.
        self.clear_pending();
        self.seat(SourceHandles::of(&src));
        if let Some(sink) = &self.sink {
            sink.clear();
            source::append_cold(sink, src, cut.as_ref());
            sink.set_volume(self.output_volume());
            if self.paused {
                sink.pause();
            } else {
                sink.play();
            }
        }
        if user {
            self.seek_seq += 1;
        }
        self.feed(FeedCause::Seek);
        self.emit(true);
        true
    }

    /// Rebuilds the output stream onto `pref` (None follows the system default, Some pins a device),
    /// preserving the current track and play head across the swap. Any failure to open leaves the
    /// engine device-less but coherent, never panicking.
    fn rebind(&mut self, pref: Option<String>) {
        // A boundary already crossed resumes the track now playing, not the one that just ended.
        self.promote();
        // Capture the play head and session before the old device drops, so the rebuilt sink resumes
        // the same track at the same spot. Same math the snapshot uses.
        let resume_secs = self.position_secs();
        let was_playing = self.cur_track_id.is_some();
        // A preload queued on the old sink drops with it.
        self.clear_pending();

        // Resolve the target device and its real name. A pinned name that no longer enumerates falls
        // back to the system default with a one-off error.
        let (stream_res, bound_name) = match &pref {
            None => (OutputStream::try_default(), default_output_name()),
            Some(name) => match find_output_device(name) {
                Some(dev) => {
                    let resolved = dev.name().ok();
                    (OutputStream::try_from_device(&dev), resolved)
                }
                None => {
                    // The pinned device is gone; playback carries on the system default, so this is a
                    // fallback notice, not an output loss.
                    let _ = self.app.emit("player:error", PlayerNotice::DeviceFallback);
                    (OutputStream::try_default(), default_output_name())
                }
            },
        };

        // Open the sink on the new device. Stream and sink errors carry different types, so collapse
        // both to the one Output notice rather than chaining them.
        let built = match stream_res {
            Ok((stream, handle)) => match Sink::try_new(&handle) {
                Ok(sink) => {
                    sink.set_volume(self.output_volume());
                    Some((stream, sink))
                }
                Err(_) => None,
            },
            Err(_) => None,
        };

        self.device_report = None;
        let (stream, sink) = match built {
            Some(pair) => pair,
            None => {
                let _ = self.app.emit("player:error", PlayerNotice::Output);
                self._stream = None;
                self.sink = None;
                self.bound_device = None;
                self.feed(FeedCause::Device);
                return;
            }
        };

        // Overwrite drops the old sink then the old stream on this thread, silencing the old endpoint.
        self._stream = Some(stream);
        self.sink = Some(sink);
        // The new sink has no block in flight to cover.
        self.cut = None;
        self.bound_device = bound_name;
        self.last_default_name = default_output_name();
        self.device_pref = pref;
        self.last_device_poll = now_ms();

        if self.seating.is_seated() {
            self.stream_rebound();
        } else if was_playing {
            // seek reopens the current file, seeks, and appends to the now-new sink, preserving the
            // paused state and emitting its own forced status.
            self.seek(resume_secs, false);
            self.feed(FeedCause::Device);
        } else {
            self.feed(FeedCause::Device);
            self.emit(true);
        }
    }

    /// Reorders the queue into a shuffled order with the unit holding `pin` fixed at the front, then
    /// seats the cursor on `pin`'s new slot inside it. Touches the queue Vec and cursor only - never
    /// the sink - so the live source plays on across the reorder.
    fn shuffle_queue(&mut self, pin: usize) {
        let (order, cursor) = unit_shuffle_order(&self.queue, pin, &mut self.rng);
        let reordered: Vec<QueueTrack> = order.into_iter().map(|i| self.queue[i].clone()).collect();
        self.queue = reordered;
        self.index = cursor;
    }

    /// Restores the pristine Play-time order and re-seats the cursor onto the currently-playing copy
    /// by id and block token, so the live source plays on untouched. Under a stream it follows the
    /// parked copy. Falls back to a clamped index when nothing plays or the copy is no longer in the
    /// queue.
    fn restore_order(&mut self) {
        self.queue = self.original_order.clone();
        self.index = reseat_index(&self.queue, self.queue_anchor(), self.index);
    }

    /// Applies one transport command, then emits a forced status since every command changes state.
    fn handle(&mut self, mut cmd: PlayerCmd) {
        // Tokens are minted here, before a seated stream routes a queue to the parked code, so every
        // intake draws from the one counter.
        if let PlayerCmd::Play { queue, .. }
        | PlayerCmd::Load { queue, .. }
        | PlayerCmd::Enqueue(queue)
        | PlayerCmd::InsertNext(queue) = &mut cmd
        {
            mint_blocks(queue, &mut self.next_block);
        }
        // A boundary crossed since the last tick is promoted first, so the command acts on the track
        // actually playing.
        self.promote();
        let Some(cmd) = self.seated(cmd) else {
            return;
        };
        match cmd {
            PlayerCmd::Play { queue, index } => {
                // The outgoing listen ends by hand: count it if it passed half, before the queue is
                // reassigned out from under cur_track_id.
                self.record_manual_end();
                self.queue = queue;
                let mut start = clamp_index(index, self.queue.len());
                // Capture the pristine order before any shuffle, so restoring shuffle off returns
                // here regardless of the order playback runs in.
                self.original_order = self.queue.clone();
                if self.shuffle {
                    self.shuffle_queue(start);
                    start = self.index;
                }
                self.emit_queue();
                // play_at emits its own forced status on success or exhaustion.
                self.play_at(start, Arrival::User);
            }
            PlayerCmd::Load { queue, index, secs } => self.load(queue, index, secs),
            PlayerCmd::TogglePlay => {
                if let Some(sink) = &self.sink {
                    if self.paused {
                        sink.play();
                    } else {
                        sink.pause();
                    }
                }
                self.paused = !self.paused;
                if self.paused {
                    self.emit_spectrum_rest();
                    self.feed(FeedCause::Pause);
                } else {
                    self.feed(FeedCause::Resume);
                }
                self.emit(true);
            }
            PlayerCmd::Pause => {
                if let Some(sink) = &self.sink {
                    sink.pause();
                }
                self.paused = true;
                self.emit_spectrum_rest();
                self.feed(FeedCause::Pause);
                self.emit(true);
            }
            PlayerCmd::Resume => {
                if let Some(sink) = &self.sink {
                    sink.play();
                }
                self.paused = false;
                self.feed(FeedCause::Resume);
                self.emit(true);
            }
            PlayerCmd::Stop => {
                self.record_manual_end();
                self.stop_playback();
                self.emit(true);
            }
            PlayerCmd::Next => {
                self.record_manual_end();
                match advance_index(self.index, self.queue.len(), self.repeat) {
                    Some(i) => self.play_at(i, Arrival::User),
                    None => {
                        self.stop_playback();
                        self.emit(true);
                    }
                }
            }
            PlayerCmd::Prev => {
                self.record_manual_end();
                match prev_index(self.index, self.queue.len()) {
                    Some(i) => self.play_at(i, Arrival::User),
                    None => {
                        self.stop_playback();
                        self.emit(true);
                    }
                }
            }
            PlayerCmd::Jump(i) => {
                self.record_manual_end();
                // play_at clamps an empty queue (stops and emits) and skips forward over a dead
                // track, so a jump lands on the next playable slot, exactly like Next.
                let i = clamp_index(i, self.queue.len());
                self.play_at(i, Arrival::User);
            }
            PlayerCmd::Enqueue(tracks) => {
                if tracks.is_empty() {
                    return;
                }
                let first_new = enqueue_tracks(&mut self.queue, &mut self.original_order, tracks);
                self.emit_queue();
                if self.cur_track_id.is_none() {
                    // Cold-start safety net: an Enqueue onto a stopped engine starts playing the new
                    // tracks rather than leaving a silent queue. The frontend routes cold-start
                    // through Play, so this is the defensive path.
                    self.play_at(first_new, Arrival::User);
                } else {
                    // The sink is untouched: a playing track plays on, a paused track stays paused.
                    self.revalidate_pending();
                    self.emit(true);
                }
            }
            PlayerCmd::InsertNext(tracks) => {
                if tracks.is_empty() {
                    return;
                }
                let anchor = self.queue_anchor();
                let first_new = insert_after_current(
                    &mut self.queue,
                    &mut self.original_order,
                    self.shuffle,
                    self.index,
                    anchor,
                    tracks,
                );
                self.emit_queue();
                if self.cur_track_id.is_none() {
                    self.play_at(first_new, Arrival::User);
                } else {
                    // The sink is untouched. A preload stays only while its track still plays next:
                    // an insert behind a loose track or a block's last member drops it, one after the
                    // end of the playing block keeps the next member's.
                    self.revalidate_pending();
                    self.emit(true);
                }
            }
            PlayerCmd::MoveQueueItem { from, to } => {
                let Some(dest) = move_queue_item(
                    &mut self.queue,
                    &mut self.original_order,
                    self.shuffle,
                    from,
                    to,
                ) else {
                    return;
                };
                // The cursor follows its row by index, so a loose copy of the playing track
                // elsewhere in the queue never takes it.
                self.index = clamp_index(index_after_move(self.index, from, dest), self.queue.len());
                self.revalidate_pending();
                self.emit_queue();
                self.emit(true);
            }
            PlayerCmd::RemoveQueueItem { index } => {
                // The playing row is the one under the cursor; another copy of its track is not.
                let playing_row = self.cur_track_id.is_some() && index == self.index;
                if remove_queue_item(
                    &mut self.queue,
                    &mut self.original_order,
                    self.shuffle,
                    index,
                )
                .is_none()
                {
                    return;
                }
                if playing_row {
                    // Removing the current track ends its listen by hand: count it if it passed half.
                    self.record_manual_end();
                    // The sink still renders the removed source, so this is a skip: advance onto
                    // whatever slid into the slot, reusing play_at's dead-track skip and forced emit.
                    // The queue shrank, so mirror it before either outcome (play_at only emits status).
                    self.emit_queue();
                    if self.queue.is_empty() {
                        self.stop_playback();
                        self.emit(true);
                    } else {
                        self.play_at(clamp_index(index, self.queue.len()), Arrival::Queue);
                    }
                } else {
                    // Removing an up-next or played track: the sink plays on, only the cursor moves.
                    self.index = index_after_remove(self.index, index, self.queue.len());
                    self.revalidate_pending();
                    self.emit_queue();
                    self.emit(true);
                }
            }
            PlayerCmd::Seek(secs) => {
                self.seek(secs, true);
            }
            PlayerCmd::SetVolume(v) => {
                self.volume = v.clamp(0.0, 1.0);
                if let Some(sink) = &self.sink {
                    sink.set_volume(self.output_volume());
                }
                self.feed(FeedCause::Volume);
                self.emit(true);
            }
            PlayerCmd::SetRepeat(m) => {
                self.repeat = m;
                self.revalidate_pending();
                self.emit(true);
            }
            PlayerCmd::SetShuffle(on) => {
                if on != self.shuffle {
                    self.shuffle = on;
                    if on {
                        // Pin the current track's block, or the track alone, to the front and shuffle
                        // the rest. The Vec and cursor change before the preload is revalidated, so
                        // one armed for the next member of the block stays; the sink is untouched.
                        self.shuffle_queue(self.index);
                    } else {
                        self.restore_order();
                    }
                    self.revalidate_pending();
                    self.emit_queue();
                }
                self.emit(true);
            }
            PlayerCmd::SetOutputDevice(pref) => self.rebind(pref),
            PlayerCmd::Preview {
                path,
                start_secs,
                end_secs,
            } => self.preview(path, start_secs, end_secs),
            PlayerCmd::RestoreLibrary { secs, playing } => self.restore_library(secs, playing),
            PlayerCmd::SetSound(settings) => self.dsp.store(&DspParams::from(&settings)),
            PlayerCmd::SetFineSpectrum(on) => self.fine_spectrum = on,
            PlayerCmd::SetWaveform(on) => self.wave.set_on(on),
            PlayerCmd::FeedSnapshot => self.feed(FeedCause::Snapshot),
            PlayerCmd::SetOutputTakeover(on) => {
                self.taken_over = on;
                if let Some(sink) = &self.sink {
                    sink.set_volume(self.output_volume());
                }
                self.emit(true);
            }
            PlayerCmd::StreamStart(item) => self.stream_start(item),
            PlayerCmd::StreamEnd { id, reason } => self.stream_end(id, reason),
            PlayerCmd::StreamPause { id, pause } => self.stream_owner_pause(id, pause),
            PlayerCmd::StreamFacts {
                id,
                live,
                seekable,
                duration_secs,
            } => self.stream_facts(id, live, seekable, duration_secs),
            PlayerCmd::StreamEpoch { id, pcm, control } => self.stream_epoch(id, pcm, control),
            PlayerCmd::ClearParked => self.clear_parked(),
        }
    }

    /// The idle tick between commands: promotes a preload the sink crossed into, detects a track that
    /// played out with nothing queued behind it and moves the queue, arms the next preload, then
    /// writes a periodic status. An unplugged device mid-play is not handled here - `sink.empty()`
    /// reads as track-end.
    fn tick(&mut self) {
        // Follow the system default only while unpinned, throttled to about once a second. Keyed off
        // the default's NAME changing, not "bound != default", so a fallback to a non-default
        // endpoint does not rebuild every tick.
        if self.device_pref.is_none() {
            let now = now_ms();
            if now.saturating_sub(self.last_device_poll) >= 1000 {
                self.last_device_poll = now;
                let cur = default_output_name();
                if cur != self.last_default_name {
                    self.last_default_name = cur;
                    self.rebind(None);
                }
            }
        }
        self.promote();
        self.sweep_retired();
        // Latch the half-play mark while audio genuinely advances through the source, so a manual end
        // past it counts and a seek alone never does. The latch only sets; record_play gates the id.
        if self.is_audible()
            && self.cur_duration > 0.0
            && !self.played_half
            && self.position_secs() >= 0.5 * self.cur_duration
        {
            self.played_half = true;
        }
        if let Some(stop) = self.stop_at_frame {
            // A preview stops at its out-point, or if the file ends first, without ever moving the
            // queue: stop_playback clears the source and the boundary but leaves queue and index be.
            let reached = self
                .cur_frames
                .as_ref()
                .is_some_and(|f| f.load(Ordering::Relaxed) >= stop);
            let ended = self.sink.as_ref().is_some_and(|s| s.empty());
            if self.playing && !self.paused && (reached || ended) {
                self.stop_playback();
                self.preview_ended();
                self.emit(true);
            }
        } else if self.seating.is_seated() {
            self.stream_tick();
        } else if self.playing && !self.paused && self.sink.as_ref().is_some_and(|s| s.empty()) {
            // A track that drained on its own is a completed play, recorded unconditionally (a full
            // play counts even where the half latch never ran, e.g. a zero-duration file), before the
            // queue moves onto the next source and start_source resets the guards.
            self.notice_failed_file();
            self.record_play(true);
            match on_track_end(self.index, self.queue.len(), self.repeat) {
                EndAction::Replay => self.play_at(self.index, Arrival::Queue),
                EndAction::Advance(i) => self.play_at(i, Arrival::Queue),
                EndAction::Stop => self.stop_playback(),
            }
        }
        self.arm_preload();
        // Self-gates on is_audible, so an idle tick emits nothing; the status path keeps its own throttle.
        self.emit_spectrum();
        self.emit(false);
    }
}

/// One analysis of the tap's trailing window: the regular bands, the level frame, and the transform the
/// fine bands read.
struct Analysis {
    bins: spectrum::Bins,
    bands: Vec<f32>,
    frame: LevelFrame,
}

/// Analyzes the trailing SPECTRUM_WINDOW samples of `tap` at `rate`, with flux measured against
/// `prev_bands`, the frame stamped with the play head `at` in seconds. None until a full window has
/// been written.
fn analyze(tap: &SpectrumTap, rate: u32, prev_bands: &[f32], at: f64) -> Option<Analysis> {
    let w = tap.written.load(Ordering::Relaxed);
    if w < SPECTRUM_WINDOW as u64 {
        return None;
    }
    let mut window = [0.0f32; SPECTRUM_WINDOW];
    for (i, out) in window.iter_mut().enumerate() {
        let slot = ((w - SPECTRUM_WINDOW as u64 + i as u64) as usize) & (SPECTRUM_RING - 1);
        *out = f32::from_bits(tap.ring[slot].load(Ordering::Relaxed));
    }
    let bins = spectrum::Bins::of(&window, rate);
    let bands = bins.bands(BAND_COUNT);
    let level = spectrum::level(&window);
    let frame = LevelFrame {
        rms: level.rms,
        peak: level.peak,
        flux: spectrum::flux(prev_bands, &bands),
        rms_db: level.rms_db,
        at,
    };
    Some(Analysis { bins, bands, frame })
}

/// Spawns the resident player thread and returns its handle. The thread builds the output device,
/// then loops on the command channel until every Sender drops at app exit, when it breaks and the
/// device drops with it. Not meant to be joined - it is a daemon that dies with the channel.
pub fn spawn(
    rx: Receiver<PlayerCmd>,
    status: Arc<Mutex<PlayerStatus>>,
    queue_mirror: Arc<Mutex<QueueMirror>>,
    app: tauri::AppHandle,
) -> JoinHandle<()> {
    thread::Builder::new()
        .name("plisto-player".to_string())
        .spawn(move || run(rx, status, queue_mirror, app))
        .expect("player thread spawns")
}

/// The thread body. Builds the device (emitting a `player:error` Output notice and running
/// device-less on failure, never panicking), then services commands on a short timeout so the idle
/// tick can catch a track-end even when no command arrives.
fn run(
    rx: Receiver<PlayerCmd>,
    status: Arc<Mutex<PlayerStatus>>,
    queue_mirror: Arc<Mutex<QueueMirror>>,
    app: tauri::AppHandle,
) {
    let (stream, sink) = match OutputStream::try_default() {
        Ok((stream, handle)) => match Sink::try_new(&handle) {
            Ok(sink) => (Some(stream), Some(sink)),
            Err(_) => {
                let _ = app.emit("player:error", PlayerNotice::Output);
                (None, None)
            }
        },
        Err(_) => {
            let _ = app.emit("player:error", PlayerNotice::Output);
            (None, None)
        }
    };

    // Baseline the poll off the device just built: bound_device is the opened default's real name (or
    // None when the build failed), and last_default_name seeds the follow-default comparison.
    let bound_device = if stream.is_some() {
        default_output_name()
    } else {
        None
    };
    let last_default_name = default_output_name();

    let mut engine = Engine {
        _stream: stream,
        sink,
        queue: Vec::new(),
        index: 0,
        original_order: Vec::new(),
        shuffle: false,
        rng: Xorshift::new(now_ms()),
        next_block: 0,
        repeat: RepeatMode::Off,
        paused: false,
        playing: false,
        volume: 1.0,
        taken_over: false,
        cur_frames: None,
        cur_spectrum: None,
        prev_bands: [0.0; BAND_COUNT],
        fine_spectrum: false,
        wave: Waveform::new(now_ms() ^ 0x5851_f42d_4c95_7f2d),
        dsp: Arc::new(DspShared::default()),
        tap: Arc::clone(feed_hub().slot()),
        feed: feed_hub(),
        device_report: None,
        cur_rate: 0,
        cur_channels: 0,
        cur_duration: 0.0,
        cur_track_id: None,
        cur_block: None,
        cur_ended: None,
        cut: None,
        pending: None,
        preload_tried: None,
        played_half: false,
        listen_recorded: false,
        stop_at_frame: None,
        status,
        queue_mirror,
        app: AppEvents::of(app),
        throttle: ProgressThrottle::new(200),
        device_pref: None,
        bound_device,
        last_default_name,
        last_device_poll: now_ms(),
        seating: seat::Seating::default(),
        opened: None,
        start_seq: 0,
        seek_seq: 0,
    };

    loop {
        // Tick at about 30fps while audible so the spectrum feed is smooth, idling back to a slow poll
        // when nothing plays. Only the timeout changes: the status throttle and track-end checks hold.
        let timeout = if engine.is_audible() {
            AUDIBLE_TICK
        } else {
            Duration::from_millis(120)
        };
        match rx.recv_timeout(timeout) {
            Ok(cmd) => engine.handle(cmd),
            Err(RecvTimeoutError::Timeout) => engine.tick(),
            // Every Sender dropped: the app is exiting. Break so the sink and stream drop cleanly.
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
}

/// The name of the current system default output device, or None when there is none or its name is
/// unreadable. The follow-default poll and the initial baseline both read it.
fn default_output_name() -> Option<String> {
    cpal::default_host().default_output_device()?.name().ok()
}

/// The output device whose name matches `name`, or None when none enumerates under it. Built on the
/// player thread since the Device feeds the !Send OutputStream.
fn find_output_device(name: &str) -> Option<cpal::Device> {
    cpal::default_host()
        .output_devices()
        .ok()?
        .find(|dev| dev.name().ok().as_deref() == Some(name))
}

/// Whether a preload of layout `spec` is appended behind the current source. A layout change or a
/// current source that already drained leaves the next track to the cold end.
fn joins_gapless(spec: AudioSpec, cur_rate: u32, cur_channels: u16, drained: bool) -> bool {
    !drained && spec.sample_rate == cur_rate && spec.channels == cur_channels
}

/// The sink volume for the user's `volume`: silent while the output is taken over, except for a
/// preview, which is auditioned at the user's volume.
fn sink_volume(volume: f32, taken_over: bool, preview: bool) -> f32 {
    if taken_over && !preview {
        0.0
    } else {
        volume
    }
}

/// Wall-clock milliseconds since the Unix epoch, the clock the emit throttle measures against.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const STEREO: AudioSpec = AudioSpec {
        sample_rate: 44_100,
        channels: 2,
    };

    #[test]
    fn the_level_frame_carries_the_play_head() {
        let tap = SpectrumTap::new();
        tap.written.store(SPECTRUM_WINDOW as u64, Ordering::Relaxed);
        let a = analyze(&tap, 44_100, &[0.0; BAND_COUNT], 12.5).expect("a full window");
        assert_eq!(a.frame.at, 12.5);
        assert_eq!(LevelFrame::default().at, 0.0);
    }

    #[test]
    fn a_preload_of_the_same_layout_joins_gapless() {
        assert!(joins_gapless(STEREO, 44_100, 2, false));
    }

    #[test]
    fn a_preload_of_another_layout_is_left_to_the_cold_end() {
        assert!(!joins_gapless(STEREO, 48_000, 2, false));
        assert!(!joins_gapless(STEREO, 44_100, 1, false));
    }

    #[test]
    fn a_preload_opened_after_the_current_source_drained_is_left_to_the_cold_end() {
        assert!(!joins_gapless(STEREO, 44_100, 2, true));
    }

    // ---- Output takeover ----

    #[test]
    fn the_sink_volume_follows_takeover_and_preview() {
        // (user volume, taken over, preview) -> sink volume
        let table = [
            (0.8, false, false, 0.8),
            (0.8, true, false, 0.0),
            (0.8, false, true, 0.8),
            (0.8, true, true, 0.8),
            (0.0, false, false, 0.0),
            (1.0, true, false, 0.0),
            (1.0, true, true, 1.0),
        ];
        for (volume, taken_over, preview, want) in table {
            assert_eq!(
                sink_volume(volume, taken_over, preview),
                want,
                "volume {volume}, taken over {taken_over}, preview {preview}"
            );
        }
    }

    #[test]
    fn a_muted_sink_keeps_draining_and_feeding_the_tap() {
        use crate::audio::source::tests::{bits, raw_samples, write_wav, TempDir};
        use crate::audio::tap::tests::{source, tapped};
        use crate::audio::tap::HeapRegion;
        use rodio::source::UniformSourceIterator;

        let dir = TempDir::new("takeover");
        let path = dir.path.join("tone.wav");
        let frames = 3_000usize;
        write_wav(&path, 44_100, 2, frames);

        let slot = Arc::new(TapSlot::new(HeapRegion::new()));
        slot.set_active(true);
        let src = source(&path, None, Some(slot.cold()));
        let (played, ended) = (Arc::clone(&src.frames), Arc::clone(&src.ended));

        let (sink, output) = rodio::Sink::new_idle();
        sink.set_volume(sink_volume(0.8, true, false));
        sink.append(src);
        let mut out = UniformSourceIterator::<_, f32>::new(output, 2, 44_100);
        let mut heard = Vec::new();
        while !ended.load(Ordering::Relaxed) {
            heard.push(out.next().expect("the keep-alive queue never ends"));
        }

        assert!(heard.iter().all(|&s| s == 0.0), "nothing is heard");
        assert_eq!(played.load(Ordering::Relaxed), frames as u64);
        assert_eq!(slot.write_cursor(), (frames * 2) as u64);
        assert_eq!(bits(&tapped(&slot)), bits(&raw_samples(&path)));
    }

    #[test]
    fn a_preview_plays_at_the_user_volume_while_taken_over() {
        assert_eq!(sink_volume(0.6, true, true), 0.6);
        assert_eq!(sink_volume(0.6, true, false), 0.0);
    }

    #[test]
    fn every_set_volume_site_goes_through_the_helper() {
        let file = include_str!("engine.rs");
        let production = &file[..file.find("#[cfg(test)]").expect("the tests module")];
        let mut current_fn = "";
        let mut sites = Vec::new();
        for line in production.lines() {
            let trimmed = line.trim_start();
            if let Some(rest) = trimmed
                .strip_prefix("fn ")
                .or_else(|| trimmed.strip_prefix("pub fn "))
            {
                current_fn = rest.split(['(', '<']).next().unwrap_or("");
            }
            if trimmed.contains(".set_volume(") {
                assert_eq!(
                    trimmed, "sink.set_volume(self.output_volume());",
                    "a set_volume site in {current_fn} skips output_volume"
                );
                sites.push(current_fn);
            }
        }
        // A new site lands here on purpose: its sink must take output_volume like the rest.
        assert_eq!(
            sites,
            ["start_source", "preview", "load", "seek", "rebind", "handle", "handle"]
        );
    }

    #[test]
    fn the_status_carries_the_takeover_flag() {
        let status = PlayerStatus::default();
        assert!(!status.output_taken_over);
        let json = serde_json::to_value(PlayerStatus {
            output_taken_over: true,
            ..status
        })
        .expect("serializes");
        assert_eq!(json["output_taken_over"], serde_json::Value::Bool(true));
        assert_eq!(json["volume"], serde_json::json!(1.0));
    }
}

// Declared after the tests module: the volume-site test reads the source above the first cfg(test).
#[cfg(test)]
mod dump;
