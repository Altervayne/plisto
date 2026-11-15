/*
 * The decode helper: `plisto.exe --plisto-decode-helper`, run inside its AppContainer and job. It
 * reads the `Open` frame, runs the stream decode thread unchanged on a control and queue of its own,
 * and sends what lands in that queue to the main process. A guarded `Open` is a stream item; an
 * unguarded one is a local file the user opened, probed as library playback opens a file, and main
 * is told its spec and length in an `Opened` frame before its first chunk. Its bytes come from main
 * a read at a time through `RemoteSource`, so it holds no byte buffer and opens no file.
 *
 * Three threads. The demux owns the one reader of main's frames for the helper's whole life and
 * routes each frame. The decode thread closes seeks through `Gate`, a round trip to main's control.
 * The forwarder, on the calling thread, turns the local queue into frames. Main's seeks are taken
 * onto the local control under main's generation numbers, each once, so a seek main sends twice is
 * still answered once.
 *
 * When main's pipe closes, every wait here wakes and the helper ends; main kills it through its job
 * in any case.
 */

// -- Library Imports --
use std::io::{self, BufReader, Read, Write};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread;

use crossbeam_channel::{Receiver, RecvTimeoutError, Sender, TryRecvError};
use symphonia::core::io::MediaSource;

// -- Local Imports --
use super::alloc;
use super::remote_source::RemoteSource;
use super::wire::{HelperFrame, MainFrame, MainReader, UncheckedSeam, WireError, CHUNK_FRAMES_MAX};
use crate::audio::stream::decoder::{spawn_gated, SeekGate};
use crate::audio::stream::pcm::{pcm_queue, PcmReader, Segment};
use crate::audio::stream::{DecodeEnd, StreamControl, StreamInput, WAIT_SLICE};
use crate::audio::{AudioSpec, PcmChunk};

/// The probe hints an `Open` can name: a stream item's formats and the extensions of the files
/// Plisto opens. Any other is dropped and the probe decides.
const HINTS: [&str; 9] = [
    "mp3", "aac", "ogg", "flac", "wav", "m4a", "m4b", "oga", "opus",
];

const EXIT_OK: i32 = 0;
/// The helper's own exit when main's pipe broke or named nothing it decodes.
const EXIT_FAILED: i32 = 2;

/// The helper's pipe to the main process. A frame is written whole under its lock.
pub(super) type Outlet = Arc<Mutex<Box<dyn Write + Send>>>;

fn lock(out: &Outlet) -> MutexGuard<'_, Box<dyn Write + Send>> {
    // A frame is written whole or the pipe is broken, so a panic while it was held leaves nothing
    // to repair.
    out.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Writes one frame to the main process.
pub(super) fn send(out: &Outlet, frame: &HelperFrame) -> Result<(), WireError> {
    frame.write(&mut *lock(out))
}

/// Runs the decode helper on its stdin and stdout and returns the exit code.
pub fn run() -> i32 {
    alloc::arm();
    #[cfg(test)]
    if let Some(fault) = super::test_faults::from_args() {
        return super::test_faults::run(fault);
    }
    #[cfg(test)]
    if super::test_faults::guards_off() {
        crate::audio::stream::decoder::GUARDS_OFF.store(true, Ordering::Release);
    }
    serve(io::stdin(), io::stdout())
}

/// The helper's whole run over `input` and `output`, the pipes from and to the main process.
pub(super) fn serve(input: impl Read + Send + 'static, output: impl Write + Send + 'static) -> i32 {
    serve_with(input, output, |source| Box::new(source))
}

/// `serve`, decoding from what `wrap` makes of the byte source.
pub(super) fn serve_with(
    input: impl Read + Send + 'static,
    output: impl Write + Send + 'static,
    wrap: impl FnOnce(RemoteSource) -> Box<dyn MediaSource>,
) -> i32 {
    let out: Outlet = Arc::new(Mutex::new(Box::new(output)));
    if send(&out, &HelperFrame::Ready).is_err() {
        return EXIT_FAILED;
    }
    let mut reader = MainReader::new(BufReader::new(input));
    let Ok(Some(MainFrame::Open {
        hint,
        seekable,
        guarded,
        len,
    })) = reader.read_frame()
    else {
        return EXIT_FAILED;
    };
    // Unguarded media is a local file the user opened, served whole by position.
    if !guarded && !(seekable && len.is_some()) {
        return EXIT_FAILED;
    }

    let control = Arc::new(StreamControl::new());
    let (queue, local) = pcm_queue(Arc::clone(&control));
    let mirror = Arc::new(Mirror {
        control: Arc::clone(&control),
        serial: Mutex::new(()),
    });
    let (reply_tx, replies) = crossbeam_channel::bounded(1);
    let (closed_tx, closed) = crossbeam_channel::bounded(1);
    let demuxed = Arc::clone(&mirror);
    let demux = thread::Builder::new()
        .name("plisto-helper-demux".into())
        .spawn(move || demux(reader, reply_tx, closed_tx, &demuxed));
    if demux.is_err() {
        return EXIT_FAILED;
    }

    let source = RemoteSource::new(Arc::clone(&out), replies, seekable, len);
    let gate = Gate {
        out: Arc::clone(&out),
        control: Arc::clone(&control),
        closed,
        mirror,
        file: !guarded,
    };
    let (source, hint) = (wrap(source), known_hint(hint));
    let input = if guarded {
        StreamInput::Media { source, hint }
    } else {
        StreamInput::File { source, hint }
    };
    let (end_tx, ended) = crossbeam_channel::bounded(1);
    let decode = spawn_gated(input, queue, gate, move |end| {
        let _ = end_tx.send(end);
    });
    if decode.is_err() {
        return EXIT_FAILED;
    }
    forward(&out, &local, &control, &ended)
}

/// The static hint `Open` names, if it is one the probe knows.
pub(super) fn known_hint(hint: Option<String>) -> Option<&'static str> {
    let hint = hint?;
    HINTS.into_iter().find(|known| *known == hint)
}

/// Main's seeks, taken onto the local control one caller at a time.
struct Mirror {
    control: Arc<StreamControl>,
    serial: Mutex<()>,
}

impl Mirror {
    fn take(&self, secs: f64, generation: u64) {
        let _serial = self.serial.lock().unwrap_or_else(PoisonError::into_inner);
        self.control.mirror_seek(secs, generation);
    }
}

// Routes main's frames until its pipe closes or breaks. Dropping the senders then wakes the read
// and the gate waiting on them.
fn demux(
    mut reader: MainReader<BufReader<impl Read>>,
    replies: Sender<MainFrame>,
    closed: Sender<Option<(f64, u64)>>,
    mirror: &Mirror,
) {
    while let Ok(Some(frame)) = reader.read_frame() {
        let routed = match frame {
            MainFrame::Data(_) | MainFrame::Eof | MainFrame::Broken => replies.send(frame).is_ok(),
            MainFrame::Seek { secs, generation } => {
                mirror.take(secs, generation);
                true
            }
            MainFrame::SeeksClosed { pending } => closed.send(pending).is_ok(),
            MainFrame::Open { .. } => false,
        };
        if !routed {
            return;
        }
    }
}

// Whether every segment queued locally has been taken by the forwarder.
fn drained(control: &StreamControl) -> bool {
    control.buffered_us.load(Ordering::Acquire) == 0
        && control.boundaries.load(Ordering::Acquire) == 0
}

/// Seeks as the helper's decode thread sees them: opened and closed on main's control as well as
/// the local one.
struct Gate {
    out: Outlet,
    control: Arc<StreamControl>,
    closed: Receiver<Option<(f64, u64)>>,
    mirror: Arc<Mirror>,
    // A local file: main is told its spec and length before its first chunk.
    file: bool,
}

impl SeekGate for Gate {
    fn opened(&self, spec: AudioSpec, duration_secs: Option<f64>) {
        if !self.file {
            return;
        }
        let opened = HelperFrame::Opened {
            rate: spec.sample_rate,
            channels: spec.channels,
            duration_secs: duration_secs.filter(|d| d.is_finite() && *d >= 0.0),
        };
        // A broken pipe ends the helper at the forwarder's next send.
        let _ = send(&self.out, &opened);
    }

    fn open_seeks(&self) {
        self.control.open_seeks();
        let _ = send(&self.out, &HelperFrame::SeeksOpen);
    }

    /// Main queues its own `End` when it reads `CloseSeeks`, so every segment queued before it is
    /// sent first. Main answers with the seek that got in first, if any, which is then served.
    fn close_at_end(&self) -> bool {
        self.control.close_seeks();
        while !drained(&self.control) {
            if matches!(self.closed.try_recv(), Err(TryRecvError::Disconnected)) {
                return false;
            }
            thread::sleep(WAIT_SLICE);
        }
        if send(&self.out, &HelperFrame::CloseSeeks).is_err() {
            return false;
        }
        match self.closed.recv() {
            Ok(Some((secs, generation))) => self.mirror.take(secs, generation),
            Ok(None) => {}
            Err(_) => return false,
        }
        self.control.seek_pending()
    }

    fn close_on_exit(&self) {
        self.control.close_seeks();
    }
}

// Sends the local queue to main until the decode thread has ended and everything it queued is
// sent, then sends its `End`.
fn forward(
    out: &Outlet,
    local: &PcmReader,
    control: &StreamControl,
    ended: &Receiver<DecodeEnd>,
) -> i32 {
    let mut end = None;
    loop {
        // Taken under the outlet's lock, so a frame the gate writes never overtakes a segment
        // taken before it.
        let sent = {
            let mut w = lock(out);
            local
                .try_next()
                .map(|segment| send_segment(&mut *w, segment))
        };
        match sent {
            Some(Ok(())) => continue,
            Some(Err(_)) => return EXIT_FAILED,
            // Stale segments dropped in this call: more may wait.
            None if !drained(control) => continue,
            None => {}
        }
        if let Some(end) = end {
            return match send(out, &HelperFrame::End(end)) {
                Ok(()) => EXIT_OK,
                Err(_) => EXIT_FAILED,
            };
        }
        match ended.recv_timeout(WAIT_SLICE) {
            Ok(decoded) => end = Some(decoded),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return EXIT_FAILED,
        }
    }
}

// The frames for one segment. A chunk is split to fit `CHUNK_FRAMES_MAX`; the local `End` is
// main's to queue, so it sends nothing.
fn send_segment(w: &mut impl Write, segment: Segment) -> Result<(), WireError> {
    match segment {
        Segment::Chunk(chunk) => {
            let per = CHUNK_FRAMES_MAX as usize * usize::from(chunk.spec.channels.max(1));
            for piece in chunk.samples.chunks(per) {
                let piece = PcmChunk {
                    samples: piece.to_vec(),
                    spec: chunk.spec,
                };
                HelperFrame::Chunk(piece).write(w)?;
            }
            Ok(())
        }
        Segment::Break(seam) => HelperFrame::Break(UncheckedSeam::new(seam)).write(w),
        Segment::End => Ok(()),
    }
}
