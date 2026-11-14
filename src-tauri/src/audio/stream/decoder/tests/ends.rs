use super::*;
use crate::audio::stream::PCM_MAX_MS;
use std::sync::atomic::AtomicUsize;

// A source whose first read panics.
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

#[test]
fn a_panic_reaches_on_end_once() {
    let control = Arc::new(StreamControl::new());
    let (queue, reader) = pcm_queue(Arc::clone(&control));
    let calls = Arc::new(AtomicUsize::new(0));
    let (tx, rx) = mpsc::channel();
    let counted = Arc::clone(&calls);
    let handle = spawn_decoder(media(Panicky, None), queue, move |end| {
        counted.fetch_add(1, Ordering::SeqCst);
        let _ = tx.send(end);
    })
    .unwrap();
    assert_eq!(rx.recv_timeout(DEADLINE), Ok(DecodeEnd::Panicked));
    handle.join().unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    // The queue reads as a dead producer, not a starved one.
    assert!(reader.try_next().is_none());
    assert!(control.is_producer_done());
}

#[test]
fn a_writer_gone_mid_stream_is_a_broken_source() {
    let control = Arc::new(StreamControl::new());
    let feed = feed_ring(adts_silence(20), 50, 1_024, &control, true);
    let (segments, end) = decode_all(media(feed.ring, Some("aac")), control);
    feed.feeder.join().unwrap();
    assert_eq!(end, DecodeEnd::SourceBroken);
    assert_eq!(frames_of(&segments), 20 * 1_024);
    assert!(!segments.iter().any(|s| matches!(s, Segment::End)));
}

#[test]
fn a_writer_gone_during_the_probe_is_a_broken_source() {
    let control = Arc::new(StreamControl::new());
    let feed = feed_ring(vec![0xFF, 0xF1, 0x50], 1, 1_024, &control, true);
    let (segments, end) = decode_all(media(feed.ring, None), control);
    feed.feeder.join().unwrap();
    assert_eq!(end, DecodeEnd::SourceBroken);
    assert!(segments.is_empty());
}

#[test]
fn bytes_that_stop_decoding_mid_stream_are_corrupt() {
    let control = Arc::new(StreamControl::new());
    let mut bytes = adts_silence(10);
    bytes.extend_from_slice(&ADTS_BAD_HEADER);
    bytes.extend(adts_silence(10));
    let (writer, ring) = byte_ring(64 * 1_024, Arc::clone(&control));
    writer.try_write(&bytes).unwrap();
    // The writer stays open: the bytes did not end, they stopped making sense.
    let (segments, end) = decode_all(media(ring, Some("aac")), control);
    assert_eq!(end, DecodeEnd::Corrupt);
    assert_eq!(frames_of(&segments), 10 * 1_024);
    assert!(!segments.iter().any(|s| matches!(s, Segment::End)));
    drop(writer);
}

#[test]
fn cancel_ends_a_thread_waiting_for_bytes() {
    let control = Arc::new(StreamControl::new());
    let (_writer, ring) = byte_ring(1_024, Arc::clone(&control));
    let running = start(media(ring, None), &control);
    // Parked in the probe, waiting for a first byte.
    assert!(running
        .ended
        .recv_timeout(Duration::from_millis(40))
        .is_err());
    control.cancel();
    assert_eq!(
        running.ended.recv_timeout(Duration::from_secs(2)),
        Ok(DecodeEnd::Cancelled)
    );
    running.handle.join().unwrap();
    assert!(control.is_producer_done());
}

#[test]
fn a_dropped_reader_ends_a_parked_thread() {
    let control = Arc::new(StreamControl::new());
    let feed = fed_ring(ogg_opus_bytes(0x33, 1, 400, 312), 512, 8_192, &control);
    let running = start(media(feed.ring, Some("ogg")), &control);
    wait_for("the queue never filled", || {
        control.buffered_ms() + 1_100 >= PCM_MAX_MS
    });
    let Running {
        reader,
        ended,
        handle,
    } = running;
    drop(reader);
    assert_eq!(
        ended.recv_timeout(Duration::from_secs(2)),
        Ok(DecodeEnd::ReaderGone)
    );
    handle.join().unwrap();
    // The thread's ring reader is gone, so the feeder's writes close and it ends too.
    feed.feeder.join().unwrap();
}
