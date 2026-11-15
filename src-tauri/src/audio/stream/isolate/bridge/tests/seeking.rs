/*
 * The watchdog across seeks. Each seek main sends restarts both clocks, so a run of seeks, as a held
 * arrow key makes, never ends a legitimate item, while a helper that answers none is killed a budget
 * after the last one. Seams sent while a seek is pending are dropped, so they neither fill the queue
 * nor hold the pump off the helper.
 */

use super::faulty::{body, item, launch_of, Item, TEST_SPIN};
use super::*;
use crate::audio::stream::test_containers::{m4a, M4a};
use crate::audio::stream::test_media::ogg_opus_bytes;
use crate::audio::stream::MP4_ENTRIES_MAX;

/// The pause between the seeks of a held arrow key.
const KEY_REPEAT: Duration = Duration::from_millis(33);

fn short_wav(control: &Arc<StreamControl>) -> Box<dyn MediaSource> {
    body(&wav_bytes(8_000, 1, 8_000), control)
}

// Requests a seek to `secs` once seeks are open; returns when it was requested.
fn seek_once_open(control: &StreamControl, secs: f64) -> Instant {
    let deadline = Instant::now() + WAIT;
    while control.request_seek(secs).is_none() {
        assert!(Instant::now() < deadline, "seeks never opened");
        thread::sleep(Duration::from_millis(1));
    }
    Instant::now()
}

// Seeks every `KEY_REPEAT` for `hold`, through targets from `first` to `last` s, taking whatever
// audio comes; the item must live through it. Returns when the last seek was requested.
fn hold_the_arrow_key(it: &Item, first: f64, last: f64, hold: Duration) -> Instant {
    seek_once_open(&it.control, first);
    let started = Instant::now();
    let mut last_seek = Instant::now();
    while started.elapsed() < hold {
        let done = started.elapsed().as_secs_f64() / hold.as_secs_f64();
        if it
            .control
            .request_seek(first + (last - first) * done)
            .is_some()
        {
            last_seek = Instant::now();
        }
        while it.reader.try_next().is_some() {}
        assert!(it.ended.try_recv().is_err(), "ended while seeking");
        thread::sleep(KEY_REPEAT);
    }
    if it.control.request_seek(last).is_some() {
        last_seek = Instant::now();
    }
    last_seek
}

#[test]
fn a_held_arrow_key_never_ends_a_legitimate_item() {
    let spec = M4a {
        frames: MP4_ENTRIES_MAX as usize - 1,
        cover: 7 << 20,
        ..M4a::default()
    };
    // Its length in seconds: 1,024 frames per AAC frame at 44.1 kHz.
    let m4a_secs = spec.frames as f64 * 1_024.0 / 44_100.0;
    let m4a = m4a(&spec, &|_, p| p);
    let ogg = ogg_opus_bytes(0x0E, 1, 1_500, 312);
    // Audio earns nothing here, and the credit is far below what the seeks cost in all: only each
    // seek filling the credit keeps the helper alive. CPU is read often, so no reading spans more
    // CPU than the credit holds.
    let spin = Duration::from_millis(500);
    for (what, bytes, last) in [("M4A", &m4a, m4a_secs - 3.0), ("Ogg Opus", &ogg, 27.0)] {
        let control = Arc::new(StreamControl::new());
        let (cpu_tx, cpu) = std::sync::mpsc::channel();
        let mut launch = Launch {
            spin,
            per_audio_sec: Duration::ZERO,
            cpu_tick: Duration::from_millis(100),
            ..Launch::default()
        };
        launch.probe.cpu = Some(cpu_tx);
        let it = item(&DECODE_HELPER, launch, &control, body(bytes, &control));
        let ready = cpu.recv_timeout(WAIT * 3).unwrap();
        hold_the_arrow_key(&it, 1.0, last, Duration::from_secs(10));
        let (end, frames) = it.drain(WAIT * 6);
        let used = cpu.recv_timeout(WAIT).unwrap().saturating_sub(ready);
        eprintln!("held arrow key on the {what}: the helper used {used:?} in all");
        assert_eq!(end, DecodeEnd::Finished, "{what}");
        assert!(frames > 0, "{what}: no audio after the last seek");
    }
}

#[test]
fn a_helper_answering_no_seek_is_spun_a_budget_after_the_last() {
    let control = Arc::new(StreamControl::new());
    let (mut launch, _pid) = launch_of(TestFault::SpinAfterSeeks);
    launch.spin = TEST_SPIN;
    let it = item(&DECODE_HELPER, launch, &control, short_wav(&control));
    let last = hold_the_arrow_key(&it, 0.1, 0.9, Duration::from_secs(5));
    // A spinning helper gets less than its core on a loaded machine, so its budget takes longer.
    assert_eq!(
        it.ended.recv_timeout(WAIT * 4),
        Ok(DecodeEnd::Isolated(Fault::Spun))
    );
    let after = last.elapsed();
    eprintln!("a helper answering no seek was spun {after:?} after the last seek");
    assert!(after >= TEST_SPIN, "spun {after:?} after the last seek");
}

// A seek the helper never answers, then a flood of chain seams; nothing is taken from the queue.
fn chain_flood(fault: TestFault, stall: Duration) -> (DecodeEnd, Duration) {
    let control = Arc::new(StreamControl::new());
    let (mut launch, _pid) = launch_of(fault);
    launch.spin = Duration::from_millis(500);
    launch.stall = stall;
    let it = item(&DECODE_HELPER, launch, &control, short_wav(&control));
    let sought = seek_once_open(&control, 0.5);
    // A spinning helper gets less than its core on a loaded machine, so its budget takes longer.
    let end = it.ended.recv_timeout(stall + WAIT * 4).unwrap();
    (end, sought.elapsed())
}

#[test]
fn a_chain_flood_behind_an_unanswered_seek_is_spun_while_burning() {
    let (end, after) = chain_flood(TestFault::ChainFloodSpin, Duration::from_millis(STALL_MS));
    eprintln!("a chain flood behind an unanswered seek was spun {after:?} after the seek");
    assert_eq!(end, DecodeEnd::Isolated(Fault::Spun));
}

#[test]
fn a_chain_flood_behind_an_unanswered_seek_is_hung_while_idle() {
    let stall = Duration::from_secs(2);
    let (end, after) = chain_flood(TestFault::ChainFloodIdle, stall);
    assert_eq!(end, DecodeEnd::Isolated(Fault::Hung));
    // The check that clears the debt for the seek also adds its own step, up to 20 ms.
    assert!(
        after + Duration::from_millis(20) >= stall,
        "hung {after:?} after the seek"
    );
}
