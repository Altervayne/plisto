/*
 * How a step ends when the helper or the storage stops answering: which ends blame the file, which
 * retry it, which only cost a cover, and when the rest of a burst is given up. The limits are
 * shortened on the burst, never waited out in full.
 */

use std::time::Instant;

use super::*;
use crate::audio::stream::isolate::test_faults::DOUBLE_READ_HINT;

// A burst whose helpers misbehave as `fault` names.
fn burst_with(fault: InspectFault) -> InspectBurst {
    let mut burst = InspectBurst::new(EDGES);
    burst.args = fault.args();
    burst
}

#[test]
fn a_second_read_while_the_first_is_stuck_ends_the_step_by_its_deadline() {
    let session = use_test_session(WAIT);
    let dir = TempDir::new("double");
    let path = dir.path.join(format!("x.{DOUBLE_READ_HINT}"));
    std::fs::write(&path, b"any bytes").unwrap();

    let mut burst = burst_with(InspectFault::DoubleRead);
    burst.limits.tags.wall = Duration::from_secs(3);
    let (release, stall) = crossbeam_channel::bounded::<()>(0);
    burst.stall_reads = Some(stall);
    let started = Instant::now();
    assert!(matches!(burst.read_tags(&path), Inspection::Faulted));
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "{:?}",
        started.elapsed()
    );
    assert!(
        session.is_faulted(&file_key(&path)),
        "the second read broke the protocol"
    );
    drop(release);
}

#[test]
fn a_silent_tag_step_on_a_fresh_helper_is_a_fault() {
    let session = use_test_session(WAIT);
    let dir = TempDir::new("silent_fresh");
    let path = dir.path.join("silent.m4a");
    tagged_m4a(&path, MARKED_TITLE, "A", None);

    // The wall limit passes with no read outstanding: the helper, not the storage, held it up.
    let mut burst = burst_with(InspectFault::Idle);
    burst.limits.tags.wall = Duration::from_millis(800);
    assert!(matches!(burst.read_tags(&path), Inspection::Faulted));
    assert!(session.is_faulted(&file_key(&path)));
    assert_eq!(burst.retries, 0);
}

#[test]
fn a_silent_tag_step_on_a_reused_helper_is_retried_in_a_fresh_one() {
    let session = use_test_session(WAIT);
    let dir = TempDir::new("silent_reused");
    let before = dir.path.join("before.m4a");
    let marked = dir.path.join("marked.m4a");
    tagged_m4a(&before, "Before", "A", None);
    tagged_m4a(&marked, MARKED_TITLE, "B", None);

    let mut burst = burst_with(InspectFault::IdleReused);
    burst.limits.tags.wall = Duration::from_millis(800);
    read(burst.read_tags(&before));
    assert_eq!(
        read(burst.read_tags(&marked)).title.as_deref(),
        Some(MARKED_TITLE)
    );
    assert_eq!(burst.retries, 1);
    assert_eq!(session.launches(), 2);
    assert!(!session.is_faulted(&file_key(&marked)));
}

#[test]
fn a_helper_stopped_dead_is_taken_for_hung_before_the_wall_limit() {
    let session = use_test_session(WAIT);
    let dir = TempDir::new("hung_tags");
    let path = dir.path.join("hung.m4a");
    tagged_m4a(&path, MARKED_TITLE, "A", None);

    let mut burst = burst_with(InspectFault::Idle);
    burst.limits.tags.quiet = Duration::from_secs(2);
    let started = Instant::now();
    assert!(matches!(burst.read_tags(&path), Inspection::Faulted));
    assert!(
        started.elapsed() < Duration::from_millis(TAG_WALL_MS),
        "{:?}",
        started.elapsed()
    );
    assert!(session.is_faulted(&file_key(&path)));
}

#[test]
fn a_cover_step_on_a_hung_helper_gives_no_cover_and_keeps_the_file() {
    let session = use_test_session(WAIT);
    let dir = TempDir::new("hung_cover");
    let path = dir.path.join("pictured.m4a");
    tagged_m4a(&path, "Pictured", "A", Some(png(40, 30)));
    let next = dir.path.join("next.m4a");
    tagged_m4a(&next, "Next", "B", None);

    // Taken for hung once quiet, well before the wall limit.
    let mut burst = burst_with(InspectFault::CoverPark);
    burst.limits.cover.quiet = Duration::from_secs(2);
    assert_eq!(
        read(burst.read_tags(&path)).title.as_deref(),
        Some("Pictured")
    );
    let started = Instant::now();
    assert!(burst.cover(None).is_none());
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "{:?}",
        started.elapsed()
    );

    // Ended by the wall limit when the quiet time is longer.
    burst.limits.cover.quiet = WAIT;
    burst.limits.cover.wall = Duration::from_millis(800);
    read(burst.read_tags(&path));
    assert!(burst.cover(None).is_none());

    assert!(
        !session.is_faulted(&file_key(&path)),
        "a cover blames nothing"
    );
    assert_eq!(read(burst.read_tags(&next)).title.as_deref(), Some("Next"));
}

#[test]
fn two_storage_stalls_in_a_row_drop_the_rest_of_the_burst_untried() {
    let session = use_test_session(WAIT);
    let dir = TempDir::new("dead_share");
    let paths: Vec<_> = (0..3).map(|n| dir.path.join(format!("{n}.m4a"))).collect();
    for path in &paths {
        tagged_m4a(path, "Song", "A", None);
    }

    let mut burst = InspectBurst::new(EDGES);
    burst.limits.tags.wall = Duration::from_millis(500);
    let (release, stall) = crossbeam_channel::bounded::<()>(0);
    burst.stall_reads = Some(stall);
    assert!(matches!(burst.read_tags(&paths[0]), Inspection::Slow));
    assert!(matches!(burst.read_tags(&paths[1]), Inspection::Slow));
    let started = Instant::now();
    assert!(matches!(burst.read_tags(&paths[2]), Inspection::Slow));
    assert!(
        started.elapsed() < Duration::from_millis(500),
        "the third is not tried"
    );
    assert_eq!(session.launches(), 2);
    assert!(paths.iter().all(|p| !session.is_faulted(&file_key(p))));
    drop(release);
}

#[test]
fn an_answer_of_the_wrong_kind_is_a_protocol_fault() {
    let session = use_test_session(WAIT);
    let dir = TempDir::new("wrong_kind");
    let path = dir.path.join("wrong.m4a");
    tagged_m4a(&path, MARKED_TITLE, "A", None);

    // A fresh helper answers the tag step with a cover.
    let mut burst = burst_with(InspectFault::WrongAnswer);
    assert!(matches!(burst.read_tags(&path), Inspection::Faulted));
    assert!(session.is_faulted(&file_key(&path)));
}

#[test]
fn a_file_a_reused_helper_died_on_is_dropped_when_no_fresh_helper_can_be_had() {
    let session = use_test_session(WAIT);
    let dir = TempDir::new("no_fresh");
    let before = dir.path.join("before.m4a");
    let marked = dir.path.join("marked.m4a");
    let after = dir.path.join("after.m4a");
    tagged_m4a(&before, "Before", "A", None);
    tagged_m4a(&marked, MARKED_TITLE, "B", None);
    tagged_m4a(&after, "After", "C", None);

    let mut burst = burst_with(InspectFault::Abort);
    read(burst.read_tags(&before));
    // The running helper is kept; any later launch fails.
    session.fail_setup.store(true, Ordering::Release);
    assert!(matches!(burst.read_tags(&marked), Inspection::Dropped));
    assert!(!session.is_faulted(&file_key(&marked)), "not proven guilty");
    assert_eq!(burst.retries, 1);
    // No helper died on the next file: it may be read in-process.
    assert!(matches!(burst.read_tags(&after), Inspection::InProcess));
}
