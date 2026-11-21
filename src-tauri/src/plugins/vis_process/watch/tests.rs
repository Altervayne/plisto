// The watch on hand-built lists: how it tracks, confirms and taints renderers, when one comes due,
// what the final check before ending refuses, and when the thread may stop.

// -- Library Imports --
use std::collections::BTreeSet;
use std::time::Instant;

// -- Local Imports --
use super::super::tests::{frame, labels, list, renderer, APP, LABEL, OTHER, PAGE, SECOND};
use super::super::tests::{VIS, VIS_OTHER};
use super::super::{Listed, Refusal, Shown};
use super::*;

/// Ticks the watch over `list` once a second, every process busy on one core, each tick taking the
/// shown interval. Returns what each tick found due.
fn run(watch: &mut Watch<u32>, list: &[Listed], shown: &mut Shown, ticks: u64) -> Vec<u32> {
    let start = Instant::now();
    let mut due = Vec::new();
    for tick in 0..ticks {
        watch.apply(list);
        let at = start + SECOND * tick as u32;
        let interval = shown.take_interval();
        due.extend(watch.sample(at, &interval, |_| Some(10_000_000 * tick)));
    }
    due
}

/// A watch tracking renderer 5, and a shown set with a report since tracking began.
fn tracking() -> (Watch<u32>, Shown) {
    let mut watch = Watch::default();
    let mut shown = Shown::new();
    watch.add(5, 50, 5, shown.reports());
    shown.report(BTreeSet::new());
    (watch, shown)
}

fn only_app_and(process: Listed) -> Vec<Listed> {
    vec![renderer(4, vec![frame(APP, true)]), process]
}

#[test]
fn a_renderer_is_tracked_only_after_a_later_list_confirms_it() {
    let (mut watch, shown) = tracking();
    assert!(watch.seen().is_empty());
    let refused = watch.end_check(5, &list(), &shown.peek());
    assert_eq!(refused, Err(Refusal::NotConfirmed));
    assert!(watch.apply(&list()).is_empty());
    assert_eq!(watch.seen(), [(5, 50)]);
    assert_eq!(watch.end_check(5, &list(), &shown.peek()), Ok(&5));
    let refused = watch.end_check(6, &list(), &shown.peek());
    assert_eq!(refused, Err(Refusal::NotTracked));
    let mut fresh: Watch<u32> = Watch::default();
    assert_eq!(fresh.apply(&list()), [5]);
}

#[test]
fn a_spinning_hidden_renderer_comes_due_after_ten_seconds() {
    let (mut watch, mut shown) = tracking();
    assert!(run(&mut watch, &list(), &mut shown, 10).is_empty());
    let (mut watch, mut shown) = tracking();
    assert_eq!(run(&mut watch, &list(), &mut shown, 11), [5]);
    assert_eq!(watch.end_check(5, &list(), &shown.peek()), Ok(&5));
}

#[test]
fn a_shown_visualizer_keeps_its_renderer_alive() {
    let (mut watch, mut shown) = tracking();
    shown.report(labels(&[LABEL]));
    assert!(run(&mut watch, &list(), &mut shown, 30).is_empty());
    let refused = watch.end_check(5, &list(), &shown.peek());
    assert_eq!(refused, Err(Refusal::Shown));
    shown.report(labels(&[OTHER]));
    assert_eq!(run(&mut watch, &list(), &mut shown, 11), [5]);
}

#[test]
fn a_label_shown_in_the_final_list_or_just_before_the_end_refuses() {
    let (mut watch, mut shown) = tracking();
    shown.report(labels(&[OTHER]));
    assert_eq!(run(&mut watch, &list(), &mut shown, 11), [5]);
    let now_other = only_app_and(renderer(5, vec![frame(VIS_OTHER, false)]));
    let refused = watch.end_check(5, &now_other, &shown.peek());
    assert_eq!(refused, Err(Refusal::Shown));
    shown.report(labels(&[LABEL]));
    shown.report(BTreeSet::new());
    let refused = watch.end_check(5, &list(), &shown.peek());
    assert_eq!(refused, Err(Refusal::Shown));
    shown.take_interval();
    assert_eq!(watch.end_check(5, &list(), &shown.peek()), Ok(&5));
}

#[test]
fn no_report_since_tracking_began_refuses() {
    let mut watch = Watch::default();
    let mut shown = Shown::new();
    shown.report(BTreeSet::new());
    watch.add(5, 50, 5, shown.reports());
    assert!(run(&mut watch, &list(), &mut shown, 30).is_empty());
    let refused = watch.end_check(5, &list(), &shown.peek());
    assert_eq!(refused, Err(Refusal::NoReportSinceTracked));
    shown.report(BTreeSet::new());
    assert_eq!(run(&mut watch, &list(), &mut shown, 11), [5]);
}

#[test]
fn a_rejected_report_refuses_until_a_valid_one_arrives() {
    let (mut watch, mut shown) = tracking();
    assert!(run(&mut watch, &list(), &mut shown, 5).is_empty());
    shown.reject();
    assert!(run(&mut watch, &list(), &mut shown, 30).is_empty());
    let refused = watch.end_check(5, &list(), &shown.peek());
    assert_eq!(refused, Err(Refusal::ShownUnknown));
    shown.report(BTreeSet::new());
    assert_eq!(run(&mut watch, &list(), &mut shown, 11), [5]);
}

#[test]
fn a_renderer_that_lost_its_frames_keeps_its_plugin() {
    let (mut watch, mut shown) = tracking();
    watch.apply(&list());
    let frameless = only_app_and(renderer(5, vec![]));
    shown.report(labels(&[LABEL]));
    assert!(run(&mut watch, &frameless, &mut shown, 30).is_empty());
    assert_eq!(watch.seen(), [(5, 50)]);
    shown.report(BTreeSet::new());
    assert_eq!(run(&mut watch, &frameless, &mut shown, 11), [5]);
    assert_eq!(watch.end_check(5, &frameless, &shown.peek()), Ok(&5));
}

#[test]
fn an_unconfirmed_handle_on_a_reused_pid_never_comes_due() {
    // The pid was listed serving visualizer frames, then reused before a list confirmed it.
    let (mut watch, mut shown) = tracking();
    let frameless = only_app_and(renderer(5, vec![]));
    assert!(run(&mut watch, &frameless, &mut shown, 30).is_empty());
    assert!(watch.seen().is_empty());
    let refused = watch.end_check(5, &frameless, &shown.peek());
    assert_eq!(refused, Err(Refusal::NotConfirmed));
}

#[test]
fn a_renderer_listed_with_another_frame_is_tainted_for_good() {
    let (mut watch, mut shown) = tracking();
    watch.apply(&list());
    let mixed = vec![renderer(5, vec![frame(VIS, false), frame(VIS_OTHER, false)])];
    watch.apply(&mixed);
    assert_eq!(watch.seen(), [(5, 50)]);
    let mixed = vec![renderer(5, vec![frame(VIS, false), frame(PAGE, false)])];
    assert!(run(&mut watch, &mixed, &mut shown, 12).is_empty());
    assert!(run(&mut watch, &list(), &mut shown, 12).is_empty());
    assert!(watch.seen().is_empty());
    let refused = watch.end_check(5, &list(), &shown.peek());
    assert_eq!(refused, Err(Refusal::NotConfirmed));
}

#[test]
fn a_renderer_gone_from_the_list_is_dropped() {
    let (mut watch, _) = tracking();
    watch.apply(&list());
    assert!(!watch.idle(&list()));
    let without: Vec<Listed> = list().into_iter().filter(|p| p.pid != 5).collect();
    watch.apply(&without);
    assert!(!watch.is_tracking());
    assert!(!watch.idle(&without));
    let quiet = only_app_and(renderer(7, vec![]));
    assert!(watch.idle(&quiet));
}

#[test]
fn a_failed_reading_restarts_the_run() {
    let (mut watch, mut shown) = tracking();
    let start = Instant::now();
    let mut due = Vec::new();
    for tick in 0..20u64 {
        watch.apply(&list());
        let at = start + SECOND * tick as u32;
        let cpu = (tick != 8).then_some(10_000_000 * tick);
        due.extend(watch.sample(at, &shown.take_interval(), |_| cpu));
    }
    // Readings resume at tick 9, so the first interval ends at tick 10 and the run at tick 19.
    assert_eq!(due, [5]);
}

#[test]
fn failed_lists_keep_a_tracking_watch_alive() {
    let mut idle = 3;
    for _ in 0..100 {
        idle = idle_after(idle, false, None, true);
    }
    assert_eq!(idle, 3);
    assert_eq!(idle_after(3, false, None, false), 4);
    assert_eq!(idle_after(3, false, Some(true), true), 4);
    assert_eq!(idle_after(3, false, Some(false), false), 0);
    assert_eq!(idle_after(3, true, None, false), 0);
}
