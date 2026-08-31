/*
 * The resident player engine. It runs on one dedicated thread that owns the audio output for the
 * app's whole life: the frontend never talks to it directly, only through the command channel, and
 * it reports back through a shared status snapshot plus throttled `player:status` events. The output
 * device (rodio's OutputStream) is !Send + !Sync, which is the whole reason the engine is a thread
 * and not a value in AppState - the device is built here, lives here, and drops here when the
 * channel closes at app exit. This is also the only file in the crate that names rodio.
 */

// -- Library Imports --
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use crossbeam_channel::{Receiver, RecvTimeoutError};
use rodio::{OutputStream, Sink, Source};
use tauri::Emitter;

// -- Local Imports --
use super::{decode, AudioSpec, PlayerCmd, PlayerStatus, QueueTrack, RepeatMode};
use crate::scan::progress::ProgressThrottle;

// ---- Decoded source ----

/// Adapts a pull-based `decode::Decoder` into a rodio `Source`: rodio pulls one interleaved f32
/// sample at a time, and this refills from the decoder a packet at a time as it drains. A shared
/// frame counter ticks once per full frame so the engine can read the play position without locking
/// or querying the sink.
struct DecoderSource {
    decoder: decode::Decoder,
    buffer: Vec<f32>,
    pos: usize,
    spec: AudioSpec,
    // Shared with the engine so it reads the play head while the audio thread writes it. Single
    // writer here, read for display only, so Relaxed is the right ordering - not a sync gate.
    frames: Arc<AtomicU64>,
    chan_cursor: u16,
    duration: Option<Duration>,
    done: bool,
}

impl DecoderSource {
    /// Primes the first packet so `channels()`/`sample_rate()` report the real layout immediately,
    /// never zero, and seeds the frame counter to `start_frame` (the resume point after a seek).
    /// Returns None when the stream yields no first packet - an empty or unreadable file.
    fn new(mut decoder: decode::Decoder, start_frame: u64) -> Option<Self> {
        let first = decoder.next_packet()?;
        let duration = decoder
            .duration_secs()
            .filter(|d| d.is_finite() && *d >= 0.0)
            .map(Duration::from_secs_f64);
        Some(Self {
            spec: first.spec,
            buffer: first.samples,
            pos: 0,
            decoder,
            frames: Arc::new(AtomicU64::new(start_frame)),
            chan_cursor: 0,
            duration,
            done: false,
        })
    }
}

impl Iterator for DecoderSource {
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        if self.pos >= self.buffer.len() {
            match self.decoder.next_packet() {
                Some(chunk) => {
                    self.buffer = chunk.samples;
                    self.pos = 0;
                    self.spec = chunk.spec;
                }
                None => {
                    self.done = true;
                    return None;
                }
            }
        }
        // A refilled packet is never empty in practice, but guard the index so a degenerate empty
        // packet ends the stream cleanly instead of panicking on the audio thread.
        if self.pos >= self.buffer.len() {
            self.done = true;
            return None;
        }
        let s = self.buffer[self.pos];
        self.pos += 1;
        self.chan_cursor += 1;
        if self.chan_cursor >= self.spec.channels {
            self.chan_cursor = 0;
            self.frames.fetch_add(1, Ordering::Relaxed);
        }
        Some(s)
    }
}

impl Source for DecoderSource {
    fn current_frame_len(&self) -> Option<usize> {
        // The samples left in the current buffer. None (never Some(0)) at a packet boundary tells
        // rodio to re-read the spec on the next pull, which is where a mid-stream layout change
        // would take effect.
        let rem = self.buffer.len().saturating_sub(self.pos);
        if rem == 0 {
            None
        } else {
            Some(rem)
        }
    }

    fn channels(&self) -> u16 {
        self.spec.channels
    }

    fn sample_rate(&self) -> u32 {
        self.spec.sample_rate
    }

    fn total_duration(&self) -> Option<Duration> {
        self.duration
    }
}

// ---- Pure queue motion ----

/// The next index after `index`, or None when the queue ends and repeat does not loop it. Every
/// cursor move in the engine goes through this - the engine never hand-rolls an index.
pub(crate) fn advance_index(index: usize, len: usize, repeat: RepeatMode) -> Option<usize> {
    if len == 0 {
        return None;
    }
    if index >= len - 1 {
        match repeat {
            RepeatMode::All => Some(0),
            _ => None,
        }
    } else {
        Some(index + 1)
    }
}

/// The previous index, saturating at the first track. None only when the queue is empty.
pub(crate) fn prev_index(index: usize, len: usize) -> Option<usize> {
    if len == 0 {
        None
    } else {
        Some(index.saturating_sub(1))
    }
}

/// What to do when a track finishes on its own.
pub(crate) enum EndAction {
    Replay,
    Advance(usize),
    Stop,
}

/// Resolves a natural track-end into an action: repeat-one replays in place, otherwise it advances
/// (looping the queue under repeat-all) or stops at the end.
pub(crate) fn on_track_end(index: usize, len: usize, repeat: RepeatMode) -> EndAction {
    if let RepeatMode::One = repeat {
        return EndAction::Replay;
    }
    match advance_index(index, len, repeat) {
        Some(i) => EndAction::Advance(i),
        None => EndAction::Stop,
    }
}

// ---- The resident engine ----

/// All playback state, single-owner on the audio thread and never locked. `_stream` is held only to
/// keep the device alive - dropping it silences output - and it is what forces this struct to stay
/// on its thread. `sink` is None when the device failed to open; every transport then no-ops.
struct Engine {
    _stream: Option<OutputStream>,
    sink: Option<Sink>,
    queue: Vec<QueueTrack>,
    index: usize,
    repeat: RepeatMode,
    paused: bool,
    playing: bool,
    volume: f32,
    cur_frames: Option<Arc<AtomicU64>>,
    cur_rate: u32,
    cur_duration: f64,
    cur_track_id: Option<i64>,
    status: Arc<Mutex<PlayerStatus>>,
    app: tauri::AppHandle,
    throttle: ProgressThrottle,
}

impl Engine {
    /// Builds the current snapshot from engine-local state. Position is derived from the shared
    /// frame counter over the source's sample rate, so it advances without polling the sink.
    fn snapshot(&self) -> PlayerStatus {
        let position_secs = match (&self.cur_frames, self.cur_rate) {
            (Some(frames), rate) if rate > 0 => frames.load(Ordering::Relaxed) as f64 / rate as f64,
            _ => 0.0,
        };
        PlayerStatus {
            // `playing` here means actively producing sound, so a paused track reports false - the UI
            // reads it for the play/pause glyph. Whether a track session is loaded is `track_id`, not
            // this. Internally `self.playing` is the session flag and `self.paused` the pause within it.
            playing: self.playing && !self.paused,
            track_id: self.cur_track_id,
            position_secs,
            duration_secs: self.cur_duration,
            volume: self.volume,
            repeat: self.repeat,
            queue_index: self.index,
            queue_len: self.queue.len(),
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

    /// Loads and starts the track at `start`, skipping FORWARD over any that fail to open (missing
    /// file, unsupported/Opus) until one plays or the queue exhausts and playback stops. Emits a
    /// forced status on either outcome.
    fn play_at(&mut self, start: usize) {
        let mut i = start;
        loop {
            if i >= self.queue.len() {
                self.stop_playback();
                self.emit(true);
                return;
            }
            match decode::Decoder::open(&self.queue[i].path) {
                Ok(dec) => match DecoderSource::new(dec, 0) {
                    Some(src) => {
                        self.start_source(i, src);
                        self.emit(true);
                        return;
                    }
                    None => i += 1,
                },
                Err(_) => i += 1,
            }
        }
    }

    /// Reseats engine state onto `src` and hands it to the sink. Reads the shared counter, rate and
    /// duration off the source before it is moved into the sink; with no device the state still
    /// updates so the snapshot is coherent, only the append is skipped.
    fn start_source(&mut self, i: usize, src: DecoderSource) {
        self.index = i;
        self.cur_frames = Some(Arc::clone(&src.frames));
        self.cur_rate = src.spec.sample_rate;
        self.cur_duration = src.duration.map(|d| d.as_secs_f64()).unwrap_or(0.0);
        self.cur_track_id = Some(self.queue[i].id);
        if let Some(sink) = &self.sink {
            sink.clear();
            sink.append(src);
            sink.set_volume(self.volume);
            sink.play();
        }
        self.paused = false;
        self.playing = true;
    }

    /// Stops playback and clears the current-track state. The sink is emptied so the next play
    /// starts clean.
    fn stop_playback(&mut self) {
        if let Some(sink) = &self.sink {
            sink.clear();
        }
        self.playing = false;
        self.paused = false;
        self.cur_frames = None;
        self.cur_rate = 0;
        self.cur_duration = 0.0;
        self.cur_track_id = None;
    }

    /// Reopens the current file, seeks to `secs`, and restarts the source there while preserving the
    /// paused state. A missing file or a seek failure leaves playback untouched.
    fn seek(&mut self, secs: f64) {
        let path = match self.queue.get(self.index) {
            Some(t) if self.cur_track_id.is_some() => t.path.clone(),
            _ => return,
        };
        let mut dec = match decode::Decoder::open(&path) {
            Ok(d) => d,
            Err(_) => return,
        };
        if dec.seek(secs).is_err() {
            return;
        }
        let rate = self.cur_rate;
        let start_frame = if rate > 0 {
            (secs.max(0.0) * rate as f64).floor() as u64
        } else {
            0
        };
        let src = match DecoderSource::new(dec, start_frame) {
            Some(s) => s,
            None => return,
        };
        self.cur_frames = Some(Arc::clone(&src.frames));
        self.cur_rate = src.spec.sample_rate;
        if let Some(sink) = &self.sink {
            sink.clear();
            sink.append(src);
            sink.set_volume(self.volume);
            if self.paused {
                sink.pause();
            } else {
                sink.play();
            }
        }
        self.emit(true);
    }

    /// Applies one transport command, then emits a forced status since every command changes state.
    fn handle(&mut self, cmd: PlayerCmd) {
        match cmd {
            PlayerCmd::Play { queue, index } => {
                self.queue = queue;
                let start = index.min(self.queue.len().saturating_sub(1));
                // play_at emits its own forced status on success or exhaustion.
                self.play_at(start);
            }
            PlayerCmd::TogglePlay => {
                if let Some(sink) = &self.sink {
                    if self.paused {
                        sink.play();
                    } else {
                        sink.pause();
                    }
                }
                self.paused = !self.paused;
                self.emit(true);
            }
            PlayerCmd::Pause => {
                if let Some(sink) = &self.sink {
                    sink.pause();
                }
                self.paused = true;
                self.emit(true);
            }
            PlayerCmd::Resume => {
                if let Some(sink) = &self.sink {
                    sink.play();
                }
                self.paused = false;
                self.emit(true);
            }
            PlayerCmd::Stop => {
                self.stop_playback();
                self.emit(true);
            }
            PlayerCmd::Next => match advance_index(self.index, self.queue.len(), self.repeat) {
                Some(i) => self.play_at(i),
                None => {
                    self.stop_playback();
                    self.emit(true);
                }
            },
            PlayerCmd::Prev => match prev_index(self.index, self.queue.len()) {
                Some(i) => self.play_at(i),
                None => {
                    self.stop_playback();
                    self.emit(true);
                }
            },
            PlayerCmd::Seek(secs) => self.seek(secs),
            PlayerCmd::SetVolume(v) => {
                self.volume = v.clamp(0.0, 1.0);
                if let Some(sink) = &self.sink {
                    sink.set_volume(self.volume);
                }
                self.emit(true);
            }
            PlayerCmd::SetRepeat(m) => {
                self.repeat = m;
                self.emit(true);
            }
        }
    }

    /// The idle tick between commands: detects a track that played out and moves the queue, then
    /// writes a periodic status. An unplugged device mid-play is not handled here - `sink.empty()`
    /// reads as track-end, and reopening a lost device is a later slice.
    fn tick(&mut self) {
        if self.playing && !self.paused && self.sink.as_ref().map_or(false, |s| s.empty()) {
            match on_track_end(self.index, self.queue.len(), self.repeat) {
                EndAction::Replay => self.play_at(self.index),
                EndAction::Advance(i) => self.play_at(i),
                EndAction::Stop => self.stop_playback(),
            }
        }
        self.emit(false);
    }
}

/// Spawns the resident player thread and returns its handle. The thread builds the output device,
/// then loops on the command channel until every Sender drops at app exit, when it breaks and the
/// device drops with it. Not meant to be joined - it is a daemon that dies with the channel.
pub fn spawn(
    rx: Receiver<PlayerCmd>,
    status: Arc<Mutex<PlayerStatus>>,
    app: tauri::AppHandle,
) -> JoinHandle<()> {
    thread::Builder::new()
        .name("plisto-player".to_string())
        .spawn(move || run(rx, status, app))
        .expect("player thread spawns")
}

/// The thread body. Builds the device (emitting `player:error` and running device-less on failure,
/// never panicking), then services commands on a short timeout so the idle tick can catch a
/// track-end even when no command arrives.
fn run(rx: Receiver<PlayerCmd>, status: Arc<Mutex<PlayerStatus>>, app: tauri::AppHandle) {
    let (stream, sink) = match OutputStream::try_default() {
        Ok((stream, handle)) => match Sink::try_new(&handle) {
            Ok(sink) => (Some(stream), Some(sink)),
            Err(e) => {
                let message = format!("audio output is unavailable: {e}");
                let _ = app.emit("player:error", &message);
                (None, None)
            }
        },
        Err(e) => {
            let message = format!("audio output is unavailable: {e}");
            let _ = app.emit("player:error", &message);
            (None, None)
        }
    };

    let mut engine = Engine {
        _stream: stream,
        sink,
        queue: Vec::new(),
        index: 0,
        repeat: RepeatMode::Off,
        paused: false,
        playing: false,
        volume: 1.0,
        cur_frames: None,
        cur_rate: 0,
        cur_duration: 0.0,
        cur_track_id: None,
        status,
        app,
        throttle: ProgressThrottle::new(200),
    };

    loop {
        match rx.recv_timeout(Duration::from_millis(120)) {
            Ok(cmd) => engine.handle(cmd),
            Err(RecvTimeoutError::Timeout) => engine.tick(),
            // Every Sender dropped: the app is exiting. Break so the sink and stream drop cleanly.
            Err(RecvTimeoutError::Disconnected) => break,
        }
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
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::AtomicU32;

    // ---- Pure queue motion ----

    #[test]
    fn advance_stops_at_end_when_off() {
        assert_eq!(advance_index(2, 3, RepeatMode::Off), None);
    }

    #[test]
    fn advance_loops_at_end_when_all() {
        assert_eq!(advance_index(2, 3, RepeatMode::All), Some(0));
    }

    #[test]
    fn advance_stops_at_end_when_one() {
        // Repeat-one never advances the queue; on_track_end handles the replay instead.
        assert_eq!(advance_index(2, 3, RepeatMode::One), None);
    }

    #[test]
    fn advance_steps_forward_in_the_middle() {
        assert_eq!(advance_index(0, 3, RepeatMode::Off), Some(1));
    }

    #[test]
    fn advance_on_empty_queue_is_none() {
        assert_eq!(advance_index(0, 0, RepeatMode::All), None);
    }

    #[test]
    fn prev_saturates_at_the_first_track() {
        assert_eq!(prev_index(0, 3), Some(0));
    }

    #[test]
    fn prev_steps_back() {
        assert_eq!(prev_index(2, 3), Some(1));
    }

    #[test]
    fn prev_on_empty_queue_is_none() {
        assert_eq!(prev_index(0, 0), None);
    }

    #[test]
    fn track_end_replays_under_repeat_one() {
        assert!(matches!(on_track_end(1, 3, RepeatMode::One), EndAction::Replay));
    }

    #[test]
    fn track_end_loops_under_repeat_all() {
        assert!(matches!(
            on_track_end(2, 3, RepeatMode::All),
            EndAction::Advance(0)
        ));
    }

    #[test]
    fn track_end_stops_at_the_end_when_off() {
        assert!(matches!(on_track_end(2, 3, RepeatMode::Off), EndAction::Stop));
    }

    #[test]
    fn track_end_advances_in_the_middle() {
        assert!(matches!(
            on_track_end(0, 3, RepeatMode::Off),
            EndAction::Advance(1)
        ));
    }

    // ---- DecoderSource frame counting ----

    // A unique throwaway directory under the system temp dir, removed on drop.
    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new(tag: &str) -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "plisto_engine_{tag}_{}_{n}_{nanos}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self { path }
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    // A canonical 16-bit PCM WAV: the 44-byte header plus interleaved little-endian i16 frames,
    // ramping so the decoded signal is known and in range. Mirrors the decoder test's helper.
    fn write_wav(path: &Path, rate: u32, channels: u16, frames: usize) {
        let bits = 16u16;
        let block_align = channels * bits / 8;
        let byte_rate = rate * block_align as u32;
        let data_len = (frames * channels as usize * (bits / 8) as usize) as u32;

        let mut v = Vec::with_capacity(44 + data_len as usize);
        v.extend_from_slice(b"RIFF");
        v.extend_from_slice(&(36 + data_len).to_le_bytes());
        v.extend_from_slice(b"WAVE");
        v.extend_from_slice(b"fmt ");
        v.extend_from_slice(&16u32.to_le_bytes());
        v.extend_from_slice(&1u16.to_le_bytes()); // PCM
        v.extend_from_slice(&channels.to_le_bytes());
        v.extend_from_slice(&rate.to_le_bytes());
        v.extend_from_slice(&byte_rate.to_le_bytes());
        v.extend_from_slice(&block_align.to_le_bytes());
        v.extend_from_slice(&bits.to_le_bytes());
        v.extend_from_slice(b"data");
        v.extend_from_slice(&data_len.to_le_bytes());

        for frame in 0..frames {
            let phase = (frame % 200) as i32 - 100;
            let sample = (phase * 300) as i16;
            for _ in 0..channels {
                v.extend_from_slice(&sample.to_le_bytes());
            }
        }

        fs::write(path, v).unwrap();
    }

    #[test]
    fn decoder_source_counts_one_frame_per_channel_group() {
        let dir = TempDir::new("count");
        let path = dir.path.join("tone.wav");
        let (rate, channels, frames) = (44_100u32, 2u16, 2_000usize);
        write_wav(&path, rate, channels, frames);

        let dec = decode::Decoder::open(&path).expect("opens the WAV");
        let src = DecoderSource::new(dec, 0).expect("primes the first packet");
        assert_eq!(src.channels(), channels);
        assert_eq!(src.sample_rate(), rate);

        let counter = Arc::clone(&src.frames);
        let samples: Vec<f32> = src.collect();
        assert_eq!(samples.len(), frames * channels as usize);
        assert_eq!(counter.load(Ordering::Relaxed), frames as u64);
    }

    #[test]
    fn decoder_source_seeds_the_start_frame() {
        let dir = TempDir::new("seed");
        let path = dir.path.join("tone.wav");
        let (rate, channels, frames) = (44_100u32, 2u16, 1_000usize);
        write_wav(&path, rate, channels, frames);

        let dec = decode::Decoder::open(&path).expect("opens the WAV");
        let src = DecoderSource::new(dec, 500).expect("primes the first packet");
        assert_eq!(src.frames.load(Ordering::Relaxed), 500);

        let counter = Arc::clone(&src.frames);
        let _: Vec<f32> = src.collect();
        // Draining from the seed advances the counter by the file's frame count.
        assert_eq!(counter.load(Ordering::Relaxed), 500 + frames as u64);
    }
}
