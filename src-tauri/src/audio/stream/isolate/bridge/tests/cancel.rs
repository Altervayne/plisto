/*
 * A cancel ends an isolated item as `Cancelled` within `CANCEL_BOUND`, in each state the item can
 * be in when it comes. The engine waits on `on_end`, so that is what is timed, and each time is
 * logged in slices. The bridge re-checks cancel every `WAIT_SLICE`, but a loaded machine running
 * many helpers at once can take several slices, so the tests hold the cancel to the bound only.
 */

use super::faulty::{body, item, launch_of, Item, Process};
use super::*;
use crate::audio::stream::{PCM_MAX_MS, WAIT_SLICE};

/// The most a cancel may take to reach `on_end` in these tests.
const CANCEL_BOUND: Duration = Duration::from_millis(500);

// Cancels `it` and checks the end comes as `Cancelled` within the bound.
fn cancel_and_time(it: &Item, state: &str) {
    let cancelled = Instant::now();
    it.control.cancel();
    let end = it.ended.recv_timeout(WAIT);
    let took = cancelled.elapsed();
    eprintln!(
        "cancel while {state}: on_end after {took:?} ({:.1} slices)",
        took.as_secs_f64() / WAIT_SLICE.as_secs_f64()
    );
    assert_eq!(end, Ok(DecodeEnd::Cancelled), "{state}");
    assert!(took < CANCEL_BOUND, "{state}: cancel took {took:?}");
}

fn long_wav(control: &Arc<StreamControl>) -> Box<dyn MediaSource> {
    body(&wav_bytes(48_000, 2, 48_000 * 30), control)
}

#[test]
fn a_cancel_while_decoding_reaches_on_end_within_the_bound() {
    // Decoding: audio flows and the queue is taken from as it fills.
    let control = Arc::new(StreamControl::new());
    let it = item(
        &DECODE_HELPER,
        Launch::default(),
        &control,
        long_wav(&control),
    );
    let deadline = Instant::now() + WAIT * 3;
    let mut frames = 0;
    while frames < 48_000 {
        assert!(Instant::now() < deadline, "no audio came");
        if let Some(Segment::Chunk(chunk)) = it.reader.try_next() {
            frames += chunk.frames();
        }
        thread::sleep(Duration::from_millis(1));
    }
    cancel_and_time(&it, "decoding");
    assert!(
        it.threads_gone_within(WAIT),
        "a bridge thread outlived the item"
    );
}

#[test]
fn a_cancel_while_launching_reaches_on_end_within_the_bound() {
    let control = Arc::new(StreamControl::new());
    let (launch, pid) = launch_of(TestFault::Mute);
    let it = item(&DECODE_HELPER, launch, &control, long_wav(&control));
    thread::sleep(Duration::from_millis(200));
    cancel_and_time(&it, "launching");
    assert!(pid.try_recv().is_err(), "the launch completed");
}

#[test]
fn a_cancel_while_waiting_for_bytes_reaches_on_end_within_the_bound() {
    let bytes = wav_bytes(8_000, 1, 16_000);
    let control = Arc::new(StreamControl::new());
    let (writer, buffer) = growing_buffer(bytes.len() as u64, Arc::clone(&control));
    writer.write(&bytes[..4_096]).unwrap();
    let it = item(
        &DECODE_HELPER,
        Launch::default(),
        &control,
        Box::new(buffer),
    );
    // The written part decodes; the helper then waits on the rest.
    let deadline = Instant::now() + WAIT * 3;
    while control.buffered_ms() == 0 {
        assert!(Instant::now() < deadline, "no audio came");
        thread::sleep(Duration::from_millis(2));
    }
    thread::sleep(Duration::from_millis(200));
    cancel_and_time(&it, "waiting for bytes");
    assert!(
        it.threads_gone_within(WAIT),
        "a bridge thread outlived the item"
    );
    drop(writer);
}

#[test]
fn a_cancel_with_the_queue_full_reaches_on_end_within_the_bound() {
    let control = Arc::new(StreamControl::new());
    let it = item(
        &DECODE_HELPER,
        Launch::default(),
        &control,
        long_wav(&control),
    );
    let deadline = Instant::now() + WAIT * 3;
    while control.buffered_ms() < PCM_MAX_MS - 500 {
        assert!(Instant::now() < deadline, "the queue never filled");
        thread::sleep(Duration::from_millis(5));
    }
    thread::sleep(Duration::from_millis(200));
    cancel_and_time(&it, "the queue is full");
    assert!(
        it.threads_gone_within(WAIT),
        "a bridge thread outlived the item"
    );
}

#[test]
fn a_cancel_of_a_silent_helper_reaches_on_end_within_the_bound() {
    let control = Arc::new(StreamControl::new());
    let (launch, pid) = launch_of(TestFault::Silent);
    let it = item(&DECODE_HELPER, launch, &control, long_wav(&control));
    let helper = Process::open(pid.recv_timeout(WAIT).unwrap());
    thread::sleep(Duration::from_millis(200));
    cancel_and_time(&it, "the helper is silent");
    assert!(helper.gone_within(WAIT), "the helper outlived its item");
}

#[test]
fn every_bridge_thread_exits_after_a_cancel() {
    let control = Arc::new(StreamControl::new());
    let (launch, pid) = launch_of(TestFault::Silent);
    let it = item(&DECODE_HELPER, launch, &control, long_wav(&control));
    let _helper = Process::open(pid.recv_timeout(WAIT).unwrap());
    thread::sleep(Duration::from_millis(200));
    it.control.cancel();
    assert_eq!(it.ended.recv_timeout(WAIT), Ok(DecodeEnd::Cancelled));
    let ended = Instant::now();
    assert!(
        it.threads_gone_within(WAIT),
        "a bridge thread outlived the item"
    );
    eprintln!(
        "every bridge thread gone {:?} after on_end",
        ended.elapsed()
    );
}
