/*
 * The main process's side of one decode helper. `spawn_isolated` has `spawn_decoder`'s contract: the
 * same queue fills, the same control answers seeks and cancel, and `on_end` gets one end on every
 * path. Only the decoding happens in another process.
 *
 * Four threads per helper. The bridge thread launches the helper, forwards new seeks, watches for
 * cancel, for the helper's exit through its process handle and for a helper that spins or hangs, and
 * decides the end (`supervise`, `watchdog`, `ending`). The pump owns the one reader of the helper's
 * frames and pushes its chunks and seams into the real queue; it is the only caller of
 * `answer_seek`. The byte server answers the helper's reads from the item's byte buffer. The writer
 * sends main's frames in order from a bounded outbox.
 *
 * The helper is treated as possibly compromised. A frame that fails the codec's checks, comes out of
 * order, or asks for bytes the buffer cannot serve kills it and ends the item `Protocol`, as does a
 * helper that stops taking main's frames. The bridge thread, the pump and the byte server never
 * wait on the helper without re-checking cancel every `WAIT_SLICE`. The writer alone blocks in a
 * pipe write; after `on_end` the bridge thread waits for it, up to `EXIT_WAIT`, and cancels a write
 * that a handle leaked into another process keeps blocked. Once the end is decided the helper is
 * killed, and nothing it sent later reaches the queue or the control. Its exit is seen through its
 * process handle, never from its pipe closing alone: a leaked handle can keep the pipe open after
 * the helper is gone.
 */

// -- Library Imports --
use std::ffi::OsStr;
use std::io::{self, BufReader};
use std::panic::{self, AssertUnwindSafe};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use symphonia::core::io::MediaSource;

// -- Local Imports --
use super::wire::{HelperReader, MainFrame};
use crate::audio::stream::pcm::PcmQueue;
use crate::audio::stream::{
    spawn_decoder, DecodeEnd, Fault, StreamControl, StreamInput, HELPER_MEMORY_MAX,
    SPIN_AUDIO_MS_PER_SEC, SPIN_CPU_MS, SPIN_IDLE_MS_PER_SEC, STALL_AUDIO_PAYBACK, STALL_MS,
    WAIT_SLICE,
};
use crate::proc::helper::DECODE_HELPER_FLAG;
use crate::proc::session::{Session, DECODE_HELPER};

// -- Module Declarations --
mod byte_server;
mod ending;
mod ledger;
mod outbox;
#[cfg(test)]
mod probe;
mod pump;
mod supervise;
mod watchdog;

use byte_server::ByteServer;
use ending::{EndGate, Ending};
use ledger::Limits;
use outbox::{reap, write_frames, Outbox, Writer};
use pump::{PolledPipe, Pump};
use supervise::supervise;
use watchdog::{Activity, Watchdog};

/// How often the watchdog reads the helper's CPU time.
const CPU_TICK: Duration = Duration::from_secs(1);
/// The most one step of the stall clock adds: a late step, after the machine slept or the bridge
/// thread starved, never charges the helper for the gap.
const STALL_STEP_MAX: Duration = WAIT_SLICE.saturating_mul(4);

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
/// How long a helper that closed its pipe has to exit, and how long the bridge thread waits for the
/// writer after `on_end`: the bridge thread can outlive `on_end` by this much.
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

/// `spawn_isolated`, with the stream opening's guards off in the helper.
#[cfg(test)]
pub fn spawn_unguarded(
    input: StreamInput,
    queue: PcmQueue,
    on_end: impl FnOnce(DecodeEnd) + Send + 'static,
) -> io::Result<JoinHandle<()>> {
    let launch = Launch {
        args: &[super::test_faults::GUARDS_OFF],
        ..Launch::default()
    };
    spawn_in(&DECODE_HELPER, launch, input, queue, on_end)
}

/// How one helper is launched: what it adds to the command line, how long each attempt waits for
/// `Ready`, the watchdog's limits and how often it reads the helper's CPU, and in tests what the
/// test is told of it.
struct Launch {
    args: &'static [&'static str],
    ready_wait: Duration,
    stall: Duration,
    spin: Duration,
    idle_per_sec: Duration,
    per_audio_sec: Duration,
    cpu_tick: Duration,
    #[cfg(test)]
    pid: Option<std::sync::mpsc::Sender<u32>>,
    #[cfg(test)]
    probe: probe::Probe,
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
            stall: Duration::from_millis(STALL_MS),
            spin: Duration::from_millis(SPIN_CPU_MS),
            idle_per_sec: Duration::from_millis(SPIN_IDLE_MS_PER_SEC),
            per_audio_sec: Duration::from_millis(SPIN_AUDIO_MS_PER_SEC),
            cpu_tick: CPU_TICK,
            #[cfg(test)]
            pid: None,
            #[cfg(test)]
            probe: probe::Probe::default(),
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
            let mut writer = None;
            let end = panic::catch_unwind(AssertUnwindSafe(|| {
                run(session, launch, source, hint, queue, &mut writer)
            }))
            .unwrap_or(DecodeEnd::Panicked);
            let end = cancel_first(end, &control);
            control.close_seeks();
            control.set_producer_done();
            on_end(end);
            if let Some(writer) = writer {
                reap(writer);
            }
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

// Launches the helper, starts the threads that serve it, and supervises it to its end. The writer is
// left in `writer` for the caller to reap once the end is reported.
fn run(
    session: &Session,
    launch: Launch,
    source: Box<dyn MediaSource>,
    hint: Option<&'static str>,
    mut queue: PcmQueue,
    writer: &mut Option<Writer>,
) -> DecodeEnd {
    let control = Arc::clone(queue.control());
    let cancelled = || control.is_cancelled();
    let mut args = vec![OsStr::new(DECODE_HELPER_FLAG)];
    args.extend(launch.args.iter().map(OsStr::new));
    #[cfg(test)]
    launch.probe.enter();
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
    #[cfg(test)]
    launch.probe.launched(&mut helper.process, &helper.job);
    let gate = Arc::new(EndGate::default());
    // Decides the end and kills the helper on every way out of here, a panic included.
    let _ending = Ending {
        gate: &gate,
        job: &helper.job,
        control: &control,
    };
    let Some((stdin, stdin_again)) = helper
        .process
        .stdin
        .take()
        .and_then(|stdin| Some((stdin.try_clone().ok()?, stdin)))
    else {
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
    let activity = Arc::new(Activity::default());
    let pipe = PolledPipe {
        file: stdout,
        halt: Arc::clone(&gate.halt),
        exited: Arc::clone(&exited),
    };
    let (outcome_tx, outcomes) = crossbeam_channel::bounded(2);
    let (read_tx, reads) = crossbeam_channel::bounded(1);
    let outstanding = Arc::new(AtomicBool::new(false));
    let limits = Limits {
        spin: launch.spin,
        stall: launch.stall,
        idle_per_sec: launch.idle_per_sec,
        per_audio_sec: launch.per_audio_sec,
        payback: STALL_AUDIO_PAYBACK,
        step_max: STALL_STEP_MAX,
    };
    let mut watchdog = Watchdog::new(
        &helper.job,
        &activity,
        &outstanding,
        limits,
        launch.cpu_tick,
    );
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
        activity: Arc::clone(&activity),
        #[cfg(test)]
        pause_in_take: Duration::ZERO,
    };
    let server = ByteServer {
        source,
        at: 0,
        seekable,
        len,
        outbox: outbox.clone(),
        outstanding: Arc::clone(&outstanding),
    };
    let served_outcomes = outcome_tx.clone();
    let halt = Arc::clone(&gate.halt);
    let started = spawn_named("plisto-stream-writer", move || {
        write_frames(outbox_rx, stdin, halt)
    })
    .map(|thread| {
        *writer = Some(Writer {
            thread,
            pipe: stdin_again,
        })
    })
    .and_then(|()| {
        spawn_named("plisto-stream-bytes", move || {
            server.run(reads, served_outcomes)
        })
    })
    .and_then(|_| spawn_named("plisto-stream-pump", move || pump.run(outcome_tx)));
    let end = match started {
        Ok(_) => supervise(
            &helper.process,
            &control,
            &outbox,
            &outcomes,
            &exited,
            &mut watchdog,
        ),
        Err(_) => DecodeEnd::Isolated(Fault::Spawn),
    };
    #[cfg(test)]
    launch.probe.ended(&helper.job);
    end
}

fn spawn_named(name: &str, body: impl FnOnce() + Send + 'static) -> io::Result<JoinHandle<()>> {
    #[cfg(test)]
    let body = probe::counted(body);
    thread::Builder::new().name(name.into()).spawn(body)
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests;
