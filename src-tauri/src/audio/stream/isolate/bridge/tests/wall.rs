/*
 * The wall: a helper that spins, hangs, exits, crashes, breaks the protocol or runs out of memory
 * ends its item with the fault for it, the helper dies with it, and this process lives on. Every
 * helper here runs in its real container and job.
 */

use super::faulty::{body, item, launch_of, Process, TEST_SPIN};
use super::*;
use crate::audio::stream::isolate::test_faults::GUARDS_OFF;
use crate::audio::stream::PCM_MAX_MS;

/// A WAV whose `LIST`/`INFO` title declares 0xFFFF_FFF0 bytes. A RIFF and a `LIST` that both
/// declare `u32::MAX` bytes let symphonia take the title's length as it stands.
fn forged_4gib_wav() -> Vec<u8> {
    let mut v = b"RIFF\xFF\xFF\xFF\xFFWAVEfmt ".to_vec();
    v.extend_from_slice(&16u32.to_le_bytes());
    v.extend_from_slice(&1u16.to_le_bytes());
    v.extend_from_slice(&1u16.to_le_bytes());
    v.extend_from_slice(&44_100u32.to_le_bytes());
    v.extend_from_slice(&88_200u32.to_le_bytes());
    v.extend_from_slice(&2u16.to_le_bytes());
    v.extend_from_slice(&16u16.to_le_bytes());
    v.extend_from_slice(b"LIST");
    v.extend_from_slice(&u32::MAX.to_le_bytes());
    v.extend_from_slice(b"INFOINAM");
    v.extend_from_slice(&0xFFFF_FFF0u32.to_le_bytes());
    v.extend_from_slice(b"title");
    v
}

fn short_wav(control: &Arc<StreamControl>) -> Box<dyn MediaSource> {
    body(&wav_bytes(8_000, 1, 8_000), control)
}

#[test]
fn a_forged_4gib_size_ends_the_item_and_the_host_lives() {
    let control = Arc::new(StreamControl::new());
    let (peak_tx, peak) = std::sync::mpsc::channel();
    let mut launch = Launch {
        args: &[GUARDS_OFF],
        ..Launch::default()
    };
    launch.probe.peak = Some(peak_tx);
    let forged = item(
        &DECODE_HELPER,
        launch,
        &control,
        body(&forged_4gib_wav(), &control),
    );
    assert_eq!(forged.drain(WAIT * 3).0, DecodeEnd::Isolated(Fault::Memory));
    let peak = peak.recv_timeout(WAIT).unwrap();
    assert!(peak <= HELPER_MEMORY_MAX, "committed {peak} bytes");
    // A clean WAV then decodes through a new helper.
    let control = Arc::new(StreamControl::new());
    let clean = item(
        &DECODE_HELPER,
        Launch::default(),
        &control,
        short_wav(&control),
    );
    assert_eq!(clean.drain(WAIT * 3), (DecodeEnd::Finished, 8_000));
}

#[test]
fn a_spinning_helper_is_killed_within_the_budget() {
    let control = Arc::new(StreamControl::new());
    let (mut launch, pid) = launch_of(TestFault::Spin);
    launch.spin = TEST_SPIN;
    let it = item(&DECODE_HELPER, launch, &control, short_wav(&control));
    let helper = Process::open(pid.recv_timeout(WAIT).unwrap());
    let ready = Instant::now();
    assert_eq!(it.drain(WAIT * 3).0, DecodeEnd::Isolated(Fault::Spun));
    eprintln!(
        "spinning helper killed {:?} after its Ready",
        ready.elapsed()
    );
    assert!(ready.elapsed() >= TEST_SPIN);
    assert!(helper.gone_within(WAIT), "the helper outlived its item");
}

#[test]
fn a_silent_helper_is_hung_after_its_stall_time() {
    let control = Arc::new(StreamControl::new());
    let (mut launch, pid) = launch_of(TestFault::Silent);
    let stall = Duration::from_secs(1);
    launch.stall = stall;
    let it = item(&DECODE_HELPER, launch, &control, short_wav(&control));
    let helper = Process::open(pid.recv_timeout(WAIT).unwrap());
    let ready = Instant::now();
    assert_eq!(it.drain(WAIT).0, DecodeEnd::Isolated(Fault::Hung));
    assert!(ready.elapsed() >= stall);
    assert!(helper.gone_within(WAIT), "the helper outlived its item");
}

#[test]
fn waiting_on_bytes_or_on_a_full_queue_is_not_a_hang() {
    // A wait longer than the stall time, so either wait counted as the helper's would hang the
    // item, and a stall time no starved helper reaches on its own work between reads and pushes,
    // the only time the debt grows here.
    let stall = Duration::from_secs(5);
    let idle = Duration::from_secs(8);
    // The helper waits on main for bytes the network has not delivered.
    let bytes = wav_bytes(8_000, 1, 16_000);
    let control = Arc::new(StreamControl::new());
    let (writer, buffer) = growing_buffer(bytes.len() as u64, Arc::clone(&control));
    writer.write(&bytes[..bytes.len() / 2]).unwrap();
    let launch = Launch {
        stall,
        ..Launch::default()
    };
    let it = item(&DECODE_HELPER, launch, &control, Box::new(buffer));
    let until = Instant::now() + idle;
    let mut frames = 0;
    while Instant::now() < until {
        while let Some(segment) = it.reader.try_next() {
            if let Segment::Chunk(chunk) = segment {
                frames += chunk.frames();
            }
        }
        assert!(it.ended.try_recv().is_err(), "ended waiting on bytes");
        thread::sleep(Duration::from_millis(5));
    }
    writer.write(&bytes[bytes.len() / 2..]).unwrap();
    writer.finish();
    let (end, rest) = it.drain(WAIT * 3);
    assert_eq!((end, frames + rest), (DecodeEnd::Finished, 16_000));

    // The helper is blocked behind a full queue nobody takes from.
    let control = Arc::new(StreamControl::new());
    let launch = Launch {
        stall,
        ..Launch::default()
    };
    let frames = 48_000 * 8;
    let it = item(
        &DECODE_HELPER,
        launch,
        &control,
        body(&wav_bytes(48_000, 2, frames), &control),
    );
    let deadline = Instant::now() + WAIT * 3;
    while control.buffered_ms() < PCM_MAX_MS - 500 {
        assert!(Instant::now() < deadline, "the queue never filled");
        thread::sleep(Duration::from_millis(5));
    }
    thread::sleep(idle);
    assert!(it.ended.try_recv().is_err(), "ended behind a full queue");
    assert_eq!(it.drain(WAIT * 3), (DecodeEnd::Finished, frames));
}

#[test]
fn a_silent_exit_is_protocol() {
    let control = Arc::new(StreamControl::new());
    let (launch, _pid) = launch_of(TestFault::Quit);
    let it = item(&DECODE_HELPER, launch, &control, short_wav(&control));
    assert_eq!(it.drain(WAIT).0, DecodeEnd::Isolated(Fault::Protocol));
}

#[test]
fn a_bad_frame_kills_and_ends_protocol() {
    let control = Arc::new(StreamControl::new());
    let (launch, pid) = launch_of(TestFault::Garbage);
    let it = item(&DECODE_HELPER, launch, &control, short_wav(&control));
    let helper = Process::open(pid.recv_timeout(WAIT).unwrap());
    assert_eq!(it.drain(WAIT).0, DecodeEnd::Isolated(Fault::Protocol));
    assert!(helper.gone_within(WAIT), "the helper outlived its item");
}

#[test]
fn an_abort_in_the_helper_is_crashed() {
    let control = Arc::new(StreamControl::new());
    let (launch, _pid) = launch_of(TestFault::Abort);
    let it = item(&DECODE_HELPER, launch, &control, short_wav(&control));
    assert_eq!(it.drain(WAIT).0, DecodeEnd::Isolated(Fault::Crashed));
}

#[test]
fn a_leaked_write_end_does_not_hide_a_dead_helper() {
    // This test holds duplicates of both of the helper's pipe ends past its death, as a std spawn
    // that inherited them would. The helper asks for a read larger than its stdin pipe holds, never
    // takes the answer, and exits: main's writer is left blocked on a pipe that never breaks.
    let control = Arc::new(StreamControl::new());
    let (mut launch, pid) = launch_of(TestFault::Die);
    let (leaks_tx, leaks) = std::sync::mpsc::channel();
    launch.probe.leaks = Some(leaks_tx);
    let it = item(&DECODE_HELPER, launch, &control, short_wav(&control));
    let held = leaks.recv_timeout(WAIT).unwrap();
    assert_eq!(held.len(), 2);
    let helper = Process::open(pid.recv_timeout(WAIT).unwrap());
    assert!(helper.gone_within(WAIT), "the helper never exited");
    let died = Instant::now();
    assert_eq!(it.drain(WAIT).0, DecodeEnd::Isolated(Fault::Crashed));
    eprintln!("dead helper seen {:?} after its exit", died.elapsed());
    assert!(died.elapsed() < Duration::from_secs(1));
    assert!(
        it.threads_gone_within(EXIT_WAIT),
        "a bridge thread outlived the item"
    );
    drop(held);
}

// A session of its own: launches that fail before Ready move a session to its fallback.
static VANISHING: Session = Session::new(crate::proc::helper::HELPER_PROFILE);

#[test]
fn a_leaked_pipe_does_not_hold_a_launch_whose_helper_died() {
    // Every attempt's helper exits before its Ready with its stdout held open by a duplicate, so
    // only its process handle tells the launch it is gone.
    let control = Arc::new(StreamControl::new());
    let (mut launch, _pid) = launch_of(TestFault::Vanish);
    let (leaks_tx, _leaks) = std::sync::mpsc::channel();
    launch.probe.leaks = Some(leaks_tx);
    let started = Instant::now();
    let it = item(&VANISHING, launch, &control, short_wav(&control));
    assert_eq!(it.drain(WAIT * 3).0, DecodeEnd::Isolated(Fault::Spawn));
    eprintln!(
        "three launches of a vanished helper failed in {:?}",
        started.elapsed()
    );
    assert!(started.elapsed() < WAIT);
}
