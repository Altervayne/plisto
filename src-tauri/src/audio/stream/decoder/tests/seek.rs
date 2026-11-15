use super::*;
use crate::audio::stream::bytes::{GrowingBuffer, GrowingWriter};
use crate::audio::stream::PCM_MAX_MS;
use std::sync::atomic::AtomicBool;

const RATE: u32 = 8_000;
const SECS: usize = 8;

// An 8 s mono WAV in a growing buffer, with its writer and its bytes.
fn wav_body(control: &Arc<StreamControl>) -> (GrowingWriter, GrowingBuffer, Vec<u8>) {
    let bytes = wav_bytes(RATE, 1, SECS * RATE as usize);
    let (writer, body) = growing_buffer(bytes.len() as u64, Arc::clone(control));
    (writer, body, bytes)
}

// Checks what a seek to `secs` delivered: its `Break` first, then the rest of the WAV from the
// packet at or before `secs` (the seek is coarse), then `End`.
fn assert_answered(segments: Vec<Segment>, generation: u64, secs: usize) {
    let events = summarize(segments);
    assert_eq!(
        events.first(),
        Some(&Ev::Break(Seam::Seek(generation))),
        "{events:?}"
    );
    let Some(Ev::Frames(_, after)) = events.get(1) else {
        panic!("no audio after the seek: {events:?}");
    };
    let tail = (SECS - secs) * RATE as usize;
    assert!(
        *after >= tail && *after < tail + 4_096,
        "{after} frames after the seek"
    );
    assert_eq!(events.len(), 3, "{events:?}");
    assert_eq!(events.last(), Some(&Ev::End));
}

// Asks the reader for a segment during a pending seek: it drops stale ones and has none current.
fn drain_stale(reader: &PcmReader) {
    if let Some(s) = reader.try_next() {
        panic!(
            "a segment read as current during a pending seek: {}",
            describe(&s)
        );
    }
}

fn describe(s: &Segment) -> &'static str {
    match s {
        Segment::Chunk(_) => "chunk",
        Segment::Break(_) => "break",
        Segment::End => "end",
    }
}

#[test]
fn seek_flushes_and_pushes_a_break() {
    let control = Arc::new(StreamControl::new());
    let (writer, body, bytes) = wav_body(&control);
    writer.write(&bytes).unwrap();
    writer.finish();
    let running = start(media(body, Some("wav")), &control);

    // With nobody reading, the thread fills the queue to the cap and parks.
    wait_for("the queue never filled", || {
        control.buffered_ms() + 200 >= PCM_MAX_MS
    });
    let generation = control
        .request_seek(6.0)
        .expect("a growing body is seekable");
    assert_eq!(control.buffered_ms(), 0);
    let (segments, end) = running.finish();
    assert_eq!(end, DecodeEnd::Finished);
    assert_answered(segments, generation, 6);
}

#[test]
fn a_seek_while_waiting_for_bytes_hides_the_stale_audio() {
    let control = Arc::new(StreamControl::new());
    let (writer, body, bytes) = wav_body(&control);
    // Two seconds arrive, then the thread waits for more.
    let first = 44 + 2 * RATE as usize * 2;
    writer.write(&bytes[..first]).unwrap();
    let running = start(media(body, Some("wav")), &control);
    wait_for("the first bytes never decoded", || {
        control.buffered_ms() >= 1_800
    });

    let generation = control.request_seek(1.0).unwrap();
    assert_eq!(control.buffered_ms(), 0);
    assert!(!control.is_ready(0));
    assert!(!control.has_boundary());
    // What is queued is from before the seek: the reader drops it all.
    drain_stale(&running.reader);
    drain_stale(&running.reader);

    writer.write(&bytes[first..]).unwrap();
    writer.finish();
    let (segments, end) = running.finish();
    assert_eq!(end, DecodeEnd::Finished);
    assert_answered(segments, generation, 1);
}

#[test]
fn two_quick_seeks_settle_on_the_last() {
    let control = Arc::new(StreamControl::new());
    let (writer, body, bytes) = wav_body(&control);
    writer.write(&bytes).unwrap();
    writer.finish();
    let running = start(media(body, Some("wav")), &control);
    wait_for("the queue never filled", || {
        control.buffered_ms() + 200 >= PCM_MAX_MS
    });

    let first = control.request_seek(1.0).unwrap();
    let second = control.request_seek(5.0).unwrap();
    assert!(second > first);
    let (segments, end) = running.finish();
    assert_eq!(end, DecodeEnd::Finished);
    assert_answered(segments, second, 5);
}

#[test]
fn a_seek_on_an_unseekable_source_is_ignored() {
    let control = Arc::new(StreamControl::new());
    let feed = fed_ring(ogg_opus_bytes(0x44, 1, 300, 312), 512, 8_192, &control);
    let running = start(media(feed.ring, Some("ogg")), &control);
    wait_for("nothing decoded", || control.buffered_ms() > 0);
    assert_eq!(control.request_seek(1.0), None);
    assert!(!control.seek_pending());
    let (segments, end) = running.finish();
    feed.feeder.join().unwrap();
    assert_eq!(end, DecodeEnd::Finished);
    assert_eq!(
        summarize(segments),
        vec![Ev::Frames(spec(48_000, 1), 300 * OPUS_FRAME - 312), Ev::End]
    );
}

// A seekable source that, once armed, makes reads at or past `hold` wait until released.
struct Gated {
    inner: GrowingBuffer,
    pos: u64,
    hold: u64,
    armed: Arc<AtomicBool>,
    waiting: Arc<AtomicBool>,
}

impl Read for Gated {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let mut len = buf.len();
        if self.armed.load(Ordering::Acquire) {
            while self.pos >= self.hold && self.armed.load(Ordering::Acquire) {
                self.waiting.store(true, Ordering::Release);
                thread::sleep(Duration::from_millis(1));
            }
            if self.pos < self.hold {
                len = len.min((self.hold - self.pos) as usize);
            }
        }
        let n = self.inner.read(&mut buf[..len])?;
        self.pos += n as u64;
        Ok(n)
    }
}

impl Seek for Gated {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        self.pos = self.inner.seek(pos)?;
        Ok(self.pos)
    }
}

impl MediaSource for Gated {
    fn is_seekable(&self) -> bool {
        true
    }

    fn byte_len(&self) -> Option<u64> {
        self.inner.byte_len()
    }
}

#[test]
fn a_chain_reset_during_a_pending_seek_is_not_its_answer() {
    let control = Arc::new(StreamControl::new());
    let first = ogg_opus_bytes(0x5151, 1, 500, 312);
    let hold = first.len() as u64;
    let mut bytes = first;
    bytes.extend(ogg_opus_bytes(0x5252, 2, 60, 120));
    let (writer, body) = growing_buffer(bytes.len() as u64, Arc::clone(&control));
    writer.write(&bytes).unwrap();
    writer.finish();
    let armed = Arc::new(AtomicBool::new(false));
    let waiting = Arc::new(AtomicBool::new(false));
    let gated = Gated {
        inner: body,
        pos: 0,
        hold,
        armed: Arc::clone(&armed),
        waiting: Arc::clone(&waiting),
    };
    let running = start(media(gated, Some("ogg")), &control);

    // Once decoding runs, hold the thread at the seam between the two chained streams.
    wait_for("nothing decoded", || control.buffered_ms() > 0);
    armed.store(true, Ordering::Release);
    wait_for("never reached the seam", || {
        while running.reader.try_next().is_some() {}
        waiting.load(Ordering::Acquire)
    });

    // Seek while held; then let the thread meet the new logical stream before it answers.
    let generation = control.request_seek(0.5).unwrap();
    drain_stale(&running.reader);
    armed.store(false, Ordering::Release);

    let (segments, end) = running.finish();
    let events = summarize(segments);
    assert!(
        !events.contains(&Ev::Break(Seam::Chain)),
        "the chain seam read as current: {events:?}"
    );
    assert_eq!(
        events.first(),
        Some(&Ev::Break(Seam::Seek(generation))),
        "{events:?}"
    );
    assert_eq!(end, DecodeEnd::Finished);
    assert_eq!(events.last(), Some(&Ev::End));
}

#[test]
fn a_seek_while_the_end_waits_for_room_is_answered_first() {
    // 27 packets of 1,152 frames fill the queue to 3,888 ms; the 1,000-frame tail then waits for
    // room at the end of the stream.
    let control = Arc::new(StreamControl::new());
    let frames = 27 * 1_152 + 1_000;
    let bytes = wav_bytes(RATE, 1, frames);
    let (writer, body) = growing_buffer(bytes.len() as u64, Arc::clone(&control));
    writer.write(&bytes).unwrap();
    writer.finish();
    let running = start(media(body, Some("wav")), &control);
    wait_for("the queue never filled", || control.buffered_ms() >= 3_800);
    thread::sleep(Duration::from_millis(20));
    assert!(!control.has_boundary(), "the end must still be waiting");

    let generation = control.request_seek(1.0).unwrap();
    let (segments, end) = running.finish();
    assert_eq!(end, DecodeEnd::Finished);
    let events = summarize(segments);
    assert_eq!(
        events.first(),
        Some(&Ev::Break(Seam::Seek(generation))),
        "{events:?}"
    );
    let Some(Ev::Frames(_, after)) = events.get(1) else {
        panic!("no audio after the seek: {events:?}");
    };
    let tail = frames - RATE as usize;
    assert!(
        *after >= tail && *after < tail + 4_096,
        "{after} frames after the seek"
    );
    assert_eq!(events.last(), Some(&Ev::End));
    // The thread has ended: a later seek is refused, never left pending.
    assert_eq!(control.request_seek(0.0), None);
    assert!(!control.seek_pending());
}

// Plays `body` (a whole finite item), seeks past its end once the queue is full, and checks the
// seek is answered and the item ends cleanly.
fn seek_past_the_end(body: Vec<u8>, hint: &'static str) {
    let control = Arc::new(StreamControl::new());
    let (writer, buffer) = growing_buffer(body.len() as u64, Arc::clone(&control));
    writer.write(&body).unwrap();
    writer.finish();
    let running = start(media(buffer, Some(hint)), &control);
    wait_for("the queue never filled", || {
        control.buffered_ms() + 300 >= PCM_MAX_MS
    });
    let generation = control.request_seek(3_600.0).unwrap();
    let (segments, end) = running.finish();
    assert_eq!(end, DecodeEnd::Finished);
    assert_eq!(
        summarize(segments),
        vec![Ev::Break(Seam::Seek(generation)), Ev::End]
    );
}

#[test]
fn a_seek_past_the_end_lands_on_the_end() {
    seek_past_the_end(wav_bytes(RATE, 1, SECS * RATE as usize), "wav");
    seek_past_the_end(flac_bytes(200, FLAC_BLOCK), "flac");
}

#[test]
fn seek_requested_at_the_end_is_served_not_lost() {
    // Seeks back to the start, one after another while the short body decodes and ends, so some
    // land as the thread closes seeks. The last one taken is answered, and the item still ends.
    let frames = RATE as usize / 2;
    let control = Arc::new(StreamControl::new());
    let bytes = wav_bytes(RATE, 1, frames);
    let (writer, body) = growing_buffer(bytes.len() as u64, Arc::clone(&control));
    writer.write(&bytes).unwrap();
    writer.finish();
    let running = start(media(body, Some("wav")), &control);
    let stop = Instant::now() + Duration::from_secs(1);
    let mut last = None;
    while Instant::now() < stop {
        match control.request_seek(0.0) {
            Some(generation) => last = Some(generation),
            // Refused as the thread closes seeks, or after it ended: stop asking.
            None if last.is_some() || control.is_producer_done() => break,
            // Not opened yet.
            None => {}
        }
        thread::sleep(Duration::from_micros(100));
    }
    let (segments, end) = running.finish();
    assert_eq!(end, DecodeEnd::Finished);
    let events = summarize(segments);
    match last {
        Some(generation) => assert_eq!(
            events,
            vec![
                Ev::Break(Seam::Seek(generation)),
                Ev::Frames(spec(RATE, 1), frames),
                Ev::End
            ]
        ),
        None => assert_eq!(events.last(), Some(&Ev::End)),
    }
    assert_eq!(control.request_seek(0.0), None);
    assert!(!control.seek_pending());
}

// The seeks above, with the decoding in a decode helper.
mod isolated {
    use super::super::isolated;

    #[test]
    fn seek_requested_at_the_end_is_served_not_lost() {
        isolated(super::seek_requested_at_the_end_is_served_not_lost);
    }

    #[test]
    fn seek_flushes_and_pushes_a_break() {
        isolated(super::seek_flushes_and_pushes_a_break);
    }

    #[test]
    fn a_seek_while_waiting_for_bytes_hides_the_stale_audio() {
        isolated(super::a_seek_while_waiting_for_bytes_hides_the_stale_audio);
    }

    #[test]
    fn two_quick_seeks_settle_on_the_last() {
        isolated(super::two_quick_seeks_settle_on_the_last);
    }

    #[test]
    fn a_seek_on_an_unseekable_source_is_ignored() {
        isolated(super::a_seek_on_an_unseekable_source_is_ignored);
    }

    #[test]
    fn a_chain_reset_during_a_pending_seek_is_not_its_answer() {
        isolated(super::a_chain_reset_during_a_pending_seek_is_not_its_answer);
    }

    #[test]
    fn a_seek_while_the_end_waits_for_room_is_answered_first() {
        isolated(super::a_seek_while_the_end_waits_for_room_is_answered_first);
    }

    #[test]
    fn a_seek_past_the_end_lands_on_the_end() {
        isolated(super::a_seek_past_the_end_lands_on_the_end);
    }
}
