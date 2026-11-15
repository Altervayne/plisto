/*
 * Decode helpers that misbehave on purpose, for the bridge's tests. The test build starts one with
 * `--plisto-decode-helper fault <name>`. Each speaks just enough of the protocol to reach the state
 * under test, then stays alive and silent until its job kills it.
 */

// -- Library Imports --
use std::ffi::OsString;
use std::io::{self, BufReader, Read, Seek, SeekFrom};
use std::os::windows::io::AsRawHandle;
use std::thread;
use std::time::Duration;

use symphonia::core::io::MediaSource;
use windows::Win32::Foundation::{CloseHandle, HANDLE};

// -- Local Imports --
use super::helper::serve_with;
use super::wire::{HelperFrame, MainFrame, MainReader, ReadSource, READ_MAX};
use crate::audio::{AudioSpec, PcmChunk};
use crate::proc::helper::DECODE_HELPER_FLAG;

/// The argument after the helper flag that names a fault.
pub const FAULT: &str = "fault";

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
}

const FAULTS: [TestFault; 7] = [
    TestFault::Mute,
    TestFault::Deaf,
    TestFault::Panic,
    TestFault::Flood,
    TestFault::Stuck,
    TestFault::LateEnd,
    TestFault::Hangup,
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
        }
    }
}

/// The fault this process's arguments name, if any.
pub fn from_args() -> Option<TestFault> {
    let args: Vec<OsString> = std::env::args_os().collect();
    if *args.get(1)? != *DECODE_HELPER_FLAG {
        return None;
    }
    FAULTS.into_iter().find(|fault| {
        let named = fault.args();
        args.len() == 2 + named.len() && args[2..].iter().zip(named).all(|(a, n)| *a == **n)
    })
}

/// Runs the faulty helper on its stdin and stdout.
pub fn run(fault: TestFault) -> i32 {
    if fault == TestFault::Mute {
        hold();
    }
    if fault == TestFault::Panic {
        return serve_with(io::stdin(), io::stdout(), |_| Box::new(Panicky));
    }
    let mut out = io::stdout();
    let mut reader = MainReader::new(BufReader::new(io::stdin()));
    if HelperFrame::Ready.write(&mut out).is_err() {
        return 1;
    }
    let Ok(Some(MainFrame::Open { len, .. })) = reader.read_frame() else {
        return 1;
    };
    if fault == TestFault::Hangup {
        return hang_up(reader, out);
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
        _ => vec![read(0, 16)],
    };
    for frame in frames {
        if frame.write(&mut out).is_err() {
            return 1;
        }
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

fn hold() -> ! {
    loop {
        thread::park();
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
