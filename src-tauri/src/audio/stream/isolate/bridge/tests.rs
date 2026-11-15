/*
 * The bridge's checks on a helper it does not trust: frame by frame through a pump with no pipe,
 * and end to end against real helpers in their container that misbehave on purpose.
 */

use std::io::{Read, SeekFrom};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

use crossbeam_channel::Receiver;
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
use windows::Win32::System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE};

use super::byte_server::read_ok;
use super::pump::{ReadRequest, Report};
use super::supervise::{exit_end, Outcome};
use super::*;
use crate::audio::stream::isolate::alloc::EXIT_MEMORY;
use crate::audio::stream::isolate::test_faults::TestFault;
use crate::audio::stream::isolate::wire::{HelperFrame, ReadSource, UncheckedSeam, READ_MAX};
use crate::audio::stream::pcm::{pcm_queue, PcmReader, Seam, Segment};
use crate::audio::stream::test_media::wav_bytes;
use crate::audio::stream::{byte_ring, growing_buffer, WriteError};
use crate::audio::{AudioSpec, PcmChunk};
use crate::proc::contained::Isolation;
use crate::proc::helper_launch::launch;
use crate::proc::test_helper::PROBE;

const WAIT: Duration = Duration::from_secs(10);

/// A pump with no pipe behind it, and what it hands on.
struct Rig {
    pump: Pump<io::Empty>,
    reader: PcmReader,
    control: Arc<StreamControl>,
    sent: Receiver<MainFrame>,
    gate: Arc<EndGate>,
    _reads: Receiver<ReadRequest>,
}

fn rig(seekable: bool) -> Rig {
    let control = Arc::new(StreamControl::new());
    let (queue, reader) = pcm_queue(Arc::clone(&control));
    let (tx, sent) = crossbeam_channel::bounded(OUTBOX);
    let (reads_tx, reads) = crossbeam_channel::bounded(1);
    let gate = Arc::new(EndGate::default());
    let pump = Pump {
        reader: HelperReader::new(io::empty()),
        queue,
        control: Arc::clone(&control),
        outbox: Outbox {
            tx,
            halt: Arc::new(AtomicBool::new(false)),
            control: Arc::clone(&control),
        },
        reads: reads_tx,
        outstanding: Arc::new(AtomicBool::new(false)),
        seekable,
        end_queued: false,
        gate: Arc::clone(&gate),
        activity: Arc::default(),
        pause_in_take: Duration::ZERO,
    };
    Rig {
        pump,
        reader,
        control,
        sent,
        gate,
        _reads: reads,
    }
}

#[test]
fn frames_after_the_queued_end_are_protocol() {
    let mut r = rig(true);
    r.pump.take(HelperFrame::SeeksOpen);
    assert_eq!(r.pump.take(chunk()), None);
    assert_eq!(r.pump.take(HelperFrame::CloseSeeks), None);
    assert_eq!(r.pump.take(chunk()), Some(Outcome::Protocol));
    assert_eq!(r.pump.take(HelperFrame::SeeksOpen), Some(Outcome::Protocol));
    assert_eq!(r.pump.take(seek_break(1)), Some(Outcome::Protocol));
    assert!(matches!(r.reader.try_next(), Some(Segment::Chunk(_))));
    assert!(matches!(r.reader.try_next(), Some(Segment::End)));
    assert!(r.reader.try_next().is_none(), "audio queued after the end");
    assert_eq!(
        r.control.request_seek(1.0),
        None,
        "seeks reopened after the end"
    );
}

#[test]
fn deciding_the_end_waits_for_a_take_in_progress() {
    // The take holds the end lock while it acts; deciding the end and closing seeks, as the
    // bridge thread does before `on_end`, must come after it.
    let mut r = rig(true);
    r.pump.pause_in_take = Duration::from_secs(1);
    let control = Arc::clone(&r.control);
    let mut pump = r.pump;
    let taking = thread::spawn(move || pump.take_gated(HelperFrame::SeeksOpen));
    // Decide only once the take holds the lock.
    let deadline = Instant::now() + WAIT;
    while r.gate.ended.try_lock().is_ok() {
        assert!(
            Instant::now() < deadline,
            "the take never held the end lock"
        );
        thread::sleep(Duration::from_millis(1));
    }
    r.gate.decide();
    control.close_seeks();
    assert_eq!(taking.join().unwrap(), None);
    assert_eq!(
        control.request_seek(1.0),
        None,
        "seeks reopened after the end"
    );
}

fn seek_break(generation: u64) -> HelperFrame {
    HelperFrame::Break(UncheckedSeam::new(Seam::Seek(generation)))
}

fn chunk() -> HelperFrame {
    HelperFrame::Chunk(PcmChunk {
        samples: vec![0.25; 2_048],
        spec: AudioSpec {
            sample_rate: 8_000,
            channels: 1,
        },
    })
}

// A rig whose control has a seek requested and not yet answered.
fn rig_with_a_seek() -> (Rig, u64) {
    let mut r = rig(true);
    assert_eq!(r.pump.take(HelperFrame::SeeksOpen), None);
    let generation = r.control.request_seek(1.0).unwrap();
    (r, generation)
}

#[test]
fn a_seek_generation_is_answered_once_and_only_when_requested() {
    // Newer than requested, or zero: never a seek main asked for, though one is pending.
    let (mut r, generation) = rig_with_a_seek();
    assert_eq!(
        r.pump.take(seek_break(generation + 1)),
        Some(Outcome::Protocol)
    );
    let (mut r, _) = rig_with_a_seek();
    assert_eq!(r.pump.take(seek_break(0)), Some(Outcome::Protocol));
    let (mut r, generation) = rig_with_a_seek();
    assert_eq!(r.pump.take(seek_break(generation)), None);
    assert_eq!(r.control.answered(), generation);
    assert!(matches!(r.reader.try_next(), Some(Segment::Break(Seam::Seek(g))) if g == generation));
    // Answered already: a second answer would reopen a seek that was served.
    assert_eq!(r.pump.take(seek_break(generation)), Some(Outcome::Protocol));
}

#[test]
fn close_seeks_returns_the_seek_that_got_in_first() {
    let mut r = rig(true);
    r.pump.take(HelperFrame::SeeksOpen);
    assert_eq!(r.pump.take(chunk()), None);
    let generation = r.control.request_seek(2.0).unwrap();
    assert_eq!(r.pump.take(HelperFrame::CloseSeeks), None);
    assert_eq!(
        r.sent.try_recv(),
        Ok(MainFrame::SeeksClosed {
            pending: Some((2.0, generation))
        })
    );
    // Seeks stay open for the helper to serve this one, and its end is not final yet.
    assert!(r.control.request_seek(3.0).is_some());
    assert_eq!(
        r.pump.take(HelperFrame::End(DecodeEnd::Finished)),
        Some(Outcome::Protocol)
    );
}

#[test]
fn close_seeks_with_none_waiting_queues_the_end_and_closes() {
    let mut r = rig(true);
    r.pump.take(HelperFrame::SeeksOpen);
    assert_eq!(r.pump.take(chunk()), None);
    assert_eq!(r.pump.take(HelperFrame::CloseSeeks), None);
    assert_eq!(
        r.sent.try_recv(),
        Ok(MainFrame::SeeksClosed { pending: None })
    );
    assert_eq!(r.control.request_seek(1.0), None);
    assert!(matches!(r.reader.try_next(), Some(Segment::Chunk(_))));
    assert!(matches!(r.reader.try_next(), Some(Segment::End)));
    // A second close after the end is final is out of order.
    assert_eq!(
        rig_after_close().pump.take(HelperFrame::CloseSeeks),
        Some(Outcome::Protocol)
    );
    assert_eq!(
        r.pump.take(HelperFrame::End(DecodeEnd::Finished)),
        Some(Outcome::End(DecodeEnd::Finished))
    );
}

fn rig_after_close() -> Rig {
    let mut r = rig(false);
    r.pump.take(HelperFrame::CloseSeeks);
    r
}

#[test]
fn frames_out_of_order_are_protocol() {
    // A finished end before the close that queues it.
    assert_eq!(
        rig(true).pump.take(HelperFrame::End(DecodeEnd::Finished)),
        Some(Outcome::Protocol)
    );
    // Seeks on a source that cannot seek.
    assert_eq!(
        rig(false).pump.take(HelperFrame::SeeksOpen),
        Some(Outcome::Protocol)
    );
    // Frames main never takes from a stream helper.
    assert_eq!(
        rig(true).pump.take(HelperFrame::Ready),
        Some(Outcome::Protocol)
    );
    let opened = HelperFrame::Opened {
        rate: 8_000,
        channels: 1,
        duration_secs: None,
    };
    assert_eq!(rig(true).pump.take(opened), Some(Outcome::Protocol));
    let image = HelperFrame::Read {
        source: ReadSource::Image,
        pos: 0,
        max: 1,
    };
    assert_eq!(rig(true).pump.take(image), Some(Outcome::Protocol));
    // A second read before the first is answered.
    let mut r = rig(true);
    let read = || HelperFrame::Read {
        source: ReadSource::Audio,
        pos: 0,
        max: 16,
    };
    assert_eq!(r.pump.take(read()), None);
    assert_eq!(r.pump.take(read()), Some(Outcome::Protocol));
    // Every other end is the helper's to report.
    assert_eq!(
        rig(true).pump.take(HelperFrame::End(DecodeEnd::Corrupt)),
        Some(Outcome::End(DecodeEnd::Corrupt))
    );
}

#[test]
fn reads_the_byte_source_cannot_serve_are_refused() {
    // A ring is read in order only.
    assert!(read_ok(0, READ_MAX, 0, false, None));
    assert!(read_ok(4_096, 16, 4_096, false, None));
    assert!(!read_ok(4_095, 16, 4_096, false, None));
    assert!(!read_ok(8_192, 16, 4_096, false, None));
    // A body is read anywhere within it.
    assert!(read_ok(50, 16, 0, true, Some(100)));
    assert!(read_ok(100, 16, 70, true, Some(100)));
    assert!(!read_ok(101, 16, 0, true, Some(100)));
    // No position and length that overflow.
    assert!(!read_ok(u64::MAX - 5, 16, 0, true, None));
}

#[test]
fn a_helper_that_exits_without_its_end_maps_to_a_fault() {
    assert_eq!(exit_end(EXIT_MEMORY), DecodeEnd::Isolated(Fault::Memory));
    assert_eq!(exit_end(0), DecodeEnd::Isolated(Fault::Protocol));
    // The job's kill, and an access violation.
    assert_eq!(exit_end(1), DecodeEnd::Isolated(Fault::Crashed));
    assert_eq!(exit_end(0xC000_0005), DecodeEnd::Isolated(Fault::Crashed));
}

#[test]
fn an_allocation_over_the_cap_exits_with_exit_memory() {
    let exe = std::env::current_exe().unwrap();
    let container = DECODE_HELPER
        .container(&exe, crate::proc::container::NEVER)
        .unwrap();
    let isolation = DECODE_HELPER.settled().unwrap_or(Isolation::LessPrivileged);
    let args = [
        OsStr::new(DECODE_HELPER_FLAG),
        OsStr::new(PROBE),
        OsStr::new("allocate"),
    ];
    let helper = launch(&container, isolation, &exe, &args, HELPER_MEMORY_MAX).unwrap();
    let code = helper
        .process
        .wait_timeout(WAIT)
        .unwrap()
        .expect("the helper never ended");
    assert_eq!(code, EXIT_MEMORY);
    assert_eq!(exit_end(code), DecodeEnd::Isolated(Fault::Memory));
}

#[test]
fn a_pump_that_panics_still_reports_an_outcome() {
    let (tx, outcomes) = crossbeam_channel::bounded(1);
    let _ = thread::spawn(move || {
        let _report = Report {
            outcomes: tx,
            sent: false,
        };
        panic!("a pump bug");
    })
    .join();
    assert_eq!(outcomes.try_recv(), Ok(Outcome::Protocol));
}

mod budget;
mod cancel;
mod earning;
mod faulty;
mod memory;
mod progress;
mod rates;
mod seeking;
mod wall;
