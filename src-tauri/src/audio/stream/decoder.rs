/*
 * The stream decode thread: bytes from a byte buffer in, PCM chunks into the stream's `PcmQueue`.
 * It runs on its own thread because every read may wait on the network; the audio thread only ever
 * takes chunks that are already decoded.
 *
 * Containers are opened by the stream path's own opening (`open`, behind the header guard), then
 * decoded by the shared `Decoder` (symphonia, opus-rs for Opus). Raw `pcm_s16le` pushed by a plugin
 * skips symphonia: it has no container. A chained Ogg stream rebuilds the backend in place and
 * marks the seam with a `Break`, as a seek does.
 *
 * Symphonia folds every read failure into its own errors. The thread therefore watches the byte
 * source itself: how the last read went tells a clean end from a broken source from data that
 * stopped decoding. The thread reports how it ended exactly once, a panic included.
 */

// -- Library Imports --
use std::io::{self, Read, Seek, SeekFrom};
use std::panic::{self, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};

use symphonia::core::formats::FormatReader;
use symphonia::core::io::{MediaSource, MediaSourceStream};

// -- Local Imports --
use super::guard::Guarded;
use super::mp4_guard::check_mp4;
use super::open::{open_reader, skip_id3, Trimmed, OPEN_READ_MAX};
use super::pcm::{PcmQueue, PushError, Seam, MIN_CHUNK_FRAMES};
use super::{StreamControl, MAX_CHANNELS, PCM_MAX_CHANNELS, PCM_RATES, RATES};
use crate::audio::decode::{self, Decoder, Pull};
use crate::audio::{AudioSpec, PcmChunk};

/// The most frames in one `pcm_s16le` read.
const PCM_CHUNK_FRAMES: usize = 4_096;

/// The most spec changes in a row, each after less than `MIN_CHUNK_FRAMES` of audio, before a stream
/// is refused: such a stream fills the queue with fragments and never plays.
pub const SPEC_FLIPS_MAX: usize = 16;

/// Why a stream cannot be played. Each maps to the `unsupported` detail of the same name.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Unsupported {
    /// Text, JSON or HTML: not audio.
    ContentType,
    /// A playlist or manifest the plugin must resolve itself.
    Playlist,
    /// No container reader recognizes the bytes, or they declare a spec outside the limits.
    Format,
    /// A container whose codec no backend decodes, or a chained stream that fails to rebuild.
    Codec,
    /// A seek the source could not carry out.
    Seek,
}

/// The format a plugin declares for pushed bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PushFormat {
    Mp3,
    AacAdts,
    /// Vorbis, Opus or FLAC inside.
    Ogg,
    Flac,
    PcmS16le {
        rate: u32,
        channels: u16,
    },
}

/// The probe hint for a response's `content-type`, or the refusal it earns. Parameters and case
/// are ignored; an absent, generic or unknown type gets no hint and the probe decides.
pub fn hint_for_content_type(
    content_type: Option<&str>,
) -> Result<Option<&'static str>, Unsupported> {
    let Some(raw) = content_type else {
        return Ok(None);
    };
    let mime = raw
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let hint = match mime.as_str() {
        "audio/mpeg" | "audio/mp3" => "mp3",
        "audio/aac" | "audio/aacp" | "audio/x-aac" => "aac",
        "audio/ogg" | "application/ogg" | "audio/opus" => "ogg",
        "audio/flac" | "audio/x-flac" => "flac",
        "audio/wav" | "audio/x-wav" | "audio/wave" => "wav",
        "audio/mp4" | "audio/x-m4a" => "m4a",
        "audio/x-mpegurl"
        | "audio/mpegurl"
        | "application/vnd.apple.mpegurl"
        | "application/x-mpegurl"
        | "audio/x-scpls"
        | "application/pls+xml"
        | "application/xspf+xml"
        | "application/dash+xml" => return Err(Unsupported::Playlist),
        "application/json" => return Err(Unsupported::ContentType),
        m if m.starts_with("text/") => return Err(Unsupported::ContentType),
        _ => return Ok(None),
    };
    Ok(Some(hint))
}

/// The probe hint for a pushed format. None for `PcmS16le`, which is never probed.
pub fn hint_for_push(format: PushFormat) -> Option<&'static str> {
    match format {
        PushFormat::Mp3 => Some("mp3"),
        PushFormat::AacAdts => Some("aac"),
        PushFormat::Ogg => Some("ogg"),
        PushFormat::Flac => Some("flac"),
        PushFormat::PcmS16le { .. } => None,
    }
}

/// What the decode thread reads.
pub enum StreamInput {
    /// A container or elementary stream for the probe, with the hint for it.
    Media {
        source: Box<dyn MediaSource>,
        hint: Option<&'static str>,
    },
    /// Interleaved little-endian i16 frames in the declared spec.
    PcmS16le {
        source: Box<dyn Read + Send>,
        spec: AudioSpec,
    },
}

/// How the decode thread ended. Only `Finished` queues `End`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecodeEnd {
    /// The bytes ended cleanly after the writer's `finish`, and everything was decoded.
    Finished,
    /// The stream was cancelled.
    Cancelled,
    /// Every queue reader was dropped.
    ReaderGone,
    /// The byte source broke: its writer went away without `finish`, at any point.
    SourceBroken,
    /// The bytes stopped decoding mid-stream while the source was still open.
    Corrupt,
    /// The decode thread panicked on the bytes.
    Panicked,
    /// The stream cannot be played; nothing more is queued.
    Failed(Unsupported),
    /// The decode helper process failed; nothing more is queued.
    Isolated(Fault),
}

/// How a decode helper failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fault {
    /// The helper could not be set up or started.
    Spawn,
    /// The helper reached its memory cap.
    Memory,
    /// The helper ended some other way without reporting its end.
    Crashed,
    /// The helper used CPU without making progress.
    Spun,
    /// The helper stopped making progress without using CPU.
    Hung,
    /// The helper broke the wire protocol, or exited cleanly without reporting its end.
    Protocol,
}

/// Where the decode thread opens and closes seeks. In-process it is the stream's own control. In
/// the decode helper the close is a round trip that closes seeks on the main process's control, so
/// a seek requested there is still answered or refused, never lost.
pub(super) trait SeekGate: Send + 'static {
    /// Starts taking seek requests.
    fn open_seeks(&self);
    /// Stops taking seek requests once the stream's `End` is queued. True when one got in before
    /// the close and is still unanswered: the `End` is stale and the seek is served first.
    fn close_at_end(&self) -> bool;
    /// Stops taking seek requests as the thread ends, on any path.
    fn close_on_exit(&self);
}

impl SeekGate for Arc<StreamControl> {
    fn open_seeks(&self) {
        StreamControl::open_seeks(self);
    }

    fn close_at_end(&self) -> bool {
        self.close_seeks()
    }

    fn close_on_exit(&self) {
        self.close_seeks();
    }
}

/// Starts the `plisto-stream-decode` thread. It runs until the input ends, the stream is cancelled,
/// every queue reader is dropped, or the input fails, then marks the producer done and hands the
/// reason to `on_end`, once, on every path. When the thread cannot be started, `on_end` is never
/// called.
pub fn spawn_decoder(
    input: StreamInput,
    queue: PcmQueue,
    on_end: impl FnOnce(DecodeEnd) + Send + 'static,
) -> io::Result<JoinHandle<()>> {
    let gate = Arc::clone(queue.control());
    spawn_gated(input, queue, gate, on_end)
}

/// `spawn_decoder` with seeks opened and closed through `gate`.
pub(super) fn spawn_gated(
    input: StreamInput,
    mut queue: PcmQueue,
    gate: impl SeekGate,
    on_end: impl FnOnce(DecodeEnd) + Send + 'static,
) -> io::Result<JoinHandle<()>> {
    thread::Builder::new()
        .name("plisto-stream-decode".into())
        .spawn(move || {
            let control = Arc::clone(queue.control());
            let end = panic::catch_unwind(AssertUnwindSafe(|| match input {
                StreamInput::Media { source, hint } => run_media(source, hint, &mut queue, &gate),
                StreamInput::PcmS16le { source, spec } => run_pcm(source, spec, &mut queue),
            }))
            .unwrap_or(DecodeEnd::Panicked);
            gate.close_on_exit();
            control.set_producer_done();
            on_end(end);
        })
}

// ---- Byte source watch ----

// How the last read of the byte source went.
const READ_OK: u8 = 0;
const READ_ENDED: u8 = 1;
const READ_BROKEN: u8 = 2;

/// What the decode thread knows about its byte source, shared with the wrappers that observe it.
struct Watch {
    last: AtomicU8,
    // A header field or the opening read bound refused the bytes.
    refused: Arc<AtomicBool>,
    // Bytes the source may still hand over before the reads are refused.
    limit: AtomicU64,
}

/// Wraps the byte source to remember how its latest read went and to enforce `Watch::limit`.
struct Watched<S> {
    inner: S,
    watch: Arc<Watch>,
    read: u64,
}

impl<S: Read> Read for Watched<S> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.read >= self.watch.limit.load(Ordering::Acquire) {
            self.watch.refused.store(true, Ordering::Release);
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "no audio within the opening bound",
            ));
        }
        let res = self.inner.read(buf);
        let state = match &res {
            Ok(0) if !buf.is_empty() => READ_ENDED,
            Ok(_) => READ_OK,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => return res,
            Err(_) => READ_BROKEN,
        };
        if let Ok(n) = &res {
            self.read += *n as u64;
        }
        self.watch.last.store(state, Ordering::Release);
        res
    }
}

impl<S: Seek> Seek for Watched<S> {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        let res = self.inner.seek(pos);
        // A seek past the body fails on its own; only a writer gone or a cancel breaks the source.
        if let Err(e) = &res {
            if matches!(
                e.kind(),
                io::ErrorKind::BrokenPipe | io::ErrorKind::ConnectionAborted
            ) {
                self.watch.last.store(READ_BROKEN, Ordering::Release);
            }
        }
        res
    }
}

impl MediaSource for Watched<Box<dyn MediaSource>> {
    fn is_seekable(&self) -> bool {
        self.inner.is_seekable()
    }

    fn byte_len(&self) -> Option<u64> {
        self.inner.byte_len()
    }
}

// ---- Ends ----

fn from_push(err: PushError) -> DecodeEnd {
    match err {
        PushError::Cancelled | PushError::SeekPending => DecodeEnd::Cancelled,
        PushError::ReaderGone => DecodeEnd::ReaderGone,
    }
}

// Queues the end of an unseekable stream, or reports why it cannot be.
fn finish(queue: &mut PcmQueue) -> DecodeEnd {
    if let Some(err) = queue.stopped() {
        return from_push(err);
    }
    match queue.push_end() {
        Ok(()) => DecodeEnd::Finished,
        Err(err) => from_push(err),
    }
}

// How a media stream's end went: done, or a seek arrived first and must be served.
enum Ending {
    Done(DecodeEnd),
    SeekFirst,
}

// Queues the end of a media stream and closes seeks in one step with it: a seek that got in first
// is served before the stream ends, and every later one is refused.
fn finish_media(queue: &mut PcmQueue, gate: &dyn SeekGate) -> Ending {
    if let Some(err) = queue.stopped() {
        return Ending::Done(from_push(err));
    }
    match queue.push_end() {
        Ok(()) => {}
        Err(PushError::SeekPending) => return Ending::SeekFirst,
        Err(err) => return Ending::Done(from_push(err)),
    }
    if gate.close_at_end() {
        // The queued `End` is stale now; the seek's flush drops it.
        gate.open_seeks();
        return Ending::SeekFirst;
    }
    Ending::Done(DecodeEnd::Finished)
}

// Why reading stopped: a cancel or a dropped reader first, then refused bytes, then a broken
// source, then `otherwise`.
fn stopped(queue: &PcmQueue, watch: &Watch, otherwise: DecodeEnd) -> DecodeEnd {
    if let Some(err) = queue.stopped() {
        return from_push(err);
    }
    if watch.refused.load(Ordering::Acquire) {
        return DecodeEnd::Failed(Unsupported::Format);
    }
    if watch.last.load(Ordering::Acquire) == READ_BROKEN {
        return DecodeEnd::SourceBroken;
    }
    otherwise
}

// Whether a declared spec is inside the limits. Zero is undeclared and passes; the first chunk
// is checked again.
fn declared_ok(spec: AudioSpec) -> bool {
    spec.channels <= MAX_CHANNELS && (spec.sample_rate == 0 || RATES.contains(&spec.sample_rate))
}

fn chunk_ok(spec: AudioSpec) -> bool {
    spec.channels >= 1 && spec.channels <= MAX_CHANNELS && RATES.contains(&spec.sample_rate)
}

/// Counts spec changes that come with less than `MIN_CHUNK_FRAMES` of audio between them. The main
/// process counts them again on the chunks a decode helper sends.
#[derive(Default)]
pub(super) struct SpecFlips {
    spec: Option<AudioSpec>,
    frames: usize,
    flips: usize,
}

impl SpecFlips {
    /// False once more than `SPEC_FLIPS_MAX` short runs have come in a row.
    pub(super) fn take(&mut self, spec: AudioSpec, frames: usize) -> bool {
        if self.spec.is_some_and(|s| s != spec) {
            if self.frames < MIN_CHUNK_FRAMES {
                self.flips += 1;
            } else {
                self.flips = 0;
            }
            self.frames = 0;
        }
        self.spec = Some(spec);
        self.frames += frames;
        self.flips <= SPEC_FLIPS_MAX
    }
}

// Whether a seekable source starts with an `ftyp` atom; leaves it at the start.
fn starts_as_mp4<S: Read + Seek>(src: &mut S) -> bool {
    let mut head = [0u8; 8];
    let read = src.read_exact(&mut head).is_ok();
    let rewound = src.seek(SeekFrom::Start(0)).is_ok();
    read && rewound && &head[4..8] == b"ftyp"
}

// ---- Decode loops ----

/// Set only in a test decode helper started with its guards off, so the helper's own wall is what
/// hostile bytes meet.
#[cfg(test)]
pub(super) static GUARDS_OFF: AtomicBool = AtomicBool::new(false);

fn guards_on() -> bool {
    #[cfg(test)]
    return !GUARDS_OFF.load(Ordering::Acquire);
    #[cfg(not(test))]
    true
}

// Opens the container: skips leading ID3 tags, puts the header guard and the opening bound in
// front of symphonia, and picks the reader.
fn open_container(
    source: Box<dyn MediaSource>,
    hint: Option<&'static str>,
    queue: &PcmQueue,
    watch: &Arc<Watch>,
) -> Result<Box<dyn FormatReader>, DecodeEnd> {
    let seekable = source.is_seekable();
    let guarded = guards_on();
    let mut watched = Watched {
        inner: source,
        watch: Arc::clone(watch),
        read: 0,
    };
    let format_error = || stopped(queue, watch, DecodeEnd::Failed(Unsupported::Format));
    // Too many tags, or a source that broke or ended inside one: the stop reason tells which.
    let (base, head) = skip_id3(&mut watched, seekable).map_err(|_| format_error())?;
    if guarded {
        watch
            .limit
            .store(watched.read + OPEN_READ_MAX, Ordering::Release);
    }
    let mut trimmed = Trimmed::new(watched, base, head);
    if guarded && seekable && starts_as_mp4(&mut trimmed) {
        let len = trimmed.byte_len().unwrap_or(0);
        if check_mp4(&mut trimmed, len).is_err() {
            watch.refused.store(true, Ordering::Release);
            return Err(format_error());
        }
        // symphonia reads the walked atoms again: give its opening a fresh budget.
        let read = trimmed.inner().read;
        watch.limit.store(read + OPEN_READ_MAX, Ordering::Release);
    }
    let source: Box<dyn MediaSource> = if guarded {
        Box::new(Guarded::new(trimmed, Arc::clone(&watch.refused)))
    } else {
        Box::new(trimmed)
    };
    let mss = MediaSourceStream::new(source, Default::default());
    let format = open_reader(mss, hint).map_err(|_| format_error())?;
    watch.limit.store(u64::MAX, Ordering::Release);
    Ok(format)
}

fn run_media(
    source: Box<dyn MediaSource>,
    hint: Option<&'static str>,
    queue: &mut PcmQueue,
    gate: &dyn SeekGate,
) -> DecodeEnd {
    let control = Arc::clone(queue.control());
    if source.is_seekable() {
        gate.open_seeks();
    }
    let watch = Arc::new(Watch {
        last: AtomicU8::new(READ_OK),
        refused: Arc::new(AtomicBool::new(false)),
        limit: AtomicU64::new(u64::MAX),
    });
    let format = match open_container(source, hint, queue, &watch) {
        Ok(f) => f,
        Err(end) => return end,
    };
    if !declared_ok(decode::declared_spec(&*format)) {
        return DecodeEnd::Failed(Unsupported::Format);
    }
    let mut decoder = match Decoder::from_format(format) {
        Ok(d) => d,
        Err(_) => return stopped(queue, &watch, DecodeEnd::Failed(Unsupported::Codec)),
    };
    let mut flips = SpecFlips::default();

    loop {
        if let Some((secs, generation)) = control.take_seek() {
            let in_range = match decoder.seek_in_range(secs) {
                Ok(in_range) => in_range,
                Err(_) => return stopped(queue, &watch, DecodeEnd::Failed(Unsupported::Seek)),
            };
            queue.flush();
            if let Err(err) = queue.push_break(Seam::Seek(generation)) {
                return from_push(err);
            }
            control.answer_seek(generation);
            // A target past the end lands on the end.
            if !in_range {
                match finish_media(queue, gate) {
                    Ending::Done(end) => return end,
                    Ending::SeekFirst => continue,
                }
            }
        }
        match decoder.pull() {
            Pull::Chunk(chunk) => {
                if !chunk_ok(chunk.spec) || !flips.take(chunk.spec, chunk.frames()) {
                    return DecodeEnd::Failed(Unsupported::Format);
                }
                // A chunk dropped for a pending seek is stale: the seek runs next.
                match queue.push_chunk(chunk) {
                    Ok(()) | Err(PushError::SeekPending) => {}
                    Err(err) => return from_push(err),
                }
            }
            Pull::Reset => {
                if !declared_ok(decoder.declared_track_spec()) {
                    return DecodeEnd::Failed(Unsupported::Format);
                }
                if decoder.reset_track().is_err() {
                    return stopped(queue, &watch, DecodeEnd::Failed(Unsupported::Codec));
                }
                if let Err(err) = queue.push_break(Seam::Chain) {
                    return from_push(err);
                }
            }
            pulled @ (Pull::End | Pull::Error) => {
                // A cancel, a dropped reader, refused bytes or a broken source say so first.
                let end = stopped(queue, &watch, DecodeEnd::Corrupt);
                if end != DecodeEnd::Corrupt {
                    return end;
                }
                // A seek requested as the bytes ran out still runs: a finite body is all there.
                if control.seek_pending() {
                    continue;
                }
                // A container can stop at the end of its stated length without a read hitting the
                // end of the bytes, so the container's own end counts as clean too.
                let clean =
                    matches!(pulled, Pull::End) || watch.last.load(Ordering::Acquire) == READ_ENDED;
                if !clean {
                    return DecodeEnd::Corrupt;
                }
                match finish_media(queue, gate) {
                    Ending::Done(end) => return end,
                    Ending::SeekFirst => continue,
                }
            }
        }
    }
}

fn run_pcm(mut source: Box<dyn Read + Send>, spec: AudioSpec, queue: &mut PcmQueue) -> DecodeEnd {
    let channels = spec.channels as usize;
    if channels == 0 || spec.channels > PCM_MAX_CHANNELS || !PCM_RATES.contains(&spec.sample_rate) {
        return DecodeEnd::Failed(Unsupported::Format);
    }
    let frame_bytes = channels * 2;
    let mut bytes = vec![0u8; PCM_CHUNK_FRAMES * frame_bytes];
    // Bytes filled at the front of `bytes`; between reads, only a partial frame.
    let mut held = 0;
    loop {
        let n = match source.read(&mut bytes[held..]) {
            Ok(0) => return finish(queue),
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => {
                return match queue.stopped() {
                    Some(err) => from_push(err),
                    None => DecodeEnd::SourceBroken,
                }
            }
        };
        held += n;
        let whole = held / frame_bytes * frame_bytes;
        if whole == 0 {
            continue;
        }
        let samples = bytes[..whole]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|b| i16::from_le_bytes(*b) as f32 / 32_768.0)
            .collect();
        bytes.copy_within(whole..held, 0);
        held -= whole;
        if let Err(err) = queue.push_chunk(PcmChunk { samples, spec }) {
            return from_push(err);
        }
    }
}

#[cfg(test)]
mod tests;
