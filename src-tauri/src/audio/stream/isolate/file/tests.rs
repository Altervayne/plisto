/*
 * Opened files through a real helper in its container: what the file cap admits, what happens on a
 * machine where the helper cannot be set up, and that a faulted file never decodes in-process. Each
 * test runs on a session of its own, so no record or warning of another test reaches it.
 */

use std::sync::mpsc;

use super::*;
use crate::audio::dsp::DspShared;
use crate::audio::source::tests::{bits, raw_samples, write_wav, TempDir};
use crate::audio::source::{open_entry, Arrival, Entry};
use crate::audio::stream::test_containers::{m4a, M4a};
use crate::audio::stream::MP4_ENTRIES_MAX;

const WAIT: Duration = Duration::from_secs(10);

fn mib(bytes: usize) -> f64 {
    bytes as f64 / f64::from(1 << 20)
}

fn tone(dir: &TempDir, name: &str) -> std::path::PathBuf {
    let path = dir.path.join(name);
    write_wav(&path, 8_000, 2, 8_000);
    path
}

fn open_by_user(path: &Path) -> Entry {
    let dsp = Arc::new(DspShared::default());
    open_entry(-1, path, None, 0.0, &dsp, None, Arrival::User)
}

#[test]
fn a_long_m4b_table_plays_under_the_file_cap() {
    // Slow storage or a busy debug build may take its time: the cap is what is measured here.
    use_test_session(Duration::from_secs(120));
    // A 20-hour AAC audiobook, past the sample tables a stream item admits, with a 64 MiB cover:
    // its opening builds every table and reads the cover.
    let frames = 20 * 3_600 * 44_100 / 1_024 + 1;
    assert!(frames > MP4_ENTRIES_MAX as usize);
    let spec = M4a {
        frames,
        cover: 64 << 20,
        ..M4a::default()
    };
    let dir = TempDir::new("m4b");
    let path = dir.path.join("book.m4b");
    std::fs::write(&path, m4a(&spec, &|_, p| p)).unwrap();

    let state = FileState::default();
    let (peak_tx, peak) = mpsc::channel();
    state.test.lock().unwrap().peak = Some(peak_tx);
    let started = Instant::now();
    let opening = open_with(&path, Some(19.5 * 3_600.0), Arc::new(state));
    let Opening::Isolated(decode, Some(_)) = opening else {
        panic!("the audiobook opens and seeks in its helper");
    };
    let opened = started.elapsed();
    let info = decode.info().expect("the helper reported the media");
    let hours = info.duration_secs.expect("the container states a length") / 3_600.0;
    assert!((hours - 20.0).abs() < 0.01, "{hours} h");
    assert!(decode.has_audio());

    drop(decode);
    let peak = peak.recv_timeout(WAIT).unwrap();
    eprintln!(
        "20 h M4B with a 64 MiB cover: opened and seeked in {opened:?}, helper peak {:.1} MiB; \
         cap {} MiB",
        mib(peak),
        FILE_HELPER_MEMORY_MAX >> 20
    );
    assert!(peak * 2 <= FILE_HELPER_MEMORY_MAX, "committed {peak} bytes");
}

#[test]
fn container_setup_failure_decodes_opened_files_in_process_and_logs() {
    let session = use_test_session(Duration::from_millis(FILE_OPEN_MS));
    let dir = TempDir::new("setup");
    let path = tone(&dir, "tone.wav");

    session.fail_setup.store(true, Ordering::Release);
    let Entry::Ready(src) = open_by_user(&path) else {
        panic!("the file plays in-process");
    };
    assert!(src.file_decode().is_none(), "no helper decodes it");
    assert_eq!(session.launches(), 1);
    assert!(session.warned(), "the session logged it");
    let played: Vec<f32> = src.collect();
    assert_eq!(bits(&played), bits(&raw_samples(&path)));
    let line = session::unavailable_line("access: the file is gone");
    assert!(line.starts_with("warn: decode isolation unavailable (access: the file is gone)"));
    assert!(line.ends_with("opened files decode in-process"));
}

#[test]
fn after_a_setup_failure_no_helper_is_launched_until_the_retry_time() {
    let session = use_test_session(Duration::from_millis(FILE_OPEN_MS));
    let dir = TempDir::new("retry");
    session.fail_setup.store(true, Ordering::Release);
    assert!(matches!(
        open_file(&tone(&dir, "a.wav"), None),
        Opening::Unavailable
    ));
    assert_eq!(session.launches(), 1);

    // The machine could set a helper up now, but none is tried before the retry time.
    session.fail_setup.store(false, Ordering::Release);
    assert!(matches!(
        open_file(&tone(&dir, "b.wav"), None),
        Opening::Unavailable
    ));
    assert_eq!(session.launches(), 1);

    session.end_setup_retry();
    assert!(matches!(
        open_file(&tone(&dir, "c.wav"), None),
        Opening::Isolated(..)
    ));
    assert_eq!(session.launches(), 2);
}

#[test]
fn a_faulted_file_with_a_failing_launch_is_not_decoded_in_process() {
    let session = use_test_session(Duration::from_millis(FILE_OPEN_MS));
    let dir = TempDir::new("faulted");
    let path = tone(&dir, "tone.wav");
    session.mark_faulted(file_key(&path));

    // The launch fails its setup.
    session.fail_setup.store(true, Ordering::Release);
    assert!(matches!(open_by_user(&path), Entry::Failed));
    assert_eq!(session.launches(), 1);
    // No launch is tried while the setup is down.
    session.fail_setup.store(false, Ordering::Release);
    assert!(matches!(open_by_user(&path), Entry::Failed));
    assert_eq!(session.launches(), 1);
    // A file that never faulted decodes in-process meanwhile.
    let Entry::Ready(src) = open_by_user(&tone(&dir, "other.wav")) else {
        panic!("the other file plays in-process");
    };
    assert!(src.file_decode().is_none());
}

#[test]
fn a_start_past_the_end_is_the_files_end() {
    use_test_session(Duration::from_millis(FILE_OPEN_MS));
    let dir = TempDir::new("past_end");
    assert!(matches!(
        open_file(&tone(&dir, "tone.wav"), Some(5.0)),
        Opening::Ended
    ));
}

#[test]
fn the_faulted_record_matches_a_path_spelled_another_way_and_stays_bounded() {
    let session = use_test_session(Duration::from_millis(FILE_OPEN_MS));
    let dir = TempDir::new("record");
    let path = tone(&dir, "tone.wav");
    session.mark_faulted(file_key(&path));
    let spelled = dir.path.join(".").join("tone.wav");
    assert!(session.is_faulted(&file_key(&spelled)));

    for n in 0..300 {
        session.mark_faulted(dir.path.join(format!("gone{n}.wav")));
    }
    assert!(
        !session.is_faulted(&file_key(&path)),
        "the oldest is forgotten"
    );
    assert!(session.is_faulted(&dir.path.join("gone299.wav")));
}
