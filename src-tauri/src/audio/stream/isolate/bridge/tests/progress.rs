/*
 * What counts as progress for the watchdog: audio main takes. A helper that only asks for bytes,
 * opens seeks, repeats seams or sends audio a pending seek makes stale is still found spinning or
 * hung, and the legitimate openings and seeks that send no audio for a while stay well inside the
 * spin budget.
 */

use super::faulty::{body, item, launch_of, Item, Process, TEST_SPIN};
use super::*;
use crate::audio::stream::test_containers::{comment_with, m4a, picture_comment, M4a};
use crate::audio::stream::test_media::{flac_with_seektable, ogg_opus_bytes, ogg_opus_tagged};
use crate::audio::stream::{MP4_ENTRIES_MAX, SPIN_CPU_MS};

fn short_wav(control: &Arc<StreamControl>) -> Box<dyn MediaSource> {
    body(&wav_bytes(8_000, 1, 8_000), control)
}

// Runs `fault` over a short WAV with `stall` and the test spin budget, and returns how the item
// ended.
fn ends(fault: TestFault, stall: Duration) -> DecodeEnd {
    let control = Arc::new(StreamControl::new());
    let (mut launch, pid) = launch_of(fault);
    launch.stall = stall;
    launch.spin = TEST_SPIN;
    let it = item(&DECODE_HELPER, launch, &control, short_wav(&control));
    let helper = Process::open(pid.recv_timeout(WAIT).unwrap());
    let (end, _) = it.drain(WAIT * 3);
    assert!(helper.gone_within(WAIT), "the helper outlived its item");
    end
}

#[test]
fn a_helper_reading_a_byte_at_a_time_while_spinning_is_spun() {
    // A read answered every 50 ms of CPU: were requests progress, the spin clock would never run.
    let end = ends(TestFault::ReadSpin, Duration::from_millis(STALL_MS));
    assert_eq!(end, DecodeEnd::Isolated(Fault::Spun));
}

#[test]
fn a_helper_sleeping_between_reads_is_hung() {
    // Each read is answered at once, so the helper owes main a frame through every sleep.
    let end = ends(TestFault::ReadSleep, Duration::from_secs(1));
    assert_eq!(end, DecodeEnd::Isolated(Fault::Hung));
}

#[test]
fn a_helper_opening_seeks_forever_is_hung_or_spun() {
    let end = ends(TestFault::SeekSpam, Duration::from_secs(1));
    assert!(
        matches!(end, DecodeEnd::Isolated(Fault::Hung | Fault::Spun)),
        "{end:?}"
    );
}

#[test]
fn a_helper_repeating_a_seam_forever_is_hung_or_spun() {
    // Seams carry no audio: were they progress, the helper would play nothing for ever.
    let end = ends(TestFault::BreakSpam, Duration::from_secs(1));
    assert!(
        matches!(end, DecodeEnd::Isolated(Fault::Hung | Fault::Spun)),
        "{end:?}"
    );
}

#[test]
fn stale_chunks_do_not_keep_a_helper_that_answers_no_seek_alive() {
    let control = Arc::new(StreamControl::new());
    let (mut launch, pid) = launch_of(TestFault::StaleFlood);
    launch.stall = Duration::from_secs(1);
    launch.spin = TEST_SPIN;
    let it = item(&DECODE_HELPER, launch, &control, short_wav(&control));
    let helper = Process::open(pid.recv_timeout(WAIT).unwrap());
    // A seek the helper never answers: every chunk it sends from then on is stale.
    let deadline = Instant::now() + WAIT;
    while control.request_seek(1.0).is_none() {
        assert!(Instant::now() < deadline, "seeks never opened");
        thread::sleep(Duration::from_millis(1));
    }
    let (end, _) = it.drain(WAIT * 3);
    assert!(
        matches!(end, DecodeEnd::Isolated(Fault::Hung | Fault::Spun)),
        "{end:?}"
    );
    assert!(helper.gone_within(WAIT), "the helper outlived its item");
}

// Waits for the first audio, or the first audio after the newest seek answered. Err with the end
// when the item ends first.
fn wait_for_audio(it: &Item) -> Result<(), DecodeEnd> {
    let deadline = Instant::now() + WAIT * 6;
    while it.control.buffered_ms() == 0 {
        if let Ok(end) = it.ended.try_recv() {
            return Err(end);
        }
        assert!(Instant::now() < deadline, "no audio came");
        thread::sleep(Duration::from_millis(1));
    }
    Ok(())
}

// The helper's CPU time from its Ready to its first audio and, with `seek_to`, on to the first
// audio after a seek there. Measured up to a cancel right after, so it is an upper bound. Err with
// the end when the item ends on its own first.
fn cpu_to_audio(bytes: &[u8], seek_to: Option<f64>) -> Result<Duration, DecodeEnd> {
    let control = Arc::new(StreamControl::new());
    let (cpu_tx, cpu) = std::sync::mpsc::channel();
    let mut launch = Launch::default();
    launch.probe.cpu = Some(cpu_tx);
    let it = item(&DECODE_HELPER, launch, &control, body(bytes, &control));
    let ready = cpu.recv_timeout(WAIT * 3).unwrap();
    wait_for_audio(&it)?;
    if let Some(secs) = seek_to {
        let deadline = Instant::now() + WAIT;
        let generation = loop {
            if let Some(generation) = control.request_seek(secs) {
                break generation;
            }
            assert!(Instant::now() < deadline, "seeks never opened");
            thread::sleep(Duration::from_millis(1));
        };
        while control.answered() < generation {
            if let Ok(end) = it.ended.try_recv() {
                return Err(end);
            }
            thread::sleep(Duration::from_millis(1));
        }
        wait_for_audio(&it)?;
    }
    control.cancel();
    assert_eq!(it.ended.recv_timeout(WAIT), Ok(DecodeEnd::Cancelled));
    Ok(cpu.recv_timeout(WAIT).unwrap().saturating_sub(ready))
}

#[test]
fn legit_openings_and_seeks_stay_under_half_the_spin_budget() {
    let spec = M4a {
        frames: MP4_ENTRIES_MAX as usize - 1,
        cover: 7 << 20,
        ..M4a::default()
    };
    let m4a = m4a(&spec, &|_, p| p);
    // One seek point per 16-frame block, as many as the seek table cap admits.
    let flac = flac_with_seektable(58_000, 16);
    let ogg = ogg_opus_bytes(0x0E, 1, 1_500, 312);
    // A cover just under the header packet cap, carried as a picture comment.
    let mut tags = b"OpusTags".to_vec();
    tags.extend(comment_with(&[&picture_comment(9, 5_900_000)]));
    let covered = ogg_opus_tagged(0x0F, 1, 500, 312, tags);
    let cases: [(&str, &[u8], f64); 4] = [
        ("M4A with full tables and cover", &m4a, 40_000.0),
        ("FLAC with a full seek table", &flac, 18.0),
        ("Ogg Opus of 30 s", &ogg, 25.0),
        ("Ogg Opus with a 7.9 MB cover comment", &covered, 8.0),
    ];
    // The budget of the build this runs in, as production launches take it.
    let budget = Duration::from_millis(SPIN_CPU_MS);
    for (what, bytes, secs) in cases {
        let opened = cpu_to_audio(bytes, None);
        let sought = cpu_to_audio(bytes, Some(secs));
        eprintln!(
            "helper CPU, {what}: {opened:?} to the first audio, {sought:?} to the first audio \
             after a seek to {secs} s; spin budget {budget:?}"
        );
        let (opened, sought) = (opened.unwrap(), sought.unwrap());
        assert!(opened * 2 < budget, "{what}: opening took {opened:?}");
        assert!(sought * 2 < budget, "{what}: seeking took {sought:?}");
    }
}
