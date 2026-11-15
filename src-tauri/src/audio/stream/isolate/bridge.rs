/*
 * The main process's side of one decode helper. `spawn_isolated` has `spawn_decoder`'s contract: the
 * same queue fills, the same control answers seeks and cancel, and `on_end` gets one end on every
 * path. Only the decoding happens in another process.
 *
 * Four threads per helper. The bridge thread launches the helper, forwards new seeks, watches for
 * cancel and for the helper's exit through its process handle, and decides the end. The pump owns
 * the one reader of the helper's frames and pushes its chunks and seams into the real queue; it is
 * the only caller of `answer_seek`. The byte server answers the helper's reads from the item's byte
 * buffer. The writer sends main's frames in order from a bounded outbox.
 *
 * The helper is treated as possibly compromised. A frame that fails the codec's checks, comes out of
 * order, or asks for bytes the buffer cannot serve kills it and ends the item `Protocol`, as does a
 * helper that stops taking main's frames. The bridge thread, the pump and the byte server never
 * wait on the helper without re-checking cancel every `WAIT_SLICE`. The writer alone blocks in a
 * pipe write, which a killed helper ends, unless a handle leaked into another process keeps the
 * helper's read end open. Once the end is decided the helper is killed, and nothing it sent later
 * reaches the queue or the control. Its exit is seen through its process handle, never from its pipe
 * closing alone: a handle leaked into another child can keep the pipe open after the helper is gone.
 */

// -- Library Imports --
use std::ffi::OsStr;
use std::fs::File;
use std::io::{self, BufReader, Read, SeekFrom};
use std::os::windows::io::AsRawHandle;
use std::panic::{self, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, SendTimeoutError, Sender, TryRecvError, TrySendError};
use symphonia::core::io::MediaSource;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::Pipes::PeekNamedPipe;

// -- Local Imports --
use super::alloc::EXIT_MEMORY;
use super::wire::{HelperFrame, HelperReader, MainFrame, ReadSource, WireError, READ_MAX};
use crate::audio::stream::pcm::{PcmQueue, PushError, Seam};
use crate::audio::stream::{
    spawn_decoder, DecodeEnd, Fault, StreamControl, StreamInput, HELPER_MEMORY_MAX, WAIT_SLICE,
};
use crate::proc::contained::Contained;
use crate::proc::helper::DECODE_HELPER_FLAG;
use crate::proc::job::Job;
use crate::proc::session::{Session, DECODE_HELPER};

/// How long a new helper may take to send `Ready`. A launch that misses it tries once more.
const READY_WAIT: Duration = Duration::from_secs(5);
/// `READY_WAIT` in the test build.
#[cfg(test)]
const TEST_READY_WAIT: Duration = Duration::from_secs(30);
/// Main's frames waiting for the writer.
const OUTBOX: usize = 8;
/// How long a frame for the helper may wait for room. The helper reads its pipe on a thread that
/// does nothing else, so only a helper that stopped reading takes longer.
const HELPER_SEND: Duration = Duration::from_secs(2);
/// How long a helper that closed its pipe has to exit.
const EXIT_WAIT: Duration = Duration::from_secs(2);
/// The first pause of a read waiting on the helper's empty pipe.
const POLL_FIRST: Duration = Duration::from_micros(50);

/// Starts decoding `input` in a decode helper, with `spawn_decoder`'s contract. `pcm_s16le` has no
/// container and runs in-process.
pub fn spawn_isolated(
    input: StreamInput,
    queue: PcmQueue,
    on_end: impl FnOnce(DecodeEnd) + Send + 'static,
) -> io::Result<JoinHandle<()>> {
    spawn_in(&DECODE_HELPER, Launch::default(), input, queue, on_end)
}

/// How one helper is launched: what it adds to the command line, how long each attempt waits for
/// `Ready`, and in tests who is told its process id.
struct Launch {
    args: &'static [&'static str],
    ready_wait: Duration,
    #[cfg(test)]
    pid: Option<std::sync::mpsc::Sender<u32>>,
}

impl Default for Launch {
    fn default() -> Launch {
        Launch {
            args: &[],
            #[cfg(not(test))]
            ready_wait: READY_WAIT,
            // The test build runs many helpers at once, and a freshly built test binary is scanned
            // at its first launches: its Ready can take far longer than the app's.
            #[cfg(test)]
            ready_wait: TEST_READY_WAIT,
            #[cfg(test)]
            pid: None,
        }
    }
}

fn spawn_in(
    session: &'static Session,
    launch: Launch,
    input: StreamInput,
    queue: PcmQueue,
    on_end: impl FnOnce(DecodeEnd) + Send + 'static,
) -> io::Result<JoinHandle<()>> {
    let StreamInput::Media { source, hint } = input else {
        return spawn_decoder(input, queue, on_end);
    };
    thread::Builder::new()
        .name("plisto-stream-bridge".into())
        .spawn(move || {
            let control = Arc::clone(queue.control());
            let end = panic::catch_unwind(AssertUnwindSafe(|| {
                run(session, launch, source, hint, queue)
            }))
            .unwrap_or(DecodeEnd::Panicked);
            let end = cancel_first(end, &control);
            control.close_seeks();
            control.set_producer_done();
            on_end(end);
        })
}

/// The item's end once cancel is weighed: a cancelled item ends `Cancelled`, whatever the helper
/// reported, as a cancel comes first for the in-process decode thread. A cancelled byte buffer
/// read answers the helper as a broken source, so its own end can say `SourceBroken`. A cancel
/// that lands after the helper finished but before this runs also reads `Cancelled`, where the
/// in-process thread would already have reported `Finished`.
fn cancel_first(end: DecodeEnd, control: &StreamControl) -> DecodeEnd {
    if control.is_cancelled() {
        DecodeEnd::Cancelled
    } else {
        end
    }
}

// Launches the helper, starts the threads that serve it, and supervises it to its end.
fn run(
    session: &Session,
    launch: Launch,
    source: Box<dyn MediaSource>,
    hint: Option<&'static str>,
    mut queue: PcmQueue,
) -> DecodeEnd {
    let control = Arc::clone(queue.control());
    let cancelled = || control.is_cancelled();
    let mut args = vec![OsStr::new(DECODE_HELPER_FLAG)];
    args.extend(launch.args.iter().map(OsStr::new));
    let launched = std::env::current_exe()
        .map_err(|e| e.to_string())
        .and_then(|exe| {
            session
                .launch(
                    &exe,
                    &args,
                    HELPER_MEMORY_MAX,
                    launch.ready_wait,
                    &cancelled,
                )
                .map_err(|e| e.to_string())
        });
    let (mut helper, stdout) = match launched {
        Ok(launched) => launched,
        Err(_) if cancelled() => return DecodeEnd::Cancelled,
        Err(e) => {
            eprintln!("warn: decode isolation: {e}; the stream item cannot be decoded");
            return DecodeEnd::Isolated(Fault::Spawn);
        }
    };
    #[cfg(test)]
    if let Some(pid) = &launch.pid {
        let _ = pid.send(helper.process.id());
    }
    let gate = Arc::new(EndGate::default());
    // Decides the end and kills the helper on every way out of here, a panic included.
    let _ending = Ending {
        gate: &gate,
        job: &helper.job,
        control: &control,
    };
    let Some(stdin) = helper.process.stdin.take() else {
        return DecodeEnd::Isolated(Fault::Spawn);
    };

    let seekable = source.is_seekable();
    let len = source.byte_len();
    let (tx, outbox_rx) = crossbeam_channel::bounded(OUTBOX);
    let outbox = Outbox {
        tx,
        halt: Arc::clone(&gate.halt),
        control: Arc::clone(&control),
    };
    outbox.send(MainFrame::Open {
        hint: hint.map(str::to_owned),
        seekable,
        guarded: true,
        len,
    });
    queue.halt_on(Arc::clone(&gate.halt));
    let exited = Arc::new(AtomicBool::new(false));
    let pipe = PolledPipe {
        file: stdout,
        halt: Arc::clone(&gate.halt),
        exited: Arc::clone(&exited),
    };
    let (outcome_tx, outcomes) = crossbeam_channel::bounded(2);
    let (read_tx, reads) = crossbeam_channel::bounded(1);
    let outstanding = Arc::new(AtomicBool::new(false));
    let pump = Pump {
        reader: HelperReader::new(BufReader::new(pipe)),
        queue,
        control: Arc::clone(&control),
        outbox: outbox.clone(),
        reads: read_tx,
        outstanding: Arc::clone(&outstanding),
        seekable,
        end_queued: false,
        gate: Arc::clone(&gate),
        #[cfg(test)]
        pause_in_take: Duration::ZERO,
    };
    let server = ByteServer {
        source,
        at: 0,
        seekable,
        len,
        outbox: outbox.clone(),
        outstanding,
    };
    let served_outcomes = outcome_tx.clone();
    let started = spawn_named("plisto-stream-writer", move || {
        write_frames(outbox_rx, stdin)
    })
    .and_then(|()| {
        spawn_named("plisto-stream-bytes", move || {
            server.run(reads, served_outcomes)
        })
    })
    .and_then(|()| spawn_named("plisto-stream-pump", move || pump.run(outcome_tx)));
    match started {
        Ok(()) => supervise(&helper.process, &control, &outbox, &outcomes, &exited),
        Err(_) => DecodeEnd::Isolated(Fault::Spawn),
    }
}

fn spawn_named(name: &str, body: impl FnOnce() + Send + 'static) -> io::Result<()> {
    thread::Builder::new()
        .name(name.into())
        .spawn(body)
        .map(drop)
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

// ---- Ending ----

/// The item's end, decided once. The pump acts on the queue and the control only while holding
/// `ended` and finding it false, so nothing from the helper reaches them after the decision.
/// `halt` stops a push or a send the pump is blocked in, so deciding waits at most one
/// `WAIT_SLICE` for the pump.
#[derive(Default)]
struct EndGate {
    halt: Arc<AtomicBool>,
    ended: Mutex<bool>,
}

impl EndGate {
    fn decide(&self) {
        self.halt.store(true, Ordering::Release);
        *lock(&self.ended) = true;
    }
}

/// Decides the end, kills the helper and closes the source when dropped.
struct Ending<'a> {
    gate: &'a EndGate,
    job: &'a Job,
    control: &'a StreamControl,
}

impl Drop for Ending<'_> {
    fn drop(&mut self) {
        self.gate.decide();
        let _ = self.job.terminate();
        // The byte server's read wakes, and it drops the source as the decode thread would.
        self.control.close_source();
    }
}

// ---- Supervision ----

/// What ended the pump or the byte server.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Outcome {
    /// The helper's own end.
    End(DecodeEnd),
    /// The helper's pipe closed or broke, either way: its exit code tells why, and a helper that
    /// lives on with a pipe closed broke the protocol.
    Closed,
    /// A bad frame, a frame out of order, a read the byte buffer cannot serve, a helper that stopped
    /// taking main's frames, or a pump that panicked.
    Protocol,
    /// The queue refused a push: cancelled, every reader gone, or the end already decided.
    Stopped(PushError),
}

// Runs until the item ends and returns how. Forwards each newer seek to the helper without ever
// blocking on it: a seek the helper does not take within `HELPER_SEND` ends the item.
fn supervise(
    process: &Contained,
    control: &StreamControl,
    outbox: &Outbox,
    outcomes: &Receiver<Outcome>,
    exited: &AtomicBool,
) -> DecodeEnd {
    let mut forwarded = 0;
    // A seek waiting for room in the outbox, and since when one has been waiting.
    let mut waiting: Option<(MainFrame, Instant)> = None;
    let mut exit_code = None;
    loop {
        match outcomes.try_recv() {
            Ok(outcome) => return settle(outcome, process, control, exit_code),
            Err(TryRecvError::Disconnected) => return DecodeEnd::Isolated(Fault::Protocol),
            Err(TryRecvError::Empty) => {}
        }
        if control.is_cancelled() {
            return DecodeEnd::Cancelled;
        }
        if let Some((secs, generation)) = control.take_seek() {
            if generation > forwarded {
                forwarded = generation;
                let seek = MainFrame::Seek {
                    secs: wire_secs(secs),
                    generation,
                };
                let since = waiting
                    .as_ref()
                    .map_or_else(Instant::now, |(_, since)| *since);
                waiting = Some((seek, since));
            }
        }
        if let Some((seek, since)) = waiting.take() {
            match outbox.tx.try_send(seek) {
                Err(TrySendError::Full(_)) if since.elapsed() >= HELPER_SEND => {
                    return DecodeEnd::Isolated(Fault::Protocol)
                }
                Err(TrySendError::Full(seek)) => waiting = Some((seek, since)),
                // A write to the helper failed: its exit code, or its closed pipe, decides.
                Err(TrySendError::Disconnected(_)) => {
                    return settle(Outcome::Closed, process, control, exit_code)
                }
                Ok(()) => {}
            }
        }
        if exit_code.is_some() {
            thread::sleep(WAIT_SLICE);
            continue;
        }
        match process.wait_timeout(WAIT_SLICE) {
            Ok(Some(code)) => {
                exit_code = Some(code);
                // Everything the helper wrote is in its pipe now: the pump reads it to the end.
                exited.store(true, Ordering::Release);
            }
            Ok(None) => {}
            Err(_) => return DecodeEnd::Isolated(Fault::Crashed),
        }
    }
}

// The end an outcome stands for. A closed pipe takes the helper's exit code, waiting for it if
// need be.
fn settle(
    outcome: Outcome,
    process: &Contained,
    control: &StreamControl,
    exit_code: Option<u32>,
) -> DecodeEnd {
    match outcome {
        Outcome::End(end) => end,
        Outcome::Protocol => DecodeEnd::Isolated(Fault::Protocol),
        Outcome::Stopped(PushError::ReaderGone) => DecodeEnd::ReaderGone,
        Outcome::Stopped(_) => DecodeEnd::Cancelled,
        Outcome::Closed => {
            if let Some(code) = exit_code {
                return exit_end(code);
            }
            let deadline = Instant::now() + EXIT_WAIT;
            loop {
                if control.is_cancelled() {
                    return DecodeEnd::Cancelled;
                }
                match process.wait_timeout(WAIT_SLICE) {
                    Ok(Some(code)) => return exit_end(code),
                    Ok(None) if Instant::now() < deadline => {}
                    // A helper that closed its pipe and lives on is not following the protocol.
                    Ok(None) => return DecodeEnd::Isolated(Fault::Protocol),
                    Err(_) => return DecodeEnd::Isolated(Fault::Crashed),
                }
            }
        }
    }
}

/// The end of a helper that exited without sending its own.
fn exit_end(code: u32) -> DecodeEnd {
    match code {
        EXIT_MEMORY => DecodeEnd::Isolated(Fault::Memory),
        // A clean exit with no `End` is a helper that broke the protocol.
        0 => DecodeEnd::Isolated(Fault::Protocol),
        _ => DecodeEnd::Isolated(Fault::Crashed),
    }
}

/// A seek target the wire carries: a target past every end stays past every end.
fn wire_secs(secs: f64) -> f64 {
    if secs.is_finite() {
        secs
    } else {
        f64::MAX
    }
}

// ---- Writer ----

/// Main's frames for the helper, written in order by the writer thread.
#[derive(Clone)]
struct Outbox {
    tx: Sender<MainFrame>,
    halt: Arc<AtomicBool>,
    control: Arc<StreamControl>,
}

/// How a blocking send to the helper went.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Sent {
    Done,
    /// The end is decided, or the item is cancelled.
    Stopped,
    /// The writer is gone: a write to the helper failed, so the helper stopped reading or died.
    Gone,
    /// The helper took nothing for `HELPER_SEND`.
    Stalled,
}

impl Outbox {
    /// Queues `frame`, waiting for room in `WAIT_SLICE` steps and at most `HELPER_SEND` in all.
    fn send(&self, frame: MainFrame) -> Sent {
        let since = Instant::now();
        let mut frame = frame;
        loop {
            match self.tx.send_timeout(frame, WAIT_SLICE) {
                Ok(()) => return Sent::Done,
                Err(SendTimeoutError::Timeout(back)) => {
                    if self.halt.load(Ordering::Acquire) || self.control.is_cancelled() {
                        return Sent::Stopped;
                    }
                    if since.elapsed() >= HELPER_SEND {
                        return Sent::Stalled;
                    }
                    frame = back;
                }
                Err(SendTimeoutError::Disconnected(_)) => return Sent::Gone,
            }
        }
    }
}

fn write_frames(frames: Receiver<MainFrame>, mut stdin: File) {
    for frame in frames {
        if frame.write(&mut stdin).is_err() {
            return;
        }
    }
}

// ---- Pump ----

/// The helper's stdout, read only once bytes wait in it, so a read never outlasts the end being
/// decided. Once the helper has exited, an empty pipe is its end, even if a handle leaked into
/// another process keeps the pipe open.
struct PolledPipe {
    file: File,
    halt: Arc<AtomicBool>,
    exited: Arc<AtomicBool>,
}

impl Read for PolledPipe {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        // A frame usually follows soon after the last: look again quickly at first, then back off
        // to `WAIT_SLICE`.
        let mut pause = POLL_FIRST;
        loop {
            if self.halt.load(Ordering::Acquire) {
                return Err(io::Error::other("the item has ended"));
            }
            // Read before the pipe: an exit seen here means the pipe holds all the helper wrote.
            let exited = self.exited.load(Ordering::Acquire);
            let mut waiting = 0u32;
            // SAFETY: the pipe handle is open while `file` lives, and `waiting` is a live u32.
            let peeked = unsafe {
                PeekNamedPipe(
                    HANDLE(self.file.as_raw_handle()),
                    None,
                    0,
                    None,
                    Some(&mut waiting),
                    None,
                )
            };
            match peeked {
                // The write end closed and everything is read.
                Err(_) => return Ok(0),
                Ok(()) if waiting > 0 => {
                    let len = buf.len().min(waiting as usize);
                    return self.file.read(&mut buf[..len]);
                }
                Ok(()) if exited => return Ok(0),
                Ok(()) => {
                    thread::sleep(pause);
                    pause = (pause * 2).min(WAIT_SLICE);
                }
            }
        }
    }
}

/// One `Read` for the byte server.
struct ReadRequest {
    pos: u64,
    max: u32,
}

/// Hands the pump's outcome to the bridge thread exactly once: a pump that panics reports
/// `Protocol` as it unwinds, so the item never waits on a pump that is gone.
struct Report {
    outcomes: Sender<Outcome>,
    sent: bool,
}

impl Report {
    fn send(mut self, outcome: Outcome) {
        self.sent = true;
        let _ = self.outcomes.send(outcome);
    }
}

impl Drop for Report {
    fn drop(&mut self) {
        if !self.sent {
            let _ = self.outcomes.send(Outcome::Protocol);
        }
    }
}

struct Pump<R> {
    reader: HelperReader<R>,
    queue: PcmQueue,
    control: Arc<StreamControl>,
    outbox: Outbox,
    reads: Sender<ReadRequest>,
    // A `Read` the byte server has not answered yet.
    outstanding: Arc<AtomicBool>,
    seekable: bool,
    // The queue holds the item's `End`, after a `CloseSeeks` that found no seek waiting.
    end_queued: bool,
    gate: Arc<EndGate>,
    // How long a take holds the end lock before acting, so a test can decide the end meanwhile.
    #[cfg(test)]
    pause_in_take: Duration,
}

impl<R: Read> Pump<R> {
    fn run(mut self, outcomes: Sender<Outcome>) {
        let report = Report {
            outcomes,
            sent: false,
        };
        let outcome = loop {
            let frame = match self.reader.read_frame() {
                Ok(Some(frame)) => frame,
                // Torn or broken mid-frame: the helper died writing, and its exit code says why.
                Ok(None) | Err(WireError::Torn | WireError::Io(_)) => break Outcome::Closed,
                Err(_) => break Outcome::Protocol,
            };
            if let Some(outcome) = self.take_gated(frame) {
                break outcome;
            }
        };
        report.send(outcome);
    }

    // `take`, unless the end is decided: then the frame is dropped and the pump stops.
    fn take_gated(&mut self, frame: HelperFrame) -> Option<Outcome> {
        let gate = Arc::clone(&self.gate);
        let ended = lock(&gate.ended);
        if *ended {
            return Some(Outcome::Stopped(PushError::Cancelled));
        }
        #[cfg(test)]
        thread::sleep(self.pause_in_take);
        self.take(frame)
    }

    // Acts on one frame. Some when the item ends with it.
    fn take(&mut self, frame: HelperFrame) -> Option<Outcome> {
        // Once the item's `End` is queued, only the helper's own end may follow.
        if self.end_queued && !matches!(frame, HelperFrame::End(_)) {
            return Some(Outcome::Protocol);
        }
        match frame {
            HelperFrame::Read {
                source: ReadSource::Audio,
                pos,
                max,
            } => {
                // The decode thread reads one request at a time.
                if self.outstanding.swap(true, Ordering::AcqRel) {
                    return Some(Outcome::Protocol);
                }
                if self.reads.try_send(ReadRequest { pos, max }).is_err() {
                    return Some(Outcome::Protocol);
                }
            }
            HelperFrame::Chunk(chunk) => match self.queue.push_chunk(chunk) {
                // A chunk from before a pending seek is stale.
                Ok(()) | Err(PushError::SeekPending) => {}
                Err(err) => return Some(Outcome::Stopped(err)),
            },
            HelperFrame::Break(seam) => {
                let Ok(seam) = seam.check(&self.control) else {
                    return Some(Outcome::Protocol);
                };
                if let Seam::Seek(generation) = seam {
                    self.queue.flush();
                    if let Err(err) = self.queue.push_break(seam) {
                        return Some(Outcome::Stopped(err));
                    }
                    self.control.answer_seek(generation);
                } else if let Err(err) = self.queue.push_break(seam) {
                    return Some(Outcome::Stopped(err));
                }
            }
            HelperFrame::SeeksOpen if self.seekable => self.control.open_seeks(),
            HelperFrame::CloseSeeks if !self.end_queued => {
                let pending = match self.close_at_end() {
                    Ok(pending) => pending,
                    Err(err) => return Some(Outcome::Stopped(err)),
                };
                let pending = pending.map(|(secs, generation)| (wire_secs(secs), generation));
                match self.outbox.send(MainFrame::SeeksClosed { pending }) {
                    Sent::Done => {}
                    Sent::Stopped => return Some(Outcome::Stopped(PushError::Cancelled)),
                    Sent::Gone => return Some(Outcome::Closed),
                    Sent::Stalled => return Some(Outcome::Protocol),
                }
            }
            HelperFrame::End(DecodeEnd::Finished) if !self.end_queued => {
                return Some(Outcome::Protocol)
            }
            HelperFrame::End(end) => return Some(Outcome::End(end)),
            _ => return Some(Outcome::Protocol),
        }
        None
    }

    // The helper queued its `End` and closes seeks: queue main's `End` and close seeks in one step
    // with it, as the decode thread does in-process. Returns the seek to serve first, if one got in.
    fn close_at_end(&mut self) -> Result<Option<(f64, u64)>, PushError> {
        match self.queue.push_end() {
            Ok(()) => {}
            Err(PushError::SeekPending) => return Ok(self.control.take_seek()),
            Err(err) => return Err(err),
        }
        if self.control.close_seeks() {
            // The queued `End` is stale now; the seek's flush drops it.
            self.control.open_seeks();
            return Ok(self.control.take_seek());
        }
        self.end_queued = true;
        Ok(None)
    }
}

// ---- Byte server ----

struct ByteServer {
    source: Box<dyn MediaSource>,
    // Where the source's next read starts.
    at: u64,
    seekable: bool,
    len: Option<u64>,
    outbox: Outbox,
    outstanding: Arc<AtomicBool>,
}

impl ByteServer {
    fn run(mut self, reads: Receiver<ReadRequest>, outcomes: Sender<Outcome>) {
        let mut buf = vec![0u8; READ_MAX as usize];
        for ReadRequest { pos, max } in reads {
            if !read_ok(pos, max, self.at, self.seekable, self.len) {
                let _ = outcomes.send(Outcome::Protocol);
                return;
            }
            let reply = self.read_at(pos, &mut buf[..max as usize]);
            self.outstanding.store(false, Ordering::Release);
            match self.outbox.send(reply) {
                Sent::Done => {}
                Sent::Stopped => return,
                Sent::Gone => {
                    let _ = outcomes.send(Outcome::Closed);
                    return;
                }
                Sent::Stalled => {
                    let _ = outcomes.send(Outcome::Protocol);
                    return;
                }
            }
        }
    }

    // One read at `pos`, as the helper's answer.
    fn read_at(&mut self, pos: u64, buf: &mut [u8]) -> MainFrame {
        if pos != self.at {
            match self.source.seek(SeekFrom::Start(pos)) {
                Ok(at) => self.at = at,
                // A finished body that stopped short of the target.
                Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return MainFrame::Eof,
                Err(_) => return MainFrame::Broken,
            }
        }
        loop {
            match self.source.read(buf) {
                Ok(0) => return MainFrame::Eof,
                Ok(n) => {
                    self.at += n as u64;
                    return MainFrame::Data(buf[..n].to_vec());
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(_) => return MainFrame::Broken,
            }
        }
    }
}

/// Whether a `Read` asks for bytes the source can serve: no overflow, within the body, and on an
/// unseekable source exactly where the last read stopped.
fn read_ok(pos: u64, max: u32, at: u64, seekable: bool, len: Option<u64>) -> bool {
    if pos.checked_add(u64::from(max)).is_none() {
        return false;
    }
    if !seekable {
        return pos == at;
    }
    len.is_none_or(|len| pos <= len)
}

#[cfg(test)]
mod tests;
