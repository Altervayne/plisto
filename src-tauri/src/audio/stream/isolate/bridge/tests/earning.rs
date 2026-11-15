/*
 * Helpers that try to keep the watchdog off without delivering audio. Audio earns by its length,
 * not by the frame; only a seek main has not sent before fills the credit; and frames main must
 * handle that carry nothing grow the stall debt like silence does.
 */

use super::faulty::{body, item, launch_of, Item};
use super::*;

/// The spin budget of these tests, and how often they read the helper's CPU.
const SPIN: Duration = Duration::from_secs(1);
const TICK: Duration = Duration::from_millis(100);

// `fault` over a short WAV with these tests' spin budget and `stall`.
fn earning(fault: TestFault, stall: Duration) -> Item {
    let control = Arc::new(StreamControl::new());
    let (mut launch, _pid) = launch_of(fault);
    launch.spin = SPIN;
    launch.cpu_tick = TICK;
    launch.stall = stall;
    item(
        &DECODE_HELPER,
        launch,
        &control,
        body(&wav_bytes(8_000, 1, 8_000), &control),
    )
}

// Waits for the end, taking audio meanwhile when `playing`. Returns the end and how long it took.
fn ended(it: &Item, playing: bool) -> (DecodeEnd, Duration) {
    let started = Instant::now();
    let deadline = started + WAIT * 3;
    loop {
        if playing {
            while it.reader.try_next().is_some() {}
        }
        if let Ok(end) = it.ended.try_recv() {
            return (end, started.elapsed());
        }
        assert!(Instant::now() < deadline, "the item never ended");
        thread::sleep(Duration::from_millis(5));
    }
}

// Asks for a seek once seeks are open; the helpers here never answer it.
fn seek_unanswered(it: &Item) {
    let deadline = Instant::now() + WAIT;
    while it.control.request_seek(0.5).is_none() {
        assert!(Instant::now() < deadline, "seeks never opened");
        thread::sleep(Duration::from_millis(1));
    }
}

fn hung_or_spun(end: DecodeEnd) -> bool {
    matches!(end, DecodeEnd::Isolated(Fault::Hung | Fault::Spun))
}

#[test]
fn tiny_chunks_between_burns_are_spun_playing_or_paused() {
    // 300 ms of CPU for each 125 us of audio: the frame earns a fraction of a millisecond.
    for playing in [true, false] {
        let it = earning(TestFault::TinySpin, Duration::from_millis(STALL_MS));
        let (end, after) = ended(&it, playing);
        eprintln!("tiny chunks between burns, playing {playing}: {end:?} after {after:?}");
        assert_eq!(end, DecodeEnd::Isolated(Fault::Spun), "playing {playing}");
    }
}

#[test]
fn tiny_chunks_between_sleeps_are_hung() {
    // A frame every 2 s pays back a millisecond of a debt that grows by 2 s meanwhile: the stall
    // time, longer than the gap between frames, still comes.
    let it = earning(TestFault::TinySleep, Duration::from_secs(3));
    let (end, after) = ended(&it, true);
    eprintln!("tiny chunks between sleeps: {end:?} after {after:?}");
    assert_eq!(end, DecodeEnd::Isolated(Fault::Hung));
}

#[test]
fn a_seek_handed_back_again_earns_nothing() {
    // One seek from main, then the same seek handed back after every burn.
    let it = earning(TestFault::CloseSeeksSpin, Duration::from_millis(STALL_MS));
    seek_unanswered(&it);
    let (end, after) = ended(&it, false);
    eprintln!("a seek handed back again, burning: {end:?} after {after:?}");
    assert_eq!(end, DecodeEnd::Isolated(Fault::Spun));
    // Nor does it clear the debt of a helper that idles between the hand-backs.
    let it = earning(TestFault::CloseSeeksIdle, Duration::from_secs(2));
    seek_unanswered(&it);
    let (end, after) = ended(&it, false);
    eprintln!("a seek handed back again, idle: {end:?} after {after:?}");
    assert_eq!(end, DecodeEnd::Isolated(Fault::Hung));
}

#[test]
fn a_flood_of_frames_that_carry_nothing_is_ended() {
    for fault in [TestFault::SeeksOpenFlood, TestFault::SeeksOpenTrickle] {
        let it = earning(fault, Duration::from_secs(1));
        let (end, after) = ended(&it, true);
        eprintln!("{fault:?}: {end:?} after {after:?}");
        assert!(hung_or_spun(end), "{fault:?}: {end:?}");
    }
    // Chain seams behind a seek nobody answers are dropped, and earn nothing either.
    let it = earning(TestFault::ChainStream, Duration::from_secs(1));
    seek_unanswered(&it);
    let (end, after) = ended(&it, false);
    eprintln!("chain seams behind a pending seek: {end:?} after {after:?}");
    assert!(hung_or_spun(end), "{end:?}");
}
