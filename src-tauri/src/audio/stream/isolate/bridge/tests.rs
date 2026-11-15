/*
 * The bridge's checks on a helper it does not trust: frame by frame through a pump with no pipe,
 * and end to end against real helpers in their container that misbehave on purpose.
 */

use windows::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
use windows::Win32::System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE};

use super::*;
use crate::audio::stream::isolate::test_faults::TestFault;
use crate::audio::stream::isolate::wire::UncheckedSeam;
use crate::audio::stream::pcm::{pcm_queue, PcmReader, Segment};
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
    r.pump.pause_in_take = Duration::from_millis(200);
    let control = Arc::clone(&r.control);
    let mut pump = r.pump;
    let taking = thread::spawn(move || pump.take_gated(HelperFrame::SeeksOpen));
    thread::sleep(Duration::from_millis(50));
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

// ---- Faulty helpers ----

/// A stream item decoded by a helper that misbehaves on purpose.
struct Faulty {
    control: Arc<StreamControl>,
    reader: PcmReader,
    ended: std::sync::mpsc::Receiver<DecodeEnd>,
    pid: std::sync::mpsc::Receiver<u32>,
}

/// A faulty helper over a whole WAV body.
fn faulty(fault: TestFault) -> Faulty {
    let control = Arc::new(StreamControl::new());
    let bytes = wav_bytes(8_000, 1, 80_000);
    let (writer, body) = growing_buffer(bytes.len() as u64, Arc::clone(&control));
    writer.write(&bytes).unwrap();
    writer.finish();
    faulty_over(fault, control, Box::new(body))
}

fn faulty_over(
    fault: TestFault,
    control: Arc<StreamControl>,
    source: Box<dyn MediaSource>,
) -> Faulty {
    let (queue, reader) = pcm_queue(Arc::clone(&control));
    let (end_tx, ended) = std::sync::mpsc::channel();
    let (pid_tx, pid) = std::sync::mpsc::channel();
    let launch = Launch {
        args: fault.args(),
        pid: Some(pid_tx),
        ..Launch::default()
    };
    let input = StreamInput::Media {
        source,
        hint: Some("wav"),
    };
    spawn_in(&DECODE_HELPER, launch, input, queue, move |end| {
        let _ = end_tx.send(end);
    })
    .unwrap();
    Faulty {
        control,
        reader,
        ended,
        pid,
    }
}

/// A process to wait on, closed when dropped.
struct Process(HANDLE);

impl Process {
    fn open(pid: u32) -> Process {
        // SAFETY: plain arguments; the handle is closed when dropped.
        Process(unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, pid) }.unwrap())
    }

    fn gone_within(&self, wait: Duration) -> bool {
        // SAFETY: the handle is open while self lives.
        unsafe { WaitForSingleObject(self.0, wait.as_millis() as u32) == WAIT_OBJECT_0 }
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        // SAFETY: the handle was opened in `open` and is closed once.
        let _ = unsafe { CloseHandle(self.0) };
    }
}

#[test]
fn a_helper_that_stops_reading_is_killed_when_a_seek_cannot_reach_it() {
    let f = faulty(TestFault::Deaf);
    let helper = Process::open(f.pid.recv_timeout(WAIT).unwrap());
    // Seeks pile up behind the read answer the helper never takes, until one waits too long.
    let mut first = None;
    let end = loop {
        if f.control.request_seek(1.0).is_some() {
            first.get_or_insert_with(Instant::now);
        }
        if let Ok(end) = f.ended.try_recv() {
            break end;
        }
        assert!(
            first.is_none_or(|first| first.elapsed() < HELPER_SEND + WAIT),
            "the item never ended"
        );
        thread::sleep(Duration::from_millis(2));
    };
    assert_eq!(end, DecodeEnd::Isolated(Fault::Protocol));
    let first = first.expect("seeks never opened");
    assert!(
        first.elapsed() < HELPER_SEND + Duration::from_secs(2),
        "ended {:?} after the first seek",
        first.elapsed()
    );
    assert!(helper.gone_within(WAIT), "the helper outlived its item");
    assert_eq!(f.control.request_seek(1.0), None);
}

#[test]
fn a_cancel_ends_an_item_whose_helper_stopped_reading() {
    let f = faulty(TestFault::Deaf);
    let helper = Process::open(f.pid.recv_timeout(WAIT).unwrap());
    let fill = Instant::now() + Duration::from_millis(300);
    while Instant::now() < fill {
        f.control.request_seek(1.0);
        thread::sleep(Duration::from_millis(2));
    }
    let cancelled = Instant::now();
    f.control.cancel();
    assert_eq!(
        f.ended.recv_timeout(Duration::from_secs(1)),
        Ok(DecodeEnd::Cancelled)
    );
    assert!(cancelled.elapsed() < Duration::from_secs(1));
    assert!(helper.gone_within(WAIT), "the helper outlived its item");
}

#[test]
fn nothing_from_the_helper_reaches_the_item_after_its_end() {
    // The helper asks for a byte past the body, then sends more audio than the queue holds and
    // opens seeks again. The pump is blocked on the full queue when the end is decided, with the
    // rest still in the pipe: draining the queue after the end must not let any of it through.
    let f = faulty(TestFault::Flood);
    let helper = Process::open(f.pid.recv_timeout(WAIT).unwrap());
    assert_eq!(
        f.ended.recv_timeout(WAIT),
        Ok(DecodeEnd::Isolated(Fault::Protocol))
    );
    assert!(helper.gone_within(WAIT), "the helper outlived its item");
    while f.reader.try_next().is_some() {}
    thread::sleep(Duration::from_millis(200));
    assert!(f.reader.try_next().is_none(), "audio queued after the end");
    assert_eq!(
        f.control.request_seek(1.0),
        None,
        "seeks reopened after the end"
    );
    assert!(f.control.is_producer_done());
}

#[test]
fn the_source_is_released_when_the_item_ends() {
    // The helper's read waits on an empty ring whose writer stays open; then it breaks the
    // protocol. Ending the item must wake that read and drop the ring, closing the writer.
    let control = Arc::new(StreamControl::new());
    let (writer, ring) = byte_ring(1_024, Arc::clone(&control));
    let f = faulty_over(TestFault::Stuck, Arc::clone(&control), Box::new(ring));
    assert_eq!(
        f.ended.recv_timeout(WAIT),
        Ok(DecodeEnd::Isolated(Fault::Protocol))
    );
    let deadline = Instant::now() + Duration::from_secs(1);
    while writer.try_write(&[0]) != Err(WriteError::Closed) {
        assert!(
            Instant::now() < deadline,
            "the ring is still read after the end"
        );
        thread::sleep(Duration::from_millis(2));
    }
    assert!(!control.is_cancelled());
}

/// A byte source whose read cancels the stream and then fails, as a cancelled ring does.
struct CancelOnRead(Arc<StreamControl>);

impl Read for CancelOnRead {
    fn read(&mut self, _buf: &mut [u8]) -> io::Result<usize> {
        self.0.cancel();
        Err(io::Error::new(
            io::ErrorKind::ConnectionAborted,
            "stream cancelled",
        ))
    }
}

impl std::io::Seek for CancelOnRead {
    fn seek(&mut self, _pos: SeekFrom) -> io::Result<u64> {
        Err(io::ErrorKind::Unsupported.into())
    }
}

impl MediaSource for CancelOnRead {
    fn is_seekable(&self) -> bool {
        false
    }

    fn byte_len(&self) -> Option<u64> {
        None
    }
}

#[test]
fn a_cancelled_item_ends_cancelled_whatever_the_helper_reports() {
    // The helper's end, a broken source, is sent only after the cancel is set.
    let control = Arc::new(StreamControl::new());
    let source = Box::new(CancelOnRead(Arc::clone(&control)));
    let f = faulty_over(TestFault::LateEnd, control, source);
    assert_eq!(f.ended.recv_timeout(WAIT), Ok(DecodeEnd::Cancelled));
    // The same weighing, whatever path decided the end.
    let cancelled = StreamControl::new();
    cancelled.cancel();
    for end in [
        DecodeEnd::SourceBroken,
        DecodeEnd::Finished,
        DecodeEnd::Isolated(Fault::Protocol),
        DecodeEnd::Panicked,
    ] {
        assert_eq!(cancel_first(end, &cancelled), DecodeEnd::Cancelled);
        assert_eq!(cancel_first(end, &StreamControl::new()), end);
    }
}

#[test]
fn a_cancel_during_the_launch_ends_at_once() {
    // The helper never sends `Ready`, so the launch waits until the cancel.
    let f = faulty(TestFault::Mute);
    thread::sleep(Duration::from_millis(200));
    let cancelled = Instant::now();
    f.control.cancel();
    assert_eq!(
        f.ended.recv_timeout(Duration::from_secs(1)),
        Ok(DecodeEnd::Cancelled)
    );
    assert!(cancelled.elapsed() < READY_WAIT);
    assert!(f.pid.try_recv().is_err(), "the launch completed");
}

#[test]
fn a_panic_in_the_helper_is_panicked() {
    let f = faulty(TestFault::Panic);
    assert_eq!(f.ended.recv_timeout(WAIT), Ok(DecodeEnd::Panicked));
    assert!(f.control.is_producer_done());
    assert!(f.ended.recv_timeout(Duration::from_millis(100)).is_err());
}

#[test]
fn a_helper_that_stops_taking_frames_is_a_fault_not_a_cancel() {
    // The helper closes its stdin, asks for bytes, then closes seeks: main's answer finds the
    // writer gone.
    let f = faulty(TestFault::Hangup);
    assert_eq!(
        f.ended.recv_timeout(WAIT),
        Ok(DecodeEnd::Isolated(Fault::Protocol))
    );
    assert!(!f.control.is_cancelled());
}

// A session of its own, so stalled launches never touch the one the other tests share.
static RETRYING: Session = Session::new(crate::proc::helper::HELPER_PROFILE);

// Decodes a short WAV through `RETRYING`, each launch attempt waiting `ready_wait` for Ready.
fn decode_retrying(ready_wait: Duration) -> DecodeEnd {
    let control = Arc::new(StreamControl::new());
    let bytes = wav_bytes(8_000, 1, 4_000);
    let (writer, body) = growing_buffer(bytes.len() as u64, Arc::clone(&control));
    writer.write(&bytes).unwrap();
    writer.finish();
    let (queue, reader) = pcm_queue(control);
    let (end_tx, ended) = std::sync::mpsc::channel();
    let launch = Launch {
        ready_wait,
        ..Launch::default()
    };
    let input = StreamInput::Media {
        source: Box::new(body),
        hint: Some("wav"),
    };
    spawn_in(&RETRYING, launch, input, queue, move |end| {
        let _ = end_tx.send(end);
    })
    .unwrap();
    let deadline = Instant::now() + WAIT * 3;
    loop {
        while reader.try_next().is_some() {}
        if let Ok(end) = ended.try_recv() {
            return end;
        }
        assert!(Instant::now() < deadline, "the item never ended");
        thread::sleep(Duration::from_millis(2));
    }
}

#[test]
fn a_launch_that_misses_ready_is_tried_once_more() {
    // The first launch settles the session; a settled session has no fallback left.
    assert_eq!(decode_retrying(TEST_READY_WAIT), DecodeEnd::Finished);
    let short = Duration::from_secs(3);
    RETRYING.stall_next(1);
    assert_eq!(decode_retrying(short), DecodeEnd::Finished);
    assert_eq!(RETRYING.stalls_left(), 0);
    // Two misses in one launch fail the item.
    RETRYING.stall_next(2);
    assert_eq!(decode_retrying(short), DecodeEnd::Isolated(Fault::Spawn));
    assert_eq!(RETRYING.stalls_left(), 0);
}
