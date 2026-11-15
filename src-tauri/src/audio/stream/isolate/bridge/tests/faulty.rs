/*
 * Stream items decoded by real helpers in their container that misbehave on purpose, and the
 * bridge's answer to each.
 */

use super::*;

/// A stream item decoded by a helper that misbehaves on purpose.
pub(super) struct Faulty {
    pub(super) control: Arc<StreamControl>,
    pub(super) reader: PcmReader,
    pub(super) ended: std::sync::mpsc::Receiver<DecodeEnd>,
    pub(super) pid: std::sync::mpsc::Receiver<u32>,
}

/// A faulty helper over a whole WAV body.
pub(super) fn faulty(fault: TestFault) -> Faulty {
    let control = Arc::new(StreamControl::new());
    let bytes = wav_bytes(8_000, 1, 80_000);
    let (writer, body) = growing_buffer(bytes.len() as u64, Arc::clone(&control));
    writer.write(&bytes).unwrap();
    writer.finish();
    faulty_over(fault, control, Box::new(body))
}

pub(super) fn faulty_over(
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

/// A stream item through a real helper launched as a test asks, with the bridge thread's handle and
/// the count of its serving threads still running.
pub(super) struct Item {
    pub(super) control: Arc<StreamControl>,
    pub(super) reader: PcmReader,
    pub(super) ended: std::sync::mpsc::Receiver<DecodeEnd>,
    pub(super) bridge: JoinHandle<()>,
    pub(super) threads: Arc<AtomicUsize>,
}

pub(super) fn item(
    session: &'static Session,
    mut launch: Launch,
    control: &Arc<StreamControl>,
    source: Box<dyn MediaSource>,
) -> Item {
    let threads = Arc::new(AtomicUsize::new(0));
    launch.probe.threads = Some(Arc::clone(&threads));
    let (queue, reader) = pcm_queue(Arc::clone(control));
    let (end_tx, ended) = std::sync::mpsc::channel();
    // The probe tells the container by its first bytes.
    let input = StreamInput::Media { source, hint: None };
    let bridge = spawn_in(session, launch, input, queue, move |end| {
        let _ = end_tx.send(end);
    })
    .unwrap();
    Item {
        control: Arc::clone(control),
        reader,
        ended,
        bridge,
        threads,
    }
}

/// The spin budget of a test that waits for a spinning helper to be killed.
pub(super) const TEST_SPIN: Duration = Duration::from_secs(2);

/// A launch of `fault` that reports the helper's process id.
pub(super) fn launch_of(fault: TestFault) -> (Launch, std::sync::mpsc::Receiver<u32>) {
    let (pid_tx, pid) = std::sync::mpsc::channel();
    let launch = Launch {
        args: fault.args(),
        pid: Some(pid_tx),
        ..Launch::default()
    };
    (launch, pid)
}

/// A finished body holding `bytes`.
pub(super) fn body(bytes: &[u8], control: &Arc<StreamControl>) -> Box<dyn MediaSource> {
    let (writer, body) = growing_buffer(bytes.len() as u64, Arc::clone(control));
    writer.write(bytes).unwrap();
    writer.finish();
    Box::new(body)
}

impl Item {
    /// Takes every segment until the item ends, at most `within`; returns its end and the frames
    /// it queued.
    pub(super) fn drain(&self, within: Duration) -> (DecodeEnd, usize) {
        let deadline = Instant::now() + within;
        let mut frames = 0;
        loop {
            while let Some(segment) = self.reader.try_next() {
                if let Segment::Chunk(chunk) = segment {
                    frames += chunk.frames();
                }
            }
            if let Ok(end) = self.ended.try_recv() {
                while let Some(segment) = self.reader.try_next() {
                    if let Segment::Chunk(chunk) = segment {
                        frames += chunk.frames();
                    }
                }
                return (end, frames);
            }
            assert!(Instant::now() < deadline, "the item never ended");
            thread::sleep(Duration::from_millis(2));
        }
    }

    /// Whether the bridge thread and every serving thread have ended within `wait`.
    pub(super) fn threads_gone_within(&self, wait: Duration) -> bool {
        let deadline = Instant::now() + wait;
        while !self.bridge.is_finished() || self.threads.load(Ordering::Acquire) > 0 {
            if Instant::now() >= deadline {
                return false;
            }
            thread::sleep(Duration::from_millis(2));
        }
        true
    }
}

/// A process to wait on, closed when dropped.
pub(super) struct Process(HANDLE);

impl Process {
    pub(super) fn open(pid: u32) -> Process {
        // SAFETY: plain arguments; the handle is closed when dropped.
        Process(unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, pid) }.unwrap())
    }

    pub(super) fn gone_within(&self, wait: Duration) -> bool {
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
    // Long enough for a healthy launch on a loaded machine, short enough to keep the test brief.
    let short = Duration::from_secs(6);
    RETRYING.stall_next(1);
    assert_eq!(decode_retrying(short), DecodeEnd::Finished);
    assert_eq!(RETRYING.stalls_left(), 0);
    // Two misses in one launch fail the item.
    RETRYING.stall_next(2);
    assert_eq!(decode_retrying(short), DecodeEnd::Isolated(Fault::Spawn));
    assert_eq!(RETRYING.stalls_left(), 0);
}
