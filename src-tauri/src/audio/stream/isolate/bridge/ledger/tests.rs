/*
 * The watchdog's accounts with made-up numbers: each way a healthy helper must live and each way a
 * hostile one must end, at the edges of every rule.
 */

use super::*;

const SPIN: Duration = Duration::from_secs(2);
const STALL: Duration = Duration::from_secs(30);
const STEP: Duration = Duration::from_millis(20);
const SEC: Duration = Duration::from_secs(1);

fn ms(n: u64) -> Duration {
    Duration::from_millis(n)
}

fn ledger() -> Ledger {
    Ledger::new(Limits {
        spin: SPIN,
        stall: STALL,
        idle_per_sec: ms(30),
        per_audio_sec: ms(1_000),
        payback: 10,
        step_max: STEP,
    })
}

// Readings of one second each with `used` CPU and `audio` accepted, until a fault or `n` readings.
// Returns the reading that faulted, counted from one.
fn readings(l: &mut Ledger, n: u32, used: Duration, audio: Duration) -> Option<u32> {
    (1..=n).find(|_| l.reading(SEC, used, audio).is_some())
}

// Stall steps of `STEP` each, until a fault or `n` steps. Returns the step that faulted.
fn steps(l: &mut Ledger, n: u32, main_holds: bool, audio: Duration) -> Option<u32> {
    (1..=n).find(|_| l.tick(STEP, main_holds, audio).is_some())
}

#[test]
fn an_idle_helper_is_never_spun_however_long_it_waits() {
    // Ten hours of polling, a 15.6 ms charge landing twice in some seconds.
    let mut l = ledger();
    for i in 0..36_000u32 {
        let used = if i % 7 == 0 { ms(31) } else { ms(5) };
        assert_eq!(l.reading(SEC, used, Duration::ZERO), None, "second {i}");
    }
}

#[test]
fn main_holding_things_up_owes_nothing() {
    // A paused item, or a read the network has not answered, for ten hours.
    let mut l = ledger();
    assert_eq!(steps(&mut l, 1_800_000, true, Duration::ZERO), None);
}

#[test]
fn a_helper_burning_a_core_spends_the_budget_and_no_more() {
    let mut l = ledger();
    // 2 s of credit, plus 30 ms and 60 ms of idle allowance: the third second cannot be paid.
    assert_eq!(readings(&mut l, 10, SEC, Duration::ZERO), Some(3));
}

#[test]
fn a_long_wait_banks_nothing_past_the_budget() {
    let mut l = ledger();
    assert_eq!(
        readings(&mut l, 36_000, Duration::ZERO, Duration::ZERO),
        None
    );
    assert_eq!(readings(&mut l, 10, SEC, Duration::ZERO), Some(3));
}

#[test]
fn a_helper_paid_for_its_audio_plays_forever() {
    // Real time decoding at 300 ms of CPU per second of audio, for ten hours.
    let mut l = ledger();
    assert_eq!(readings(&mut l, 36_000, ms(300), SEC), None);
    assert_eq!(steps(&mut l, 1_800_000, false, STEP), None);
}

#[test]
fn audio_pays_at_its_rate_and_no_faster() {
    // 1.2 s of CPU per second of audio: 170 ms a second short of what it earns, so the credit,
    // 800 ms after the first second, cannot pay the sixth.
    let mut l = ledger();
    assert_eq!(readings(&mut l, 20, ms(1_200), SEC), Some(6));
}

#[test]
fn tiny_chunks_earn_tiny_credit() {
    // 1.9 s of CPU, then a single frame at 8 kHz, over and over.
    let mut l = ledger();
    let frame = Duration::from_micros(125);
    assert_eq!(readings(&mut l, 10, ms(1_900), frame), Some(2));
    // Nor do they keep the stall clock away: a frame every 2 s pays 1.25 ms of a 2 s debt.
    let mut l = ledger();
    let fault = (1..=10_000u32).find(|n| {
        l.tick(
            STEP,
            false,
            if n % 100 == 0 { frame } else { Duration::ZERO },
        )
        .is_some()
    });
    assert!(fault.is_some_and(|n| n >= 1_500), "{fault:?}");
}

#[test]
fn a_tenth_of_real_time_pays_the_stall_debt_off() {
    let mut l = ledger();
    assert_eq!(steps(&mut l, 1_800_000, false, STEP / 10), None);
    // A twentieth does not: the debt grows at half the wall rate, a hang at 60 s.
    let mut l = ledger();
    assert_eq!(steps(&mut l, 10_000, false, STEP / 20), Some(3_000));
}

#[test]
fn the_stall_clock_hangs_at_the_stall_time() {
    let mut l = ledger();
    assert_eq!(steps(&mut l, 10_000, false, Duration::ZERO), Some(1_500));
}

#[test]
fn a_late_step_adds_no_more_than_its_cap() {
    // The machine slept for an hour between two checks.
    let mut l = ledger();
    assert_eq!(
        l.tick(Duration::from_secs(3_600), false, Duration::ZERO),
        None
    );
    assert_eq!(steps(&mut l, 10_000, false, Duration::ZERO), Some(1_499));
}

#[test]
fn a_new_seek_fills_the_credit_and_clears_the_debt() {
    let mut l = ledger();
    assert_eq!(l.reading(SEC, ms(1_900), Duration::ZERO), None);
    assert_eq!(steps(&mut l, 1_000, false, Duration::ZERO), None);
    l.seek(1);
    assert_eq!(l.reading(SEC, ms(1_900), Duration::ZERO), None);
    assert_eq!(steps(&mut l, 1_499, false, Duration::ZERO), None);
}

#[test]
fn a_seek_handed_back_again_fills_nothing() {
    // One seek from main, then the same generation over and over between bursts.
    let mut l = ledger();
    l.seek(1);
    let fault = (1..=10u32).find(|_| {
        l.seek(1);
        l.reading(SEC, ms(1_500), Duration::ZERO).is_some()
    });
    assert_eq!(fault, Some(2));
    // Nor an older one.
    let mut l = ledger();
    l.seek(5);
    assert_eq!(l.reading(SEC, ms(1_500), Duration::ZERO), None);
    l.seek(4);
    assert!(l.reading(SEC, ms(1_500), Duration::ZERO).is_some());
}

#[test]
fn a_held_arrow_key_lives_on_its_seeks() {
    // Thirty seeks a second, each costing the helper 50 ms, with nothing accepted meanwhile.
    let mut l = ledger();
    for g in 1..=300u64 {
        l.seek(g * 30);
        assert_eq!(
            l.reading(SEC, ms(1_500), Duration::ZERO),
            None,
            "second {g}"
        );
        assert_eq!(steps(&mut l, 50, false, Duration::ZERO), None);
    }
}

#[test]
fn zero_and_huge_inputs_neither_panic_nor_pay() {
    let mut l = ledger();
    assert_eq!(
        l.reading(Duration::ZERO, Duration::ZERO, Duration::ZERO),
        None
    );
    assert_eq!(l.tick(Duration::ZERO, false, Duration::ZERO), None);
    // Huge wall time and audio fill the credit to its cap and no further.
    assert_eq!(
        l.reading(Duration::MAX, Duration::ZERO, Duration::MAX),
        None
    );
    assert_eq!(readings(&mut l, 10, SEC, Duration::ZERO), Some(3));
    assert_eq!(l.tick(Duration::MAX, false, Duration::MAX), None);
    assert!(l.reading(SEC, Duration::MAX, Duration::ZERO).is_some());
    l.seek(u64::MAX);
    l.seek(u64::MAX);
    assert_eq!(l.reading(SEC, SPIN, Duration::ZERO), None);
}
