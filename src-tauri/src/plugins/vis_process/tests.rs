// The visualizer process rule on hand-built WebView2 lists: every refusal of the guard, the app
// origin match, the busy run, and the shown set between samples. The list helpers serve the watch
// tests too.

// -- Library Imports --
use std::collections::BTreeSet;

// -- Local Imports --
use super::*;

pub(super) const LABEL: &str = "pv-0123456789abcdef0123456789abcdef";
pub(super) const OTHER: &str = "pv-fedcba9876543210fedcba9876543210";
pub(super) const VIS: &str = "https://pv-0123456789abcdef0123456789abcdef.invalid/vis/index.html";
pub(super) const VIS_OTHER: &str = "https://pv-fedcba9876543210fedcba9876543210.invalid/a.html";
pub(super) const PAGE: &str = "https://pp-0123456789abcdef0123456789abcdef.invalid/index.html";
pub(super) const APP: &str = "http://tauri.localhost/";
const DEV_APP: &str = "http://localhost:1420/?window=main";
pub(super) const SECOND: Duration = Duration::from_secs(1);

pub(super) fn frame(source: &str, main: bool) -> Frame {
    Frame {
        source: source.to_string(),
        main,
    }
}

pub(super) fn renderer(pid: u32, frames: Vec<Frame>) -> Listed {
    Listed {
        pid,
        renderer: true,
        frames,
    }
}

fn other(pid: u32) -> Listed {
    Listed {
        pid,
        renderer: false,
        frames: vec![],
    }
}

pub(super) fn list() -> Vec<Listed> {
    vec![
        other(1),
        renderer(4, vec![frame(APP, true)]),
        renderer(5, vec![frame(VIS, false), frame(VIS, false)]),
        renderer(6, vec![frame(VIS, false), frame(PAGE, false)]),
        renderer(7, vec![]),
        renderer(9, vec![frame(APP, true), frame(VIS, false)]),
        renderer(10, vec![frame(VIS, true)]),
    ]
}

pub(super) fn labels(of: &[&str]) -> BTreeSet<String> {
    of.iter().map(|l| l.to_string()).collect()
}

// ---- Guard ----

#[test]
fn a_renderer_serving_visualizer_frames_only_may_be_ended() {
    assert_eq!(end_allowed(&list(), &[], 5, 50), Ok(()));
}

#[test]
fn the_main_document_is_refused() {
    assert_eq!(
        end_allowed(&list(), &[(4, 0)], 4, 0),
        Err(Refusal::MainDocument)
    );
    // The main document's process hosting a visualizer frame as well.
    assert_eq!(
        end_allowed(&list(), &[(9, 0)], 9, 0),
        Err(Refusal::MainDocument)
    );
}

#[test]
fn a_mixed_process_is_refused() {
    assert_eq!(
        end_allowed(&list(), &[(6, 0)], 6, 0),
        Err(Refusal::OutsideVisHosts)
    );
    for beside in ["about:blank", "", DEV_APP] {
        let mut list = list();
        list.push(renderer(20, vec![frame(VIS, false), frame(beside, false)]));
        let refused = end_allowed(&list, &[], 20, 0);
        assert_eq!(refused, Err(Refusal::OutsideVisHosts), "{beside:?}");
    }
}

#[test]
fn a_process_holding_a_main_frame_is_refused() {
    assert_eq!(
        end_allowed(&list(), &[(10, 0)], 10, 0),
        Err(Refusal::MainFrame)
    );
}

#[test]
fn a_frameless_process_needs_its_earlier_listing_under_the_same_creation_time() {
    assert_eq!(end_allowed(&list(), &[(7, 70)], 7, 70), Ok(()));
    // The pid was reused: the process behind it now was created later.
    for (seen, created) in [(&[(7, 70)][..], 71), (&[(8, 70)], 70), (&[], 70)] {
        let refused = end_allowed(&list(), seen, 7, created);
        assert_eq!(refused, Err(Refusal::FramelessUnseen), "{seen:?}");
    }
}

#[test]
fn a_list_with_no_main_frame_on_the_app_origin_refuses_everything() {
    let vis = renderer(5, vec![frame(VIS, false)]);
    let refused = end_allowed(std::slice::from_ref(&vis), &[], 5, 0);
    assert_eq!(refused, Err(Refusal::NoAppDocument));
    // A main frame elsewhere is no proof of where the main document lives.
    let fake = renderer(10, vec![frame(VIS, true)]);
    let refused = end_allowed(&[vis.clone(), fake], &[], 5, 0);
    assert_eq!(refused, Err(Refusal::NoAppDocument));
    let not_main = renderer(4, vec![frame(APP, false)]);
    let refused = end_allowed(&[vis.clone(), not_main], &[], 5, 0);
    assert_eq!(refused, Err(Refusal::NoAppDocument));
    let dev = renderer(4, vec![frame(DEV_APP, true)]);
    assert_eq!(end_allowed(&[vis, dev], &[], 5, 0), Ok(()));
}

#[test]
fn the_app_origin_matches_exactly() {
    let vis = renderer(5, vec![frame(VIS, false)]);
    for spoof in [
        "http://tauri.localhost.x/",
        "http://tauri.localhost.x",
        "http://user@tauri.localhost/",
        "http://tauri.localhost@evil.test/",
        "http://localhost:14200/",
        "http://localhost:1420.x/",
        "https://tauri.localhost/",
        "https://localhost:1420/",
        "tauri.localhost",
        "http://tauri.localhost:80/",
    ] {
        let main = renderer(4, vec![frame(spoof, true)]);
        let refused = end_allowed(&[vis.clone(), main], &[], 5, 0);
        assert_eq!(refused, Err(Refusal::NoAppDocument), "{spoof:?}");
    }
    for real in [
        "http://tauri.localhost",
        "http://tauri.localhost/",
        "http://tauri.localhost/a/b.html",
        "http://tauri.localhost?x=1",
        "http://tauri.localhost#top",
        "http://localhost:1420",
        "http://localhost:1420/",
    ] {
        let main = renderer(4, vec![frame(real, true)]);
        assert_eq!(end_allowed(&[vis.clone(), main], &[], 5, 0), Ok(()), "{real:?}");
    }
}

#[test]
fn other_processes_and_unknown_pids_are_refused() {
    let seen: Vec<(u32, u64)> = (1..=11).map(|pid| (pid, 0)).collect();
    assert_eq!(end_allowed(&list(), &seen, 1, 0), Err(Refusal::NotRenderer));
    assert_eq!(end_allowed(&list(), &seen, 11, 0), Err(Refusal::NotListed));
}

#[test]
fn an_unflagged_app_frame_is_caught_by_its_host() {
    let mut list = list();
    list.push(renderer(21, vec![frame(APP, false), frame(VIS, false)]));
    assert_eq!(
        end_allowed(&list, &[], 21, 0),
        Err(Refusal::OutsideVisHosts)
    );
}

// ---- Shown ----

#[test]
fn shown_hosts_parse_to_visualizer_labels_only() {
    let host = format!("{LABEL}.invalid");
    assert_eq!(shown_label(&host), Some(LABEL.to_string()));
    for bad in [
        LABEL,
        "pp-0123456789abcdef0123456789abcdef.invalid",
        "pv-0123456789ABCDEF0123456789ABCDEF.invalid",
        "pv-0123.invalid",
        "pv-0123456789abcdef0123456789abcdef.invalid:443",
        "pv-0123456789abcdef0123456789abcdef.invalid/x",
        "x.pv-0123456789abcdef0123456789abcdef.invalid",
        "",
    ] {
        assert_eq!(shown_label(bad), None, "{bad:?}");
    }
}

#[test]
fn a_visualizer_shown_between_samples_counts_for_that_interval_only() {
    let mine = labels(&[LABEL]);
    let mut shown = Shown::new();
    shown.report(labels(&[LABEL]));
    shown.report(BTreeSet::new());
    assert_eq!(shown.take_interval().clear_for(&mine, 0), Err(Refusal::Shown));
    assert_eq!(shown.take_interval().clear_for(&mine, 0), Ok(()));
    shown.report(labels(&[OTHER]));
    assert_eq!(shown.take_interval().clear_for(&mine, 0), Ok(()));
    let theirs = labels(&[OTHER]);
    assert_eq!(shown.take_interval().clear_for(&theirs, 0), Err(Refusal::Shown));
}

#[test]
fn the_shown_set_is_unknown_until_a_report_and_after_a_rejection() {
    let mine = labels(&[LABEL]);
    let mut shown = Shown::new();
    assert_eq!(shown.peek().clear_for(&mine, 0), Err(Refusal::ShownUnknown));
    shown.report(BTreeSet::new());
    assert_eq!(shown.peek().clear_for(&mine, 0), Ok(()));
    shown.reject();
    assert_eq!(shown.take_interval().clear_for(&mine, 0), Err(Refusal::ShownUnknown));
    assert_eq!(shown.take_interval().clear_for(&mine, 0), Err(Refusal::ShownUnknown));
    shown.report(BTreeSet::new());
    assert_eq!(shown.peek().clear_for(&mine, 0), Ok(()));
    assert_eq!(shown.reports(), 2);
    assert_eq!(
        shown.peek().clear_for(&mine, 2),
        Err(Refusal::NoReportSinceTracked)
    );
}

// ---- Load ----

#[test]
fn ten_seconds_near_one_core_completes_a_run() {
    let mut load = Load::default();
    for _ in 0..9 {
        assert!(!load.observe(10_000_000, SECOND, false));
    }
    assert!(load.observe(10_000_000, SECOND, false));
    let mut long = Load::default();
    assert!(long.observe(100_000_000, BUSY_FOR, false));
}

#[test]
fn a_quiet_or_shown_interval_restarts_the_run() {
    for (cpu, shown) in [(8_000_000, false), (10_000_000, true)] {
        let mut load = Load::default();
        for _ in 0..9 {
            load.observe(10_000_000, SECOND, false);
        }
        assert!(!load.observe(cpu, SECOND, shown));
        for _ in 0..9 {
            assert!(!load.observe(10_000_000, SECOND, false));
        }
        assert!(load.observe(10_000_000, SECOND, false));
    }
}

#[test]
fn the_bar_is_nine_tenths_of_one_core_over_a_full_run() {
    let mut under = Load::default();
    for _ in 0..30 {
        assert!(!under.observe(8_900_000, SECOND, false));
    }
    let mut at = Load::default();
    for _ in 0..9 {
        assert!(!at.observe(9_000_000, SECOND, false));
    }
    assert!(at.observe(9_000_000, SECOND, false));
    assert_eq!(share_of_one_core(10_000_000, SECOND), 1.0);
    assert_eq!(share_of_one_core(1, Duration::ZERO), 0.0);
    assert!(!at.observe(10_000_000, Duration::ZERO, false));
}
