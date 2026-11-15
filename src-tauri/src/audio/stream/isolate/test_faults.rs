/*
 * Decode helpers that misbehave on purpose, for the bridge's tests. The test build starts one with
 * `--plisto-decode-helper fault <name>`. Each speaks just enough of the protocol to reach the state
 * under test, then stays alive and silent until its job kills it, or ends the way it is named for.
 *
 * `--plisto-decode-helper guards-off` starts the real decoder with the stream opening's guards off,
 * so hostile bytes reach symphonia and only the helper's wall stands in their way. The switch is an
 * argument, not the environment: the helper's environment is a fixed block, and an environment
 * variable set by one test would reach every helper the other tests start meanwhile.
 */

// -- Library Imports --
use std::ffi::OsString;
use std::io::{self, BufReader, Read, Seek, SeekFrom, Write};
use std::os::windows::io::AsRawHandle;
use std::thread;
use std::time::Duration;

use symphonia::core::io::MediaSource;
use windows::Win32::Foundation::{CloseHandle, HANDLE};

// -- Local Imports --
use super::helper::serve_with;
use super::wire::{HelperFrame, MainFrame, MainReader, ReadSource, UncheckedSeam, READ_MAX};
use crate::audio::stream::pcm::Seam;
use crate::audio::{AudioSpec, PcmChunk};
use crate::proc::helper::DECODE_HELPER_FLAG;

// -- Module Declarations --
mod earning;
mod seeks;

/// The argument after the helper flag that names a fault.
pub const FAULT: &str = "fault";
/// The argument after the helper flag that turns the guards off.
pub const GUARDS_OFF: &str = "guards-off";
/// How long `Die` lets main's write back up before it exits.
const DIE_AFTER: Duration = Duration::from_millis(500);
/// The exit code of `Die` and `Vanish`: neither the job's kill nor `EXIT_MEMORY`.
const DIED: i32 = 3;
/// The pause between the repeated frames of `ReadSpin`, `ReadSleep`, `SeekSpam`, `BreakSpam` and
/// `StaleFlood`.
const REQUEST_PAUSE: Duration = Duration::from_millis(50);
/// `Sip`'s burn, and the pause after each.
const SIP_BURN: Duration = Duration::from_millis(3);
const SIP_PAUSE: Duration = Duration::from_millis(200);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TestFault {
    /// Never sends `Ready`.
    Mute,
    /// Opens seeks and asks for a full read, then never reads its stdin again.
    Deaf,
    /// Decodes from a byte source whose first read panics.
    Panic,
    /// Opens seeks, asks for bytes past the end of the body, then sends more audio than the queue
    /// holds and opens seeks again.
    Flood,
    /// Asks for the first bytes, then sends a frame main never takes.
    Stuck,
    /// Asks for the first bytes and, once answered, reports a broken source.
    LateEnd,
    /// Closes its stdin, asks for the first bytes, then closes seeks.
    Hangup,
    /// Burns CPU and sends nothing.
    Spin,
    /// Sends nothing and reads nothing, using no CPU.
    Silent,
    /// Exits cleanly without its `End`.
    Quit,
    /// Sends a frame of a kind the codec does not know.
    Garbage,
    /// Aborts the process.
    Abort,
    /// Asks for a full read it never takes, then exits with `DIED`.
    Die,
    /// Exits with `DIED` before its `Ready`.
    Vanish,
    /// Asks for one byte at a time forever, burning CPU between reads.
    ReadSpin,
    /// Asks for one byte at a time forever, sleeping between reads.
    ReadSleep,
    /// Opens seeks over and over, sleeping between them.
    SeekSpam,
    /// Sends a chain seam over and over, sleeping between them, and no audio.
    BreakSpam,
    /// Opens seeks, then sends audio over and over and never answers a seek.
    StaleFlood,
    /// Sends more audio than the queue holds, burning CPU until the last chunk is written, then
    /// ends cleanly.
    BusyBehindFullQueue,
    /// Opens seeks, then floods chain seams and answers no seek, then burns CPU.
    ChainFloodSpin,
    /// Opens seeks, then floods chain seams and answers no seek, then idles.
    ChainFloodIdle,
    /// Asks for the first bytes, then burns CPU while the read is outstanding.
    ReadThenSpin,
    /// Sends nothing and uses CPU at about half the idle allowance.
    Sip,
    /// Opens seeks, takes main's frames and answers none, burning CPU.
    SpinAfterSeeks,
    /// Sends nothing and idles for `IDLE_BEFORE_SPIN`, then burns CPU.
    IdleThenSpin,
    /// Burns CPU, then sends a one-frame chunk, over and over.
    TinySpin,
    /// Sleeps, then sends a one-frame chunk, over and over.
    TinySleep,
    /// Opens seeks, then burns CPU and closes seeks, over and over, answering no seek.
    CloseSeeksSpin,
    /// Opens seeks, then sleeps and closes seeks, over and over, answering no seek.
    CloseSeeksIdle,
    /// Opens seeks over and over, as fast as the pipe takes them.
    SeeksOpenFlood,
    /// Opens seeks over and over, a little at a time.
    SeeksOpenTrickle,
    /// Opens seeks, then sends chain seams as fast as the pipe takes them, answering no seek.
    ChainStream,
}

/// How long `IdleThenSpin` idles before it burns.
pub const IDLE_BEFORE_SPIN: Duration = Duration::from_secs(20);

/// The chunks `BusyBehindFullQueue` sends, 256 ms each.
pub const BUSY_CHUNKS: usize = 40;

const FAULTS: [TestFault; 33] = [
    TestFault::TinySpin,
    TestFault::TinySleep,
    TestFault::CloseSeeksSpin,
    TestFault::CloseSeeksIdle,
    TestFault::SeeksOpenFlood,
    TestFault::SeeksOpenTrickle,
    TestFault::ChainStream,
    TestFault::IdleThenSpin,
    TestFault::ChainFloodSpin,
    TestFault::ChainFloodIdle,
    TestFault::ReadThenSpin,
    TestFault::Sip,
    TestFault::SpinAfterSeeks,
    TestFault::BusyBehindFullQueue,
    TestFault::BreakSpam,
    TestFault::StaleFlood,
    TestFault::ReadSpin,
    TestFault::ReadSleep,
    TestFault::SeekSpam,
    TestFault::Mute,
    TestFault::Deaf,
    TestFault::Panic,
    TestFault::Flood,
    TestFault::Stuck,
    TestFault::LateEnd,
    TestFault::Hangup,
    TestFault::Spin,
    TestFault::Silent,
    TestFault::Quit,
    TestFault::Garbage,
    TestFault::Abort,
    TestFault::Die,
    TestFault::Vanish,
];

impl TestFault {
    /// The helper arguments, after the helper flag, that start this fault.
    pub fn args(self) -> &'static [&'static str] {
        match self {
            TestFault::Mute => &[FAULT, "mute"],
            TestFault::Deaf => &[FAULT, "deaf"],
            TestFault::Panic => &[FAULT, "panic"],
            TestFault::Flood => &[FAULT, "flood"],
            TestFault::Stuck => &[FAULT, "stuck"],
            TestFault::LateEnd => &[FAULT, "late-end"],
            TestFault::Hangup => &[FAULT, "hangup"],
            TestFault::Spin => &[FAULT, "spin"],
            TestFault::Silent => &[FAULT, "silent"],
            TestFault::Quit => &[FAULT, "quit"],
            TestFault::Garbage => &[FAULT, "garbage"],
            TestFault::Abort => &[FAULT, "abort"],
            TestFault::Die => &[FAULT, "die"],
            TestFault::Vanish => &[FAULT, "vanish"],
            TestFault::ReadSpin => &[FAULT, "read-spin"],
            TestFault::ReadSleep => &[FAULT, "read-sleep"],
            TestFault::SeekSpam => &[FAULT, "seek-spam"],
            TestFault::BreakSpam => &[FAULT, "break-spam"],
            TestFault::StaleFlood => &[FAULT, "stale-flood"],
            TestFault::BusyBehindFullQueue => &[FAULT, "busy-behind-full-queue"],
            TestFault::ChainFloodSpin => &[FAULT, "chain-flood-spin"],
            TestFault::ChainFloodIdle => &[FAULT, "chain-flood-idle"],
            TestFault::ReadThenSpin => &[FAULT, "read-then-spin"],
            TestFault::Sip => &[FAULT, "sip"],
            TestFault::SpinAfterSeeks => &[FAULT, "spin-after-seeks"],
            TestFault::IdleThenSpin => &[FAULT, "idle-then-spin"],
            TestFault::TinySpin => &[FAULT, "tiny-spin"],
            TestFault::TinySleep => &[FAULT, "tiny-sleep"],
            TestFault::CloseSeeksSpin => &[FAULT, "close-seeks-spin"],
            TestFault::CloseSeeksIdle => &[FAULT, "close-seeks-idle"],
            TestFault::SeeksOpenFlood => &[FAULT, "seeks-open-flood"],
            TestFault::SeeksOpenTrickle => &[FAULT, "seeks-open-trickle"],
            TestFault::ChainStream => &[FAULT, "chain-stream"],
        }
    }
}

/// The helper arguments after the helper flag, without the program name and the flag. None when
/// argv[1] is not the helper flag.
fn helper_args() -> Option<Vec<OsString>> {
    let args: Vec<OsString> = std::env::args_os().collect();
    if *args.get(1)? != *DECODE_HELPER_FLAG {
        return None;
    }
    Some(args[2..].to_vec())
}

/// The fault this process's arguments name, if any.
pub fn from_args() -> Option<TestFault> {
    let args = helper_args()?;
    FAULTS.into_iter().find(|fault| {
        let named = fault.args();
        args.len() == named.len() && args.iter().zip(named).all(|(a, n)| *a == **n)
    })
}

/// Whether this process's arguments turn the guards off.
pub fn guards_off() -> bool {
    helper_args().is_some_and(|args| args.len() == 1 && args[0] == GUARDS_OFF)
}

/// Runs the faulty helper on its stdin and stdout.
pub fn run(fault: TestFault) -> i32 {
    match fault {
        TestFault::Mute => hold(),
        TestFault::Vanish => return DIED,
        TestFault::Panic => return serve_with(io::stdin(), io::stdout(), |_| Box::new(Panicky)),
        _ => {}
    }
    let mut out = io::stdout();
    let mut reader = MainReader::new(BufReader::new(io::stdin()));
    if HelperFrame::Ready.write(&mut out).is_err() {
        return 1;
    }
    let Ok(Some(MainFrame::Open { len, .. })) = reader.read_frame() else {
        return 1;
    };
    match fault {
        TestFault::TinySpin
        | TestFault::TinySleep
        | TestFault::CloseSeeksSpin
        | TestFault::CloseSeeksIdle
        | TestFault::SeeksOpenFlood
        | TestFault::SeeksOpenTrickle
        | TestFault::ChainStream
        | TestFault::BusyBehindFullQueue => return earning::run(fault, reader, out),
        TestFault::ChainFloodSpin | TestFault::ChainFloodIdle | TestFault::StaleFlood => {
            return seeks::run(fault, reader, out)
        }
        TestFault::Hangup => return hang_up(reader, out),
        TestFault::Spin => spin(),
        TestFault::ReadSpin | TestFault::ReadSleep => return read_forever(fault, reader, out),
        TestFault::SeekSpam => return repeat(HelperFrame::SeeksOpen, out),
        TestFault::BreakSpam => {
            return repeat(HelperFrame::Break(UncheckedSeam::new(Seam::Chain)), out)
        }
        TestFault::ReadThenSpin => {
            if read(0, 16).write(&mut out).is_err() {
                return 1;
            }
            spin();
        }
        TestFault::Sip => loop {
            let until = std::time::Instant::now() + SIP_BURN;
            while std::time::Instant::now() < until {
                std::hint::spin_loop();
            }
            thread::sleep(SIP_PAUSE);
        },
        TestFault::IdleThenSpin => {
            thread::sleep(IDLE_BEFORE_SPIN);
            spin();
        }
        TestFault::SpinAfterSeeks => {
            if HelperFrame::SeeksOpen.write(&mut out).is_err() {
                return 1;
            }
            // Main's seeks are read and dropped, so its writer never backs up.
            thread::spawn(move || while let Ok(Some(_)) = reader.read_frame() {});
            spin();
        }
        TestFault::Quit => return 0,
        TestFault::Abort => std::process::abort(),
        // Kind 0x7E is no frame of the codec's.
        TestFault::Garbage
            if out
                .write_all(&[0x7E, 0, 0, 0, 0])
                .and_then(|()| out.flush())
                .is_err() =>
        {
            return 1
        }
        _ => {}
    }
    let frames = match fault {
        TestFault::Deaf => vec![HelperFrame::SeeksOpen, read(0, READ_MAX)],
        TestFault::Flood => {
            let mut frames = vec![HelperFrame::SeeksOpen, read(len.unwrap_or(0) + 1, 16)];
            // Twenty chunks of 256 ms: more than the queue's 4 s.
            frames.extend((0..20).map(|_| chunk()));
            frames.push(HelperFrame::SeeksOpen);
            frames
        }
        TestFault::Stuck => vec![read(0, 16), HelperFrame::Ready],
        // Main's answer is larger than the pipe holds, so main's writer blocks on it.
        TestFault::Die => vec![read(0, READ_MAX)],
        TestFault::Silent | TestFault::Garbage => Vec::new(),
        _ => vec![read(0, 16)],
    };
    for frame in frames {
        if frame.write(&mut out).is_err() {
            return 1;
        }
    }
    if fault == TestFault::Die {
        thread::sleep(DIE_AFTER);
        return DIED;
    }
    if fault == TestFault::LateEnd {
        // Whatever main answered, the source broke.
        if reader.read_frame().is_err() {
            return 1;
        }
        let end = HelperFrame::End(crate::audio::stream::DecodeEnd::SourceBroken);
        if end.write(&mut out).is_err() {
            return 1;
        }
    }
    // The reader stays alive and unread, so main's frames pile up in the pipe.
    let _unread = reader;
    hold()
}

// Main's writer fails on its answer to the read, before the close needs one.
fn hang_up(reader: MainReader<BufReader<io::Stdin>>, mut out: io::Stdout) -> i32 {
    drop(reader);
    // SAFETY: the stdin handle is open and nothing reads it again.
    let _ = unsafe { CloseHandle(HANDLE(io::stdin().as_raw_handle())) };
    if read(0, 16).write(&mut out).is_err() {
        return 1;
    }
    thread::sleep(Duration::from_millis(300));
    if HelperFrame::CloseSeeks.write(&mut out).is_err() {
        return 1;
    }
    hold()
}

fn chunk() -> HelperFrame {
    HelperFrame::Chunk(PcmChunk {
        samples: vec![0.5; 2_048],
        spec: AudioSpec {
            sample_rate: 8_000,
            channels: 1,
        },
    })
}

fn read(pos: u64, max: u32) -> HelperFrame {
    HelperFrame::Read {
        source: ReadSource::Audio,
        pos,
        max,
    }
}

// Sends `frame` over and over, `REQUEST_PAUSE` apart.
fn repeat(frame: HelperFrame, mut out: io::Stdout) -> i32 {
    loop {
        if frame.write(&mut out).is_err() {
            return 1;
        }
        thread::sleep(REQUEST_PAUSE);
    }
}

// Reads the first byte over and over, each answer taken, with a pause between: a spin for
// `ReadSpin`, a sleep for `ReadSleep`.
fn read_forever(
    fault: TestFault,
    mut reader: MainReader<BufReader<io::Stdin>>,
    mut out: io::Stdout,
) -> i32 {
    loop {
        if read(0, 1).write(&mut out).is_err() || reader.read_frame().is_err() {
            return 1;
        }
        if fault == TestFault::ReadSpin {
            let until = std::time::Instant::now() + REQUEST_PAUSE;
            while std::time::Instant::now() < until {
                std::hint::spin_loop();
            }
        } else {
            thread::sleep(REQUEST_PAUSE);
        }
    }
}

fn hold() -> ! {
    loop {
        thread::park();
    }
}

fn spin() -> ! {
    let mut n = 0u64;
    loop {
        n = std::hint::black_box(n.wrapping_add(1));
    }
}

/// A byte source whose first read panics.
struct Panicky;

impl Read for Panicky {
    fn read(&mut self, _buf: &mut [u8]) -> io::Result<usize> {
        panic!("a hostile byte source");
    }
}

impl Seek for Panicky {
    fn seek(&mut self, _pos: SeekFrom) -> io::Result<u64> {
        Err(io::ErrorKind::Unsupported.into())
    }
}

impl MediaSource for Panicky {
    fn is_seekable(&self) -> bool {
        false
    }

    fn byte_len(&self) -> Option<u64> {
        None
    }
}
