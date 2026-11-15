/*
 * The watchdog against helpers that wait. A helper idle behind a full queue or on an unanswered
 * read uses far less CPU than the idle allowance and owes no stall time, however long it waits; a
 * helper that burns a core in the same states is killed.
 */

use super::faulty::{body, item, launch_of, Item, TEST_SPIN};
use super::*;
use crate::audio::stream::isolate::test_faults::IDLE_BEFORE_SPIN;
use crate::audio::stream::test_media::flac_silence;
use crate::audio::stream::{GrowingWriter, PCM_MAX_MS, SPIN_IDLE_MS_PER_SEC};

/// A spin budget far under what the allowance forgives over these tests' waits, yet several of the
/// 15.6 ms ticks CPU time is charged in, so one tick early on cannot cross it.
const SHORT_SPIN: Duration = Duration::from_millis(100);

/// The CPU time a live process has used so far. A helper is the only process in its job, so this
/// is its job's accounting.
fn cpu_of(pid: u32) -> Duration {
    use windows::Win32::Foundation::FILETIME;
    use windows::Win32::System::Threading::{GetProcessTimes, PROCESS_QUERY_LIMITED_INFORMATION};

    // SAFETY: plain arguments; the handle is closed below.
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.unwrap();
    let mut times = [FILETIME::default(); 4];
    let [created, exited, kernel, user] = &mut times;
    // SAFETY: the handle is open and every out-pointer is a live FILETIME.
    unsafe { GetProcessTimes(process, created, exited, kernel, user) }.unwrap();
    // SAFETY: the handle was opened above and is closed once.
    let _ = unsafe { CloseHandle(process) };
    let ticks = |t: &FILETIME| u64::from(t.dwHighDateTime) << 32 | u64::from(t.dwLowDateTime);
    Duration::from_nanos((ticks(&times[2]) + ticks(&times[3])) * 100)
}

/// The helper's CPU per second, in ms, over `wait`.
fn idle_ms_per_sec(pid: u32, wait: Duration) -> f64 {
    let before = cpu_of(pid);
    thread::sleep(wait);
    let used = cpu_of(pid).saturating_sub(before);
    used.as_secs_f64() * 1_000.0 / wait.as_secs_f64()
}

/// An ordinary helper with `spin`, and its process id.
fn ordinary(
    spin: Duration,
    control: &Arc<StreamControl>,
    source: Box<dyn MediaSource>,
) -> (Item, u32) {
    let (pid_tx, pid) = std::sync::mpsc::channel();
    // A stall time far shorter than the waits: only main holding things up keeps the debt away.
    let launch = Launch {
        spin,
        stall: Duration::from_secs(5),
        pid: Some(pid_tx),
        ..Launch::default()
    };
    let it = item(&DECODE_HELPER, launch, control, source);
    (it, pid.recv_timeout(WAIT).unwrap())
}

/// Silent FLAC at the largest spec: a few bytes decode to a whole block, so once main stops taking,
/// the helper fills its own queue and polls it while full. The bytes and their frames.
fn polling_flac() -> (Vec<u8>, usize) {
    let (blocks, block) = (1_200, 4_096);
    (flac_silence(384_000, 8, blocks, block), blocks * block)
}

// An ordinary helper behind a full queue nobody takes from: its CPU per second over `wait`.
fn behind_a_full_queue(spin: Duration, wait: Duration) -> (Item, f64, usize) {
    let (bytes, frames) = polling_flac();
    let control = Arc::new(StreamControl::new());
    let (it, pid) = ordinary(spin, &control, body(&bytes, &control));
    let deadline = Instant::now() + WAIT * 3;
    while control.buffered_ms() < PCM_MAX_MS - 500 {
        assert!(Instant::now() < deadline, "the queue never filled");
        thread::sleep(Duration::from_millis(5));
    }
    thread::sleep(Duration::from_secs(1));
    let idle = idle_ms_per_sec(pid, wait);
    (it, idle, frames)
}

// An ordinary helper waiting on a read the network has not answered: its CPU per second over
// `wait`. The writer that answers it, and the bytes still to write.
fn on_an_unanswered_read(
    spin: Duration,
    wait: Duration,
) -> (Item, f64, GrowingWriter, Vec<u8>, usize) {
    let frames = 16_000;
    let bytes = wav_bytes(8_000, 1, frames);
    let control = Arc::new(StreamControl::new());
    let (writer, buffer) = growing_buffer(bytes.len() as u64, Arc::clone(&control));
    writer.write(&bytes[..bytes.len() / 2]).unwrap();
    let (it, pid) = ordinary(spin, &control, Box::new(buffer));
    let deadline = Instant::now() + WAIT * 3;
    while control.buffered_ms() == 0 {
        assert!(Instant::now() < deadline, "no audio came");
        thread::sleep(Duration::from_millis(5));
    }
    thread::sleep(Duration::from_secs(1));
    let idle = idle_ms_per_sec(pid, wait);
    let rest = bytes[bytes.len() / 2..].to_vec();
    (it, idle, writer, rest, frames)
}

fn assert_under_the_allowance(state: &str, idle: f64) {
    eprintln!("idle helper, {state}: {idle:.2} ms of CPU per second");
    assert!(
        idle < SPIN_IDLE_MS_PER_SEC as f64,
        "{state}: {idle:.2} ms per second"
    );
}

#[test]
fn a_paused_item_is_not_ended_by_its_idle_helper() {
    // Once main stops taking, the helper still decodes 4 s ahead into its own queue: a real cost
    // with no progress, which a budget as short as `SHORT_SPIN` would not forgive. Its idle cost
    // after is what is held to the allowance.
    let (it, idle, frames) = behind_a_full_queue(TEST_SPIN, Duration::from_secs(20));
    assert_under_the_allowance("behind a full queue", idle);
    assert!(it.ended.try_recv().is_err(), "the paused item ended");
    assert_eq!(it.drain(WAIT * 6), (DecodeEnd::Finished, frames));
}

#[test]
fn an_unanswered_read_is_not_ended_while_the_helper_idles() {
    let (it, idle, writer, rest, frames) =
        on_an_unanswered_read(SHORT_SPIN, Duration::from_secs(20));
    assert_under_the_allowance("on an unanswered read", idle);
    assert!(it.ended.try_recv().is_err(), "the waiting item ended");
    writer.write(&rest).unwrap();
    writer.finish();
    assert_eq!(it.drain(WAIT * 3), (DecodeEnd::Finished, frames));
}

#[test]
fn a_helper_sipping_under_the_idle_allowance_is_never_spun() {
    // About 15 ms per second, half the allowance, in charges of 15.6 ms that land unevenly, for
    // longer than the credit lasts at that rate with no allowance. The credit is large enough that
    // a run of unlucky seconds cannot drain it.
    let sip = Duration::from_secs(30);
    let spin = Duration::from_millis(300);
    assert!(sip.mul_f64(0.015) > spin);
    let control = Arc::new(StreamControl::new());
    let (mut launch, _pid) = launch_of(TestFault::Sip);
    launch.spin = spin;
    launch.stall = sip * 2;
    let it = item(
        &DECODE_HELPER,
        launch,
        &control,
        body(&wav_bytes(8_000, 1, 8_000), &control),
    );
    thread::sleep(sip);
    assert!(it.ended.try_recv().is_err(), "the sipping helper was ended");
    control.cancel();
    assert_eq!(it.ended.recv_timeout(WAIT), Ok(DecodeEnd::Cancelled));
}

#[test]
fn a_helper_burning_a_core_with_a_read_outstanding_is_spun() {
    let control = Arc::new(StreamControl::new());
    let (writer, buffer) = growing_buffer(1 << 20, Arc::clone(&control));
    let (mut launch, _pid) = launch_of(TestFault::ReadThenSpin);
    launch.spin = Duration::from_millis(500);
    let it = item(&DECODE_HELPER, launch, &control, Box::new(buffer));
    // A spinning helper gets less than its core on a loaded machine, so its budget takes longer.
    assert_eq!(
        it.ended.recv_timeout(WAIT * 4),
        Ok(DecodeEnd::Isolated(Fault::Spun))
    );
    drop(writer);
}

#[test]
fn a_helper_burning_a_core_behind_a_full_queue_is_spun() {
    // The helper burns a whole core from its first chunk on; once main's queue is full, nothing it
    // sends is taken, and the burn is charged.
    let control = Arc::new(StreamControl::new());
    let (mut launch, _pid) = launch_of(TestFault::BusyBehindFullQueue);
    launch.spin = Duration::from_millis(200);
    let it = item(
        &DECODE_HELPER,
        launch,
        &control,
        body(&wav_bytes(8_000, 1, 8_000), &control),
    );
    assert_eq!(
        it.ended.recv_timeout(WAIT * 3),
        Ok(DecodeEnd::Isolated(Fault::Spun))
    );
    assert!(
        control.buffered_ms() >= PCM_MAX_MS - 500,
        "killed before the queue was full"
    );
}

#[test]
fn a_wait_banks_nothing_past_the_budget_for_a_burst() {
    // The helper idles, earning thirty times the budget at a raised idle rate, then burns a core.
    // It is killed once the budget is spent: the burst is the budget plus one CPU reading's
    // interval, which a loaded machine can stretch past a second.
    // Low enough that a spinner a loaded machine starves to a sixth of a core still spends faster.
    let idle_per_sec = Duration::from_millis(150);
    let tick = Duration::from_millis(100);
    let banked = IDLE_BEFORE_SPIN.mul_f64(idle_per_sec.as_secs_f64());
    let bound = SHORT_SPIN + Duration::from_millis(1_500);
    assert!(banked >= SHORT_SPIN * 30 && banked > bound);
    let control = Arc::new(StreamControl::new());
    let (mut launch, _pid) = launch_of(TestFault::IdleThenSpin);
    launch.spin = SHORT_SPIN;
    launch.idle_per_sec = idle_per_sec;
    launch.cpu_tick = tick;
    // The helper sends nothing: only the spin should end it.
    launch.stall = IDLE_BEFORE_SPIN * 10;
    let (cpu_tx, cpu) = std::sync::mpsc::channel();
    launch.probe.cpu = Some(cpu_tx);
    let it = item(
        &DECODE_HELPER,
        launch,
        &control,
        body(&wav_bytes(8_000, 1, 8_000), &control),
    );
    let ready = cpu.recv_timeout(WAIT * 3).unwrap();
    assert_eq!(
        it.ended.recv_timeout(IDLE_BEFORE_SPIN + WAIT * 4),
        Ok(DecodeEnd::Isolated(Fault::Spun))
    );
    // The idle wait uses next to nothing, so this is the burst.
    let used = cpu.recv_timeout(WAIT).unwrap().saturating_sub(ready);
    eprintln!(
        "a helper spinning after a wait used {used:?} before the kill; budget {SHORT_SPIN:?}"
    );
    assert!(used < bound, "used {used:?}");
}

#[test]
#[ignore = "measures each idle state for two minutes"]
fn the_idle_allowance_is_five_times_the_idle_helper_cpu() {
    let wait = Duration::from_secs(120);
    let (it, full, _) = behind_a_full_queue(Duration::MAX, wait);
    it.control.cancel();
    let (it, read, _writer, _, _) = on_an_unanswered_read(Duration::MAX, wait);
    it.control.cancel();
    eprintln!(
        "idle helper CPU per second over {wait:?}: {full:.3} ms behind a full queue, {read:.3} ms \
         on an unanswered read; allowance {SPIN_IDLE_MS_PER_SEC} ms"
    );
    assert!(full.max(read) * 5.0 <= SPIN_IDLE_MS_PER_SEC as f64);
}
