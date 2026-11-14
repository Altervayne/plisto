use super::*;
use crate::audio::stream::START_MS;
use crate::audio::AudioSpec;
use std::sync::mpsc;
use std::time::{Duration, Instant};

const PROMPTLY: Duration = Duration::from_secs(2);

// `frames` mono frames at 1,024 Hz: `MIN_CHUNK_FRAMES` of them last exactly one second.
fn chunk(frames: usize) -> PcmChunk {
    PcmChunk {
        samples: vec![0.0; frames],
        spec: AudioSpec {
            sample_rate: 1_024,
            channels: 1,
        },
    }
}

// Polls `cond` until it holds or `PROMPTLY` runs out.
fn wait_until(cond: impl Fn() -> bool) -> bool {
    let deadline = Instant::now() + PROMPTLY;
    while Instant::now() < deadline {
        if cond() {
            return true;
        }
        thread::sleep(Duration::from_millis(1));
    }
    cond()
}

// Pushes one-second chunks on a thread until a push fails, reporting the failure.
fn flood(mut queue: PcmQueue) -> mpsc::Receiver<PushError> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || loop {
        if let Err(err) = queue.push_chunk(chunk(MIN_CHUNK_FRAMES)) {
            let _ = tx.send(err);
            return;
        }
    });
    rx
}

// The frames of every chunk the reader has ready, in order.
fn ready_frames(reader: &PcmReader) -> Vec<usize> {
    let mut out = Vec::new();
    while let Some(segment) = reader.try_next() {
        if let Segment::Chunk(c) = segment {
            out.push(c.frames());
        }
    }
    out
}

fn seekable_control() -> Arc<StreamControl> {
    let control = Arc::new(StreamControl::new());
    control.open_seeks();
    control
}

#[test]
fn queue_holds_at_most_pcm_max_ms() {
    let control = Arc::new(StreamControl::new());
    let (queue, reader) = pcm_queue(Arc::clone(&control));
    let ended = flood(queue);

    assert!(wait_until(|| control.buffered_ms() == PCM_MAX_MS));
    assert!(!control.is_ready(PCM_MAX_MS + 1));
    assert!(control.is_ready(START_MS));
    // The producer is parked at the cap, not pushing past it.
    thread::sleep(Duration::from_millis(20));
    assert_eq!(control.buffered_ms(), PCM_MAX_MS);
    assert!(ended.try_recv().is_err());

    // Taking one chunk lets exactly one more in.
    assert!(matches!(reader.try_next(), Some(Segment::Chunk(_))));
    assert!(wait_until(|| control.buffered_ms() == PCM_MAX_MS));

    // Cancel wakes the parked producer.
    control.cancel();
    assert_eq!(ended.recv_timeout(PROMPTLY), Ok(PushError::Cancelled));
}

#[test]
fn a_dropped_reader_ends_a_parked_producer() {
    let control = Arc::new(StreamControl::new());
    let (queue, reader) = pcm_queue(Arc::clone(&control));
    let clone = reader.clone();
    let ended = flood(queue);
    assert!(wait_until(|| control.buffered_ms() == PCM_MAX_MS));
    drop(reader);
    // A clone still reads: the producer stays.
    thread::sleep(Duration::from_millis(20));
    assert!(ended.try_recv().is_err());
    drop(clone);
    assert_eq!(ended.recv_timeout(PROMPTLY), Ok(PushError::ReaderGone));
}

#[test]
fn small_chunks_merge_up_to_the_minimum() {
    let control = Arc::new(StreamControl::new());
    let (mut queue, reader) = pcm_queue(Arc::clone(&control));
    for _ in 0..100 {
        queue.push_chunk(chunk(16)).unwrap();
    }
    // 1,600 frames: one merged chunk queued, the rest still gathering.
    assert_eq!(ready_frames(&reader), vec![MIN_CHUNK_FRAMES]);
    // A spec change closes the gathered chunk.
    let mut other = chunk(16);
    other.spec.channels = 2;
    queue.push_chunk(other).unwrap();
    assert_eq!(ready_frames(&reader), vec![1_600 - MIN_CHUNK_FRAMES]);
    // So does the end.
    queue.push_end().unwrap();
    assert_eq!(ready_frames(&reader), vec![8]);
}

#[test]
fn boundaries_count_as_ready_and_flush_empties_the_queue() {
    let control = Arc::new(StreamControl::new());
    let (mut queue, reader) = pcm_queue(Arc::clone(&control));
    assert!(reader.try_next().is_none());
    queue.push_chunk(chunk(MIN_CHUNK_FRAMES)).unwrap();
    assert_eq!(control.buffered_ms(), 1_000);
    assert!(!control.is_ready(START_MS));
    queue.push_end().unwrap();
    assert!(control.is_ready(START_MS));

    queue.flush();
    assert_eq!(control.buffered_ms(), 0);
    assert!(!control.has_boundary());
    assert!(reader.try_next().is_none());
}

#[test]
fn a_pending_seek_hides_and_drops_what_came_before() {
    let control = seekable_control();
    let (mut queue, reader) = pcm_queue(Arc::clone(&control));
    queue.push_chunk(chunk(MIN_CHUNK_FRAMES)).unwrap();
    queue.push_chunk(chunk(MIN_CHUNK_FRAMES)).unwrap();
    queue.push_break(Seam::Chain).unwrap();
    assert!(control.is_ready(START_MS));

    let first = control.request_seek(1.0).unwrap();
    // Nothing queued before the request reads as ready, buffered or current.
    assert_eq!(control.buffered_ms(), 0);
    assert!(!control.has_boundary());
    assert!(!control.is_ready(0));
    assert_eq!(
        queue.push_chunk(chunk(MIN_CHUNK_FRAMES)),
        Err(PushError::SeekPending)
    );
    assert!(reader.try_next().is_none(), "stale segments are dropped");

    // A second request before the answer: only the newest is answered and current.
    let second = control.request_seek(2.0).unwrap();
    assert_eq!(second, first + 1);
    assert_eq!(control.take_seek(), Some((2.0, second)));
    queue.flush();
    queue.push_break(Seam::Seek(first)).unwrap();
    queue.push_break(Seam::Seek(second)).unwrap();
    control.answer_seek(second);
    assert!(!control.seek_pending());
    assert!(control.is_ready(START_MS));
    queue.push_chunk(chunk(MIN_CHUNK_FRAMES)).unwrap();
    assert!(matches!(reader.try_next(), Some(Segment::Break(Seam::Seek(g))) if g == second));
    assert!(matches!(reader.try_next(), Some(Segment::Chunk(_))));
    assert!(reader.try_next().is_none());
    assert_eq!(control.buffered_ms(), 0);
    assert!(!control.has_boundary());
}

#[test]
fn an_unseekable_stream_refuses_a_seek() {
    let control = Arc::new(StreamControl::new());
    assert_eq!(control.request_seek(1.0), None);
    assert!(!control.seek_pending());
}
