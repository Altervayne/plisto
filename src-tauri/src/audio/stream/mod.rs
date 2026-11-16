/*
 * Playback of audio that arrives as bytes over time instead of from a file. Bytes land in a byte
 * buffer (`bytes`), a dedicated decode thread (`decoder`) turns them into PCM, and the PCM waits in a
 * bounded queue (`pcm`) the audio thread drains without blocking. A network read can stall for
 * seconds, so nothing on the audio thread ever waits on bytes: an empty queue reads as starved.
 *
 * One `StreamControl` is shared by every party of one stream: the byte buffers, the decode thread,
 * the queue and the engine. Cancel is a flag every blocking wait re-checks at least every
 * `WAIT_SLICE`, so a cancel ends every wait without anyone having to know who is waiting.
 *
 * Container bytes are decoded in a helper process (`isolate`) so a decoder fault on hostile bytes
 * ends one item instead of the app. The engine sees the same queue and control in both modes.
 */

// -- Library Imports --
use std::io;
use std::ops::RangeInclusive;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::thread::JoinHandle;
use std::time::Duration;

// -- Module Declarations --
pub mod bytes;
mod comment_check;
pub mod decoder;
mod guard;
pub mod icy;
pub(crate) mod isolate;
mod mp4_guard;
mod ogg_guard;
mod open;
pub mod pcm;
mod vorbis_setup;

#[cfg(test)]
mod test_containers;
#[cfg(test)]
mod test_media;

// -- Re-exports --
pub use bytes::{
    byte_ring, growing_buffer, ByteRing, GrowingBuffer, GrowingWriter, RingWriter, WriteError,
};
pub use decoder::{
    hint_for_content_type, hint_for_push, spawn_decoder, DecodeEnd, Fault, PushFormat,
    StreamInput, Unsupported, SPEC_FLIPS_MAX,
};
pub use isolate::bridge::spawn_isolated;
pub use guard::{FLAC_SEEKTABLE_MAX, WAV_BLOCK_ALIGN_MAX, WAV_INFO_MAX};
pub use icy::{IcyStripper, ICY_METAINT_MAX};
pub use mp4_guard::{
    ALAC_FRAME_MAX, LPCM_FRAMES_MAX, MOOV_MAX, MP4_BOX_MAX, MP4_EDITS_MAX, MP4_ENTRIES_MAX,
    MP4_ITEM_MAX, MP4_SAMPLE_MAX,
};
pub use ogg_guard::{OGG_PACKET_MAX, OGG_SERIALS_MAX, OGG_STREAMS_MAX, VORBIS_SETUP_TOTAL_MAX};
pub use open::{ID3_SKIP_MAX, ID3_TAGS_MAX, OPEN_READ_MAX, SYNC_SEARCH_MAX};
pub use pcm::{pcm_queue, PcmQueue, PcmReader, PushError, Seam, Segment, MIN_CHUNK_FRAMES};
pub use vorbis_setup::{
    VORBIS_BOOK_BLOCKS_MAX, VORBIS_BOOK_VALUES_MAX, VORBIS_ENTRIES_MAX, VORBIS_SETUP_BLOCKS_MAX,
    VORBIS_SETUP_ENTRIES_MAX, VORBIS_SETUP_MAX, VORBIS_SETUP_VALUES_MAX,
};

// ---- Bytes ----

/// The byte ring of a live or push item: about 26 s of 320 kbps MP3.
pub const LIVE_RING: usize = 1 << 20;

/// The largest finite body kept whole in a `GrowingBuffer`; a longer one plays from a ring.
pub const FINITE_MAX: u64 = 128 << 20;

// ---- PCM queue ----

/// The most audio the queue holds: the decode thread blocks while its next chunk would pass it.
pub const PCM_MAX_MS: u64 = 4_000;

/// Audio queued before the first sample plays.
pub const START_MS: u64 = 1_500;

/// Audio queued before a starved item leaves buffering.
pub const REBUFFER_MS: u64 = 2_500;

// ---- Connection and stall limits ----

/// No response head within this long ends the connection attempt.
pub const HEADERS_TIMEOUT_MS: u64 = 15_000;

/// No byte from the server for this long while the buffer has room.
pub const IDLE_MS: u64 = 30_000;

/// From accept, or from a reconnect, to the first decoded chunk.
pub const NO_AUDIO_MS: u64 = 20_000;

/// How long an item may make no progress before it ends `stalled`: continuous buffering with no way
/// left to recover, or a decode helper owing main audio for this long.
pub const STALL_MS: u64 = 30_000;

/// The waits before each reconnect of a live pull item; their count is the most in a row.
pub const RECONNECT_BACKOFF_MS: [u64; 4] = [1_000, 2_000, 4_000, 8_000];

/// Playing this long resets the reconnect count.
pub const RECONNECT_RESET_MS: u64 = 60_000;

/// A paused live item keeps its connection this long while the ring has room.
pub const LIVE_PAUSE_HOLD_MS: u64 = 60_000;

// ---- Spec limits ----

/// Channel counts a decoded stream may declare. Anything else is refused before a decoder sizes
/// its buffers from it.
pub const MAX_CHANNELS: u16 = 8;

/// Sample rates a decoded stream may declare.
pub const RATES: RangeInclusive<u32> = 8_000..=384_000;

/// Channel counts a plugin may declare for pushed `pcm_s16le`.
pub const PCM_MAX_CHANNELS: u16 = 2;

/// Sample rates a plugin may declare for pushed `pcm_s16le`.
pub const PCM_RATES: RangeInclusive<u32> = 8_000..=192_000;

// ---- Decode helper ----

/// The memory a stream item's decode helper may commit. An allocation past it ends the helper with
/// `EXIT_MEMORY`.
pub const HELPER_MEMORY_MAX: usize = 256 << 20;

/// The helper's CPU credit, and where it starts: CPU it may spend beyond what it has earned before
/// it is killed as spinning.
#[cfg(not(debug_assertions))]
pub const SPIN_CPU_MS: u64 = 2_000;
/// `SPIN_CPU_MS` in an unoptimized build, whose decoder spends about 2 s of CPU opening a legitimate
/// Ogg with a near-cap cover where the optimized one spends about 0.1 s.
#[cfg(debug_assertions)]
pub const SPIN_CPU_MS: u64 = 8_000;

/// The helper CPU per second of wall time it earns whatever it does: a helper that only waits, with
/// its queue full or a read outstanding, polls well under it.
pub const SPIN_IDLE_MS_PER_SEC: u64 = 30;

/// The helper CPU per second of audio main accepts that it earns.
#[cfg(not(debug_assertions))]
pub const SPIN_AUDIO_MS_PER_SEC: u64 = 1_000;
/// `SPIN_AUDIO_MS_PER_SEC` in an unoptimized build, whose decoder is several times slower.
#[cfg(debug_assertions)]
pub const SPIN_AUDIO_MS_PER_SEC: u64 = 4_000;

/// Seconds a helper's stall debt shrinks by per second of audio main accepts: a helper that delivers
/// at least a tenth of real time is never hung.
pub const STALL_AUDIO_PAYBACK: u32 = 10;

/// Which helper decodes an item.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HelperKind {
    /// A plugin stream item, behind the header guards.
    Stream,
}

/// Where an item's container bytes are decoded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecodeMode {
    Isolated(HelperKind),
    InProcess,
}

/// Starts decoding `input` into `queue`, as `spawn_decoder` does. Container bytes go to a helper
/// process when `mode` is `Isolated`; `pcm_s16le` has no container and always converts in-process.
pub fn start_decode(
    input: StreamInput,
    queue: PcmQueue,
    on_end: impl FnOnce(DecodeEnd) + Send + 'static,
    mode: DecodeMode,
) -> io::Result<JoinHandle<()>> {
    match (mode, input) {
        (DecodeMode::Isolated(HelperKind::Stream), StreamInput::Media { source, hint }) => {
            spawn_isolated(StreamInput::Media { source, hint }, queue, on_end)
        }
        (_, input) => spawn_decoder(input, queue, on_end),
    }
}

// ---- Shared control ----

/// The longest any blocking wait of a stream sleeps before it re-checks cancel.
pub(crate) const WAIT_SLICE: Duration = Duration::from_millis(5);

// Set in the seek word while seeks are taken: the source is seekable and its decode thread has not
// decided to end. The rest of the word is the newest generation requested.
const SEEKS_OPEN: u64 = 1 << 63;

/// The flags and counters one stream's parties share. Every member is an atomic, so the audio thread
/// reads and writes it without a lock.
///
/// Seeks are numbered. `request_seek` takes the next generation; the decode thread answers the
/// newest one with a `Break` carrying it. From the request until that answer the queue reads as
/// empty and not ready, and the reader drops what was queued before it. Requests are refused once
/// the decode thread closes them, in the same atomic step that tells it whether one got in first,
/// so a seek is either answered or refused, never lost.
pub struct StreamControl {
    cancel: AtomicBool,
    starved: AtomicBool,
    producer_done: AtomicBool,
    seek_to: AtomicU64,
    // `SEEKS_OPEN` and the newest generation requested.
    seek_word: AtomicU64,
    // The newest generation answered with a `Break`. Equal to the requested one when none is pending.
    seek_answered: AtomicU64,
    // Queued audio in microseconds, summed per chunk at its own rate so a rate change mid-stream
    // still reads true.
    buffered_us: AtomicU64,
    // `Break` and `End` segments queued and not yet taken.
    boundaries: AtomicU32,
    // The item's end is decided: the byte buffers' reads stop as if cancelled.
    source_closed: AtomicBool,
    // Chunks ever queued. Never decreases, so a watcher tells whether audio arrived since it looked.
    chunks_queued: AtomicU64,
    // Set once the decoder opened the media.
    media_reported: AtomicBool,
    // The media's length in seconds as its container states it, as f64 bits; `NO_LENGTH` when
    // unknown. Unchecked: whoever shows it checks it.
    media_secs: AtomicU64,
}

// `media_secs` before a length is known, or when the container states none.
const NO_LENGTH: u64 = u64::MAX;

impl Default for StreamControl {
    fn default() -> Self {
        Self {
            cancel: AtomicBool::new(false),
            starved: AtomicBool::new(false),
            producer_done: AtomicBool::new(false),
            seek_to: AtomicU64::new(0),
            seek_word: AtomicU64::new(0),
            seek_answered: AtomicU64::new(0),
            buffered_us: AtomicU64::new(0),
            boundaries: AtomicU32::new(0),
            source_closed: AtomicBool::new(false),
            chunks_queued: AtomicU64::new(0),
            media_reported: AtomicBool::new(false),
            media_secs: AtomicU64::new(NO_LENGTH),
        }
    }
}

impl StreamControl {
    pub fn new() -> Self {
        Self::default()
    }

    /// Ends the stream: every blocked byte read, queue push and decode step returns within one
    /// `WAIT_SLICE`. Never undone.
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::Release);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::Acquire)
    }

    /// Ends every blocked byte buffer read, as a cancel does, without cancelling the stream: the
    /// decoding has ended and nothing reads the source again. Never undone, so a control whose
    /// source is closed cannot serve a second decode.
    pub(crate) fn close_source(&self) {
        self.source_closed.store(true, Ordering::Release);
    }

    /// Whether a byte buffer read stops: the stream is cancelled or its source closed.
    pub(crate) fn reads_stopped(&self) -> bool {
        self.is_cancelled() || self.source_closed.load(Ordering::Acquire)
    }

    /// Set by the audio thread when it found the queue empty, cleared when it plays again.
    pub fn set_starved(&self, starved: bool) {
        self.starved.store(starved, Ordering::Relaxed);
    }

    pub fn is_starved(&self) -> bool {
        self.starved.load(Ordering::Relaxed)
    }

    /// Asks the decode thread to seek to `secs` and returns the seek's generation: the `Break` that
    /// answers it carries the same number. A newer request supersedes one not yet answered. None,
    /// and nothing changes, when the source is unseekable or its decode thread has not started or
    /// has decided to end.
    pub fn request_seek(&self, secs: f64) -> Option<u64> {
        if self.seek_word.load(Ordering::Acquire) & SEEKS_OPEN == 0 {
            return None;
        }
        self.seek_to
            .store(secs.max(0.0).to_bits(), Ordering::Release);
        let mut word = self.seek_word.load(Ordering::Acquire);
        loop {
            if word & SEEKS_OPEN == 0 {
                return None;
            }
            match self.seek_word.compare_exchange_weak(
                word,
                word + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return Some((word + 1) & !SEEKS_OPEN),
                Err(now) => word = now,
            }
        }
    }

    /// Whether a requested seek has no `Break` queued yet.
    pub fn seek_pending(&self) -> bool {
        self.requested() != self.answered()
    }

    /// How many chunks of decoded audio have entered the queue since the stream began.
    pub fn chunks_queued(&self) -> u64 {
        self.chunks_queued.load(Ordering::Acquire)
    }

    /// Records what the decoder learned when it opened the media: its length when the container
    /// states one. False when it was already reported; the first report stands.
    pub fn report_media(&self, duration_secs: Option<f64>) -> bool {
        if self.media_reported.swap(true, Ordering::AcqRel) {
            return false;
        }
        if let Some(secs) = duration_secs {
            self.media_secs.store(secs.to_bits(), Ordering::Release);
        }
        true
    }

    /// The media's length as reported, unchecked; None while unknown.
    pub fn media_secs(&self) -> Option<f64> {
        let bits = self.media_secs.load(Ordering::Acquire);
        (bits != NO_LENGTH).then(|| f64::from_bits(bits))
    }

    /// Whether the decode thread has ended, by any path. An empty queue then never refills.
    pub fn is_producer_done(&self) -> bool {
        self.producer_done.load(Ordering::Acquire)
    }

    /// The audio waiting in the queue; zero while a seek is pending. Lock-free.
    pub fn buffered_ms(&self) -> u64 {
        if self.seek_pending() {
            return 0;
        }
        self.buffered_us.load(Ordering::Acquire) / 1_000
    }

    /// Whether a `Break` or an `End` is queued: the queue then holds all the audio there is to wait
    /// for, whatever its length. False while a seek is pending.
    pub fn has_boundary(&self) -> bool {
        !self.seek_pending() && self.boundaries.load(Ordering::Acquire) > 0
    }

    /// Whether the queue holds enough to play: `threshold_ms` of audio, or a boundary. False while a
    /// seek is pending.
    pub fn is_ready(&self, threshold_ms: u64) -> bool {
        self.has_boundary() || (!self.seek_pending() && self.buffered_ms() >= threshold_ms)
    }

    pub(crate) fn requested(&self) -> u64 {
        self.seek_word.load(Ordering::Acquire) & !SEEKS_OPEN
    }

    pub(crate) fn answered(&self) -> u64 {
        self.seek_answered.load(Ordering::Acquire)
    }

    /// Starts taking seek requests.
    pub(crate) fn open_seeks(&self) {
        self.seek_word.fetch_or(SEEKS_OPEN, Ordering::AcqRel);
    }

    /// Stops taking seek requests. True when one got in before the close and is still unanswered.
    pub(crate) fn close_seeks(&self) -> bool {
        let prev = self.seek_word.fetch_and(!SEEKS_OPEN, Ordering::AcqRel);
        prev & !SEEKS_OPEN != self.answered()
    }

    pub(crate) fn set_producer_done(&self) {
        self.producer_done.store(true, Ordering::Release);
    }

    /// The newest unanswered seek: its target and generation. The target is read after the
    /// generation, so it is at least as new.
    pub(crate) fn take_seek(&self) -> Option<(f64, u64)> {
        let generation = self.requested();
        if generation == self.answered() {
            return None;
        }
        let secs = f64::from_bits(self.seek_to.load(Ordering::Acquire));
        Some((secs, generation))
    }

    pub(crate) fn answer_seek(&self, generation: u64) {
        self.seek_answered.store(generation, Ordering::Release);
    }

    /// Takes a seek requested on another control under that control's generation, whether seeks
    /// are open here or not. A generation no newer than the newest taken is ignored, so a seek
    /// that arrives twice is answered once. Callers serialize their calls, so an older seek never
    /// overwrites a newer one's target.
    pub(crate) fn mirror_seek(&self, secs: f64, generation: u64) -> bool {
        if generation & SEEKS_OPEN != 0 || generation <= self.requested() {
            return false;
        }
        self.seek_to
            .store(secs.max(0.0).to_bits(), Ordering::Release);
        let mut word = self.seek_word.load(Ordering::Acquire);
        loop {
            if generation <= word & !SEEKS_OPEN {
                return false;
            }
            match self.seek_word.compare_exchange_weak(
                word,
                (word & SEEKS_OPEN) | generation,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return true,
                Err(now) => word = now,
            }
        }
    }
}
