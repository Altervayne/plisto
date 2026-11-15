/*
 * Local files the user opened, decoded in a helper. The main process opens the file and serves it
 * by position; the helper probes it as library playback probes a file and reports its spec and
 * length in `Opened`. `open_file` waits on the calling thread for the helper's first audio, as
 * library playback waits on its own decoder's open.
 *
 * When the helper cannot be set up at all (the container profile, its grant on `plisto.exe`, or the
 * launch), the caller decodes the file in-process (`session`). A file whose helper failed on its
 * bytes is recorded in the session and never decoded in-process.
 */

// -- Library Imports --
use std::fs::File;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

// -- Local Imports --
use super::bridge::spawn_file;
use super::helper::known_hint;
use crate::audio::stream::pcm::{pcm_queue, PcmReader};
use crate::audio::stream::{DecodeEnd, Fault, StreamControl, WAIT_SLICE};
use crate::audio::AudioSpec;

// -- Module Declarations --
mod session;

// -- Re-exports --
#[cfg(test)]
pub(crate) use session::use_test_session;
pub use session::{file_key, session, FileSession, FILE_SETUP_RETRY_MS};

/// The memory an opened file's decode helper may commit: room for the sample tables of a long
/// audiobook and a large embedded cover, which the stream guards would refuse.
pub const FILE_HELPER_MEMORY_MAX: usize = 1 << 30;

/// How long the helper of an opened file has, once it runs, to report the file and queue its first
/// audio, and to answer a seek with audio. Its watchdog ends a helper that spins or hangs, so this
/// only waits out slow storage.
pub const FILE_OPEN_MS: u64 = 15_000;

/// What the media declared when it opened.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FileInfo {
    pub spec: AudioSpec,
    pub duration_secs: Option<f64>,
}

/// What the bridge reports of one opened file's helper.
#[derive(Default)]
pub struct FileState {
    ready: AtomicBool,
    opened: OnceLock<FileInfo>,
    setup_error: OnceLock<String>,
    end: OnceLock<DecodeEnd>,
    /// The helper's process id, once it runs.
    #[cfg(test)]
    pub(crate) pid: OnceLock<u32>,
    #[cfg(test)]
    pub(super) test: std::sync::Mutex<FileTest>,
}

/// What a test changes in one opened file's launch.
#[cfg(test)]
#[derive(Default)]
pub(super) struct FileTest {
    /// Launched in place of `plisto.exe`.
    pub(super) exe: Option<std::path::PathBuf>,
    /// Receives the helper's peak committed memory once the item ends.
    pub(super) peak: Option<std::sync::mpsc::Sender<usize>>,
}

impl FileState {
    /// The helper sent its `Ready`.
    pub(super) fn launched(&self) {
        self.ready.store(true, Ordering::Release);
    }

    /// The helper could not be set up or launched.
    pub(super) fn setup_failed(&self, error: String) {
        let _ = self.setup_error.set(error);
    }

    /// Takes the helper's `Opened`. False when it already sent one.
    pub(super) fn open(&self, info: FileInfo) -> bool {
        self.opened.set(info).is_ok()
    }
}

/// Whether an end is the helper failing on the file's bytes rather than the file's end, a cancel,
/// a refusal of the format or a launch that never ran.
pub fn is_fault(end: DecodeEnd) -> bool {
    matches!(end, DecodeEnd::Panicked) || matches!(end, DecodeEnd::Isolated(f) if f != Fault::Spawn)
}

/// How `open_file` went.
pub enum Opening {
    /// The helper decodes the file. With a start, the generation of the seek that took it there,
    /// or None when the file had already decoded to its end and plays from the top.
    Isolated(Arc<FileDecode>, Option<u64>),
    /// A start past zero lands at or past the file's end: it plays as a track that ended.
    Ended,
    /// No helper can be set up here: decode the file in-process.
    Unavailable,
    /// The file does not open or does not decode, or its helper ran out of time.
    Refused,
}

/// How a seek on a running helper went.
pub enum Seeked {
    Audio,
    /// The target is at or past the file's end.
    Ended,
    Failed,
}

/// The main process's hold on one opened file's helper. Dropping the last hold cancels the helper.
pub struct FileDecode {
    control: Arc<StreamControl>,
    reader: PcmReader,
    state: Arc<FileState>,
    open_wait: Duration,
    // Set once a failed helper has been reported.
    reported: AtomicBool,
}

impl Drop for FileDecode {
    fn drop(&mut self) {
        self.control.cancel();
    }
}

impl FileDecode {
    pub fn reader(&self) -> &PcmReader {
        &self.reader
    }

    #[cfg(test)]
    pub(crate) fn state(&self) -> &FileState {
        &self.state
    }

    /// What the media declared. Set before `open_file` returns it.
    pub fn info(&self) -> Option<FileInfo> {
        self.state.opened.get().copied()
    }

    /// Ends the helper; its queue takes nothing more.
    pub fn cancel(&self) {
        self.control.cancel();
    }

    /// The helper's end, once it is decided. Everything it queued is in the queue by then.
    pub fn end(&self) -> Option<DecodeEnd> {
        self.state.end.get().copied()
    }

    /// Whether nothing is left in the queue, stale segments included.
    pub fn drained(&self) -> bool {
        self.control.buffered_us.load(Ordering::Acquire) == 0
            && self.control.boundaries.load(Ordering::Acquire) == 0
    }

    /// True once, when the helper ended on a fault and the file was not reported yet.
    pub fn take_fault(&self) -> bool {
        self.end().is_some_and(is_fault) && self.report()
    }

    /// Marks the file reported. True the first time.
    pub fn report(&self) -> bool {
        !self.reported.swap(true, Ordering::AcqRel)
    }

    /// Asks the helper to seek to `secs`. None when it no longer takes seeks: it decoded to the
    /// file's end, or ended.
    pub fn request_seek(&self, secs: f64) -> Option<u64> {
        self.control.request_seek(secs)
    }

    /// Waits for the seek's answer and audio after it, returning as soon as the helper ends.
    pub fn await_seek(&self) -> Seeked {
        let deadline = Instant::now() + self.open_wait;
        while Instant::now() < deadline {
            // Read before the queue: an end seen here means everything the helper queued is in it.
            let end = self.end();
            if !self.control.seek_pending() && self.has_audio() {
                return Seeked::Audio;
            }
            match end {
                Some(DecodeEnd::Finished) => return Seeked::Ended,
                Some(_) => return Seeked::Failed,
                None => thread::sleep(WAIT_SLICE),
            }
        }
        Seeked::Failed
    }

    // Whether audio waits in the queue. While a seek is pending only audio after its answer counts.
    fn has_audio(&self) -> bool {
        self.control.buffered_us.load(Ordering::Acquire) > 0
    }
}

/// Opens `path` in a decode helper, at `start_secs` when one is given, and waits for its first
/// audio: through the helper's launch, then up to `FILE_OPEN_MS`.
pub fn open_file(path: &Path, start_secs: Option<f64>) -> Opening {
    open_with(path, start_secs, Arc::new(FileState::default()))
}

// `open_file`, reporting the helper to `state`.
fn open_with(path: &Path, start_secs: Option<f64>, state: Arc<FileState>) -> Opening {
    let session = session();
    let key = file_key(path);
    // A faulted file is never decoded in-process, whatever keeps its helper from running.
    let in_process = || {
        if session.is_faulted(&key) {
            Opening::Refused
        } else {
            Opening::Unavailable
        }
    };
    if session.setup_down() {
        return in_process();
    }
    let Ok(file) = File::open(path) else {
        return Opening::Refused;
    };
    let hint = path
        .extension()
        .and_then(|e| e.to_str())
        .and_then(|e| known_hint(Some(e.to_ascii_lowercase())));
    let control = Arc::new(StreamControl::new());
    let (queue, reader) = pcm_queue(Arc::clone(&control));
    #[cfg(test)]
    if session.fail_setup.load(Ordering::Acquire) {
        let missing = std::env::temp_dir().join("plisto-no-such-helper.exe");
        state.test.lock().unwrap().exe = Some(missing);
    }
    let (ended, noted, faulted_key) = (Arc::clone(&state), Arc::clone(&session), key.clone());
    session.launching();
    let spawned = spawn_file(
        file,
        hint,
        queue,
        move |end| {
            // Recorded before the end is published, so whoever sees the end sees the record.
            if is_fault(end) {
                noted.mark_faulted(faulted_key);
            }
            let _ = ended.end.set(end);
        },
        Arc::clone(&state),
    );
    if let Err(e) = spawned {
        session.setup_failed(&e.to_string());
        return in_process();
    }
    let decode = Arc::new(FileDecode {
        control,
        reader,
        state,
        open_wait: session.open_wait,
        reported: AtomicBool::new(false),
    });
    match await_launch(&decode.state) {
        Launch::Ready => {}
        Launch::Unavailable(error) => {
            session.setup_failed(&error);
            return in_process();
        }
        Launch::Failed => return Opening::Refused,
    }
    match await_open(&decode, start_secs) {
        Opened::Audio(generation) => Opening::Isolated(decode, generation),
        Opened::Ended => Opening::Ended,
        Opened::Failed => Opening::Refused,
    }
}

enum Launch {
    Ready,
    Unavailable(String),
    Failed,
}

// Waits for the helper's launch, which the session bounds.
fn await_launch(state: &FileState) -> Launch {
    loop {
        if state.ready.load(Ordering::Acquire) {
            return Launch::Ready;
        }
        if state.end.get().is_some() {
            return match state.setup_error.get() {
                Some(error) => Launch::Unavailable(error.clone()),
                None => Launch::Failed,
            };
        }
        thread::sleep(WAIT_SLICE);
    }
}

enum Opened {
    Audio(Option<u64>),
    Ended,
    Failed,
}

// Waits for `Opened` and the first audio, seeking to `start_secs` first, and returns as soon as the
// helper ends. The seek is asked as soon as the helper takes seeks, before it decodes, so it is
// answered even when the whole file decodes at once.
fn await_open(decode: &FileDecode, start_secs: Option<f64>) -> Opened {
    let deadline = Instant::now() + decode.open_wait;
    let mut seek = start_secs;
    let mut generation = None;
    while Instant::now() < deadline {
        // Read before the queue: an end seen here means everything the helper queued is in it.
        let end = decode.end();
        let opened = decode.info().is_some();
        if let Some(secs) = seek {
            if let Some(g) = decode.request_seek(secs) {
                generation = Some(g);
                seek = None;
            } else if opened || end.is_some() {
                // Seeks open before the media does: the file already decoded to its end.
                seek = None;
            }
        }
        let settled = seek.is_none() && !decode.control.seek_pending();
        if opened && settled && decode.has_audio() {
            return Opened::Audio(generation);
        }
        match end {
            // Only a start inside the file can land past its end; a file with no audio at all
            // is refused.
            Some(DecodeEnd::Finished) if start_secs.is_some_and(|s| s > 0.0) => {
                return Opened::Ended
            }
            Some(_) => return Opened::Failed,
            None => thread::sleep(WAIT_SLICE),
        }
    }
    Opened::Failed
}

#[cfg(test)]
mod tests;
