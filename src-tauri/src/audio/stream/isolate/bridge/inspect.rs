/*
 * The main process's side of one inspecting helper, which answers each file of a staging burst in
 * two steps: its tags, then its cover. The calling thread asks and watches the helper while it
 * waits; three threads serve it: a reader that owns the one `HelperReader` of the helper's frames,
 * the writer of main's frames, and a byte server that reads the files main opened. A step that ends
 * any way but with its answer leaves the helper unusable, and the caller replaces it.
 *
 * Each step has a CPU budget and a wall-clock limit. The watchdog is the decoding helper's with no
 * audio to earn by: each step starts with its whole CPU budget, while the CPU baseline runs on across
 * the helper's life, so what the helper burns between two requests is charged to the next. The time
 * main's own read takes is main's, not the helper's, but it counts against the wall limit: a read
 * stuck on slow storage ends the step, and the byte server is left with it. A helper that sits with
 * no read outstanding and the CPU of an idle one for the step's quiet time is taken for hung. The
 * memory cap is an opened file's. A cover is checked against the edges asked for on top of the codec's own checks.
 */

// -- Library Imports --
use std::ffi::OsStr;
use std::io::BufReader;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crossbeam_channel::{select, Receiver, SendTimeoutError, Sender};

// -- Local Imports --
use super::byte_server::read_ok;
use super::ledger::Limits;
use super::outbox::{reap, write_frames, Writer};
use super::pump::PolledPipe;
use super::supervise::exit_end;
use super::watchdog::{Activity, Watchdog};
use super::{spawn_named, Launch, CPU_TICK, EXIT_WAIT, HELPER_SEND, OUTBOX, STALL_STEP_MAX};
use crate::audio::stream::isolate::file::FILE_HELPER_MEMORY_MAX;
use crate::audio::stream::isolate::wire::{
    Cover, HelperFrame, HelperReader, Inspect, Inspected, InspectedCover, MainFrame, ReadSource,
    WireError,
};

// -- Module Declarations --
mod served;

// -- Re-exports --
use crate::audio::stream::{
    DecodeEnd, Fault, SPIN_AUDIO_MS_PER_SEC, SPIN_IDLE_MS_PER_SEC, STALL_AUDIO_PAYBACK, WAIT_SLICE,
};
use crate::proc::helper::DECODE_HELPER_FLAG;
use crate::proc::helper_launch::Helper;
use crate::proc::session::DECODE_HELPER;
pub(in crate::audio::stream::isolate) use served::{pick, Offered};
use served::{serve_reads, ReadJob};
pub use served::{Served, ServedSource};

/// The helper's frames the reader has not handed over yet.
const EVENTS: usize = 4;

/// How an inspecting helper is launched beyond the defaults.
#[derive(Default)]
pub struct InspectLaunch {
    /// Added to the helper's command line.
    pub args: &'static [&'static str],
    /// Launched in place of `plisto.exe`.
    #[cfg(test)]
    pub exe: Option<std::path::PathBuf>,
}

/// What one step may take: CPU, by the helper's job accounting, and wall-clock time; and how long
/// the helper may sit stopped dead, using no more CPU than an idle helper with no read outstanding,
/// before it is taken for hung.
#[derive(Clone, Copy, Debug)]
pub struct StepLimits {
    pub cpu: Duration,
    pub wall: Duration,
    pub quiet: Duration,
}

/// Why a step ended without its answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StepError {
    /// The helper failed: it crashed, spun, stopped dead, ran out of memory or broke the protocol.
    Fault(Fault),
    /// The step ran past its wall-clock limit. `storage` when main's own read was still
    /// outstanding then, so the storage, not the helper, held the step up.
    TimedOut { storage: bool },
}

impl From<Fault> for StepError {
    fn from(fault: Fault) -> StepError {
        StepError::Fault(fault)
    }
}

// What the reader hands the calling thread.
enum Event {
    Frame(HelperFrame),
    /// The pipe closed or broke: the helper's exit code tells why.
    Closed,
    /// A frame the codec refused.
    Protocol,
}

/// A running inspecting helper. Dropping it ends the helper.
pub struct InspectHelper {
    helper: Helper,
    tx: Option<Sender<MainFrame>>,
    writer: Option<Writer>,
    events: Receiver<Event>,
    reads: Option<Sender<ReadJob>>,
    replies: Receiver<MainFrame>,
    halt: Arc<AtomicBool>,
    exited: Arc<AtomicBool>,
    activity: Activity,
    // A read the byte server has not answered yet.
    outstanding: AtomicBool,
    // The last CPU reading, carried from step to step.
    baseline: Option<(Instant, Duration)>,
    answered: bool,
}

impl Drop for InspectHelper {
    fn drop(&mut self) {
        self.halt.store(true, Ordering::Release);
        let _ = self.helper.job.terminate();
        // The writer's and the byte server's queues close with their senders, so their loops end;
        // a byte server stuck in a read ends when the read returns.
        self.tx.take();
        self.reads.take();
        if let Some(writer) = self.writer.take() {
            reap(writer);
        }
    }
}

impl InspectHelper {
    /// Launches an inspecting helper and waits for its Ready. An error is a helper that could not
    /// be set up or launched here, before any file's bytes reached it.
    pub fn launch(launch: InspectLaunch) -> Result<InspectHelper, String> {
        let launch = Launch {
            args: launch.args,
            #[cfg(test)]
            exe: launch.exe,
            ..Launch::default()
        };
        let mut args = vec![OsStr::new(DECODE_HELPER_FLAG)];
        args.extend(launch.args.iter().map(OsStr::new));
        let exe = std::env::current_exe();
        #[cfg(test)]
        let exe = match &launch.exe {
            Some(exe) => Ok(exe.clone()),
            None => exe,
        };
        let exe = exe.map_err(|e| e.to_string())?;
        let (mut helper, stdout) = DECODE_HELPER
            .launch(
                &exe,
                &args,
                FILE_HELPER_MEMORY_MAX,
                launch.ready_wait,
                &|| false,
            )
            .map_err(|e| e.to_string())?;
        let (stdin, stdin_again) = helper
            .process
            .stdin
            .take()
            .and_then(|stdin| Some((stdin.try_clone().ok()?, stdin)))
            .ok_or("the helper's stdin is not available")?;
        let halt = Arc::new(AtomicBool::new(false));
        let exited = Arc::new(AtomicBool::new(false));
        let (tx, outbox) = crossbeam_channel::bounded(OUTBOX);
        let written = Arc::clone(&halt);
        let thread = spawn_named("plisto-inspect-writer", move || {
            write_frames(outbox, stdin, written)
        })
        .map_err(|e| e.to_string())?;
        let (events_tx, events) = crossbeam_channel::bounded(EVENTS);
        let (reads, jobs) = crossbeam_channel::bounded(1);
        let (replies_tx, replies) = crossbeam_channel::bounded(1);
        let pipe = PolledPipe {
            file: stdout,
            halt: Arc::clone(&halt),
            exited: Arc::clone(&exited),
        };
        let inspecting = InspectHelper {
            helper,
            tx: Some(tx),
            writer: Some(Writer {
                thread,
                pipe: stdin_again,
            }),
            events,
            reads: Some(reads),
            replies,
            halt,
            exited,
            activity: Activity::default(),
            outstanding: AtomicBool::new(false),
            baseline: None,
            answered: false,
        };
        spawn_named("plisto-inspect-bytes", move || {
            serve_reads(jobs, replies_tx)
        })
        .map_err(|e| e.to_string())?;
        let reader = HelperReader::new(BufReader::new(pipe));
        spawn_named("plisto-inspect-reader", move || {
            read_events(reader, events_tx)
        })
        .map_err(|e| e.to_string())?;
        Ok(inspecting)
    }

    /// Whether the helper still runs.
    pub fn alive(&self) -> bool {
        !self.exited.load(Ordering::Acquire)
            && matches!(self.helper.process.wait_timeout(Duration::ZERO), Ok(None))
    }

    /// Whether the helper has answered any request.
    pub fn answered(&self) -> bool {
        self.answered
    }

    /// The tags of `audio`.
    pub fn read_tags(
        &mut self,
        audio: Served,
        hint: Option<String>,
        limits: StepLimits,
    ) -> Result<Inspected, StepError> {
        let ask = MainFrame::Inspect(Inspect {
            hint,
            len: audio.len,
        });
        match self.step(ask, Some(audio), None, limits)? {
            HelperFrame::Inspected(answer) => Ok(answer),
            _ => Err(Fault::Protocol.into()),
        }
    }

    /// The cover of the file last read, with `image` offered beside it, as thumbnails at `edges`.
    pub fn cover(
        &mut self,
        image: Option<Served>,
        edges: [u32; 2],
        limits: StepLimits,
    ) -> Result<Option<InspectedCover>, StepError> {
        let ask = MainFrame::Cover(Cover {
            image_len: image.as_ref().map(|image| image.len),
            edges,
        });
        match self.step(ask, None, image, limits)? {
            HelperFrame::Covered(cover) => Ok(checked(cover, edges)?),
            _ => Err(Fault::Protocol.into()),
        }
    }

    // Sends `ask`, serves the helper's reads of `audio` and `image`, and returns the frame that
    // answers it.
    fn step(
        &mut self,
        ask: MainFrame,
        audio: Option<Served>,
        image: Option<Served>,
        limits: StepLimits,
    ) -> Result<HelperFrame, StepError> {
        let deadline = Instant::now() + limits.wall;
        let ledger = Limits {
            spin: limits.cpu,
            // The wall limit, checked first, is the step's time limit.
            stall: limits.wall,
            idle_per_sec: Duration::from_millis(SPIN_IDLE_MS_PER_SEC),
            per_audio_sec: Duration::from_millis(SPIN_AUDIO_MS_PER_SEC),
            payback: STALL_AUDIO_PAYBACK,
            step_max: STALL_STEP_MAX,
        };
        let served = [audio, image].map(|s| s.map(Offered::new));
        let mut watchdog = Watchdog::new(
            &self.helper.job,
            &self.activity,
            &self.outstanding,
            ledger,
            CPU_TICK,
        )
        .continuing(self.baseline);
        let answer = self
            .send(ask)
            .map_err(StepError::from)
            .and_then(|()| self.await_answer(&mut watchdog, &served, deadline, limits.quiet));
        let baseline = watchdog.baseline();
        self.baseline = baseline;
        if answer.is_ok() {
            self.answered = true;
        }
        answer
    }

    fn await_answer(
        &self,
        watchdog: &mut Watchdog,
        served: &[Option<Offered>; 2],
        deadline: Instant,
        quiet: Duration,
    ) -> Result<HelperFrame, StepError> {
        loop {
            select! {
                recv(self.events) -> event => match event {
                    Ok(Event::Frame(HelperFrame::Read { source, pos, max })) => {
                        self.ask_read(served, source, pos, max)?;
                    }
                    Ok(Event::Frame(
                        answer @ (HelperFrame::Inspected(_) | HelperFrame::Covered(_)),
                    )) if !self.outstanding.load(Ordering::Acquire) => return Ok(answer),
                    Ok(Event::Closed) => return Err(self.exit_fault().into()),
                    Ok(_) | Err(_) => return Err(Fault::Protocol.into()),
                },
                recv(self.replies) -> reply => {
                    self.outstanding.store(false, Ordering::Release);
                    self.send(reply.map_err(|_| Fault::Protocol)?)?;
                }
                default(WAIT_SLICE) => {}
            }
            if Instant::now() >= deadline {
                return Err(StepError::TimedOut {
                    storage: self.outstanding.load(Ordering::Acquire),
                });
            }
            if let Some(fault) = watchdog.check() {
                return Err(fault.into());
            }
            if watchdog.quiet_for() >= quiet {
                return Err(Fault::Hung.into());
            }
            if !self.exited.load(Ordering::Acquire) {
                match self.helper.process.wait_timeout(Duration::ZERO) {
                    // Everything the helper wrote is in its pipe now: the reader reads it to the end.
                    Ok(Some(_)) => self.exited.store(true, Ordering::Release),
                    Ok(None) => {}
                    Err(_) => return Err(Fault::Crashed.into()),
                }
            }
        }
    }

    // Hands one of the helper's reads to the byte server. One read at a time, of a file this step
    // serves, within its length.
    fn ask_read(
        &self,
        served: &[Option<Offered>; 2],
        source: ReadSource,
        pos: u64,
        max: u32,
    ) -> Result<(), Fault> {
        // Checked before anything else: a second read while the byte server is stuck in the first
        // must not wait on it.
        if self.outstanding.load(Ordering::Acquire) {
            return Err(Fault::Protocol);
        }
        let offered = pick(served, source)?;
        if !read_ok(pos, max, 0, true, Some(offered.len)) {
            return Err(Fault::Protocol);
        }
        self.outstanding.store(true, Ordering::Release);
        let job = ReadJob {
            served: Arc::clone(&offered.served),
            pos,
            max,
        };
        match &self.reads {
            Some(reads) if reads.try_send(job).is_ok() => Ok(()),
            _ => Err(Fault::Protocol),
        }
    }

    // Queues a frame for the helper. One the helper does not take within `HELPER_SEND` is a fault.
    fn send(&self, frame: MainFrame) -> Result<(), Fault> {
        let Some(tx) = &self.tx else {
            return Err(Fault::Protocol);
        };
        match tx.send_timeout(frame, HELPER_SEND) {
            Ok(()) => Ok(()),
            Err(SendTimeoutError::Timeout(_)) => Err(Fault::Protocol),
            // A write to the helper failed: its exit code decides.
            Err(SendTimeoutError::Disconnected(_)) => Err(self.exit_fault()),
        }
    }

    // The fault of a helper whose pipe closed, from its exit code. One that lives on with its pipe
    // closed broke the protocol.
    fn exit_fault(&self) -> Fault {
        let deadline = Instant::now() + EXIT_WAIT;
        loop {
            match self.helper.process.wait_timeout(WAIT_SLICE) {
                Ok(Some(code)) => {
                    return match exit_end(code) {
                        DecodeEnd::Isolated(fault) => fault,
                        _ => Fault::Protocol,
                    }
                }
                Ok(None) if Instant::now() < deadline => {}
                Ok(None) => return Fault::Protocol,
                Err(_) => return Fault::Crashed,
            }
        }
    }
}

/// The cover, once each thumbnail is within the edge it was asked at.
pub(in crate::audio::stream::isolate) fn checked(
    cover: Option<InspectedCover>,
    edges: [u32; 2],
) -> Result<Option<InspectedCover>, Fault> {
    if let Some(cover) = &cover {
        let within = cover
            .thumbs
            .iter()
            .zip(edges)
            .all(|(thumb, edge)| thumb.width <= edge && thumb.height <= edge);
        if !within {
            return Err(Fault::Protocol);
        }
    }
    Ok(cover)
}

// Hands the helper's frames to the calling thread until the pipe ends, a frame is refused or the
// helper is dropped.
fn read_events(mut reader: HelperReader<BufReader<PolledPipe>>, events: Sender<Event>) {
    loop {
        let event = match reader.read_frame() {
            Ok(Some(frame)) => Event::Frame(frame),
            // Torn or broken mid-frame: the helper died writing, and its exit code says why.
            Ok(None) | Err(WireError::Torn | WireError::Io(_)) => Event::Closed,
            Err(_) => Event::Protocol,
        };
        let last = !matches!(event, Event::Frame(_));
        if events.send(event).is_err() || last {
            return;
        }
    }
}
