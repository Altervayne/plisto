// The visualizer store against throwaway app data folders: the build key, marks, the turned-back-on
// record, stills, the reset trial marker, and what an update, a reload and an uninstall do to them.

// -- Library Imports --
use std::sync::atomic::AtomicBool;

// -- Local Imports --
use super::*;
use crate::plugins::dev_mode;
use crate::plugins::install::install;
use crate::plugins::lifecycle::uninstall;
use crate::plugins::stage::Limits;
use crate::plugins::test_kit::{ui, Kit, ID};
use crate::plugins::update::update;

fn png(tail: &[u8]) -> Vec<u8> {
    let mut bytes = PNG_SIGNATURE.to_vec();
    bytes.extend_from_slice(tail);
    bytes
}

/// A kit with the demo plugin installed from a source folder holding one extra file `a.js`.
fn installed(extra: &[u8]) -> (Kit, PathBuf) {
    let k = Kit::new();
    let src = k.source(&ui("1.0.0", &[]), &[("a.js", extra)]);
    let token = k.inspect_path(&src).token;
    install(&k.data, &k.plugins, &token, 10).unwrap();
    (k, src)
}

fn fresh_flag() -> AtomicBool {
    AtomicBool::new(false)
}

#[test]
fn the_build_key_follows_the_bytes_and_nothing_else() {
    let (k, _) = installed(b"one");
    let dir = plugin_dir(&k.data, ID);
    let first = build_key(&dir).unwrap();
    assert_eq!(first, build_key(&dir).unwrap());
    fs::write(dir.join("a.js"), b"onf").unwrap();
    assert_ne!(first, build_key(&dir).unwrap());
    fs::write(dir.join("a.js"), b"one").unwrap();
    assert_eq!(first, build_key(&dir).unwrap());
    // The same bytes under another name are another build.
    fs::rename(dir.join("a.js"), dir.join("b.js")).unwrap();
    assert_ne!(first, build_key(&dir).unwrap());
}

#[test]
fn install_records_the_key() {
    let (k, _) = installed(b"one");
    let stored = read_store(&vis_store_dir(&k.data, ID));
    assert_eq!(stored.key, build_key(&plugin_dir(&k.data, ID)).unwrap());
}

#[test]
fn a_mark_reads_back_and_clearing_it_records_the_turn_back_on() {
    let (k, _) = installed(b"one");
    set_mark(&k.data, ID, "ridge", VisMark::Flashing).unwrap();
    set_mark(&k.data, ID, "ridge", VisMark::GraphicsReset).unwrap();
    let read = marks_after(&k.data, &fresh_flag());
    assert_eq!(
        read,
        vec![KindState {
            id: ID.to_string(),
            kind: "ridge".to_string(),
            flashing: true,
            graphics_reset: true,
            turned_back_on: false,
            trialed: false,
        }]
    );
    clear_mark(&k.data, ID, "ridge").unwrap();
    let read = marks_after(&k.data, &fresh_flag());
    assert_eq!(read.len(), 1);
    assert!(!read[0].flashing && !read[0].graphics_reset && read[0].turned_back_on);
    // A flashing mark is ignored for a kind turned back on; a graphics reset cancels the record.
    set_mark(&k.data, ID, "ridge", VisMark::Flashing).unwrap();
    let read = marks_after(&k.data, &fresh_flag());
    assert!(!read[0].flashing && read[0].turned_back_on);
    set_mark(&k.data, ID, "ridge", VisMark::GraphicsReset).unwrap();
    let read = marks_after(&k.data, &fresh_flag());
    assert!(read[0].graphics_reset && !read[0].turned_back_on);
}

#[test]
fn a_trial_marker_left_behind_becomes_a_reset_mark_at_the_first_read() {
    let (k, _) = installed(b"one");
    trial_begin(&k.data, ID, "ridge").unwrap();
    let marker = vis_store_dir(&k.data, ID).join("trial.ridge");
    assert!(marker.exists());
    // Another process starts: its flag is fresh.
    let flag = fresh_flag();
    let read = marks_after(&k.data, &flag);
    assert_eq!(read.len(), 1);
    assert!(read[0].graphics_reset && !read[0].flashing);
    assert!(!marker.exists());
    // Once per process: a marker written later is not swept by a second read.
    fs::write(&marker, read_store(&vis_store_dir(&k.data, ID)).key).unwrap();
    marks_after(&k.data, &flag);
    assert!(marker.exists());
}

#[test]
fn a_trial_that_ends_leaves_no_mark() {
    let (k, _) = installed(b"one");
    trial_begin(&k.data, ID, "ridge").unwrap();
    trial_end(&k.data, ID, "ridge", false).unwrap();
    trial_end(&k.data, ID, "ridge", false).unwrap();
    assert!(marks_after(&k.data, &fresh_flag()).is_empty());
}

#[test]
fn a_marker_from_an_older_build_is_dropped() {
    let (k, _) = installed(b"one");
    trial_begin(&k.data, ID, "ridge").unwrap();
    fs::write(plugin_dir(&k.data, ID).join("a.js"), b"two").unwrap();
    record_build(&k.data, ID).unwrap();
    assert!(marks_after(&k.data, &fresh_flag()).is_empty());
}

#[test]
fn stills_round_trip_per_kind_and_theme() {
    let (k, _) = installed(b"one");
    let dark = png(b"dark");
    thumb_put(&k.data, ID, "ridge", VisTheme::Dark, &dark).unwrap();
    let got = thumb_get(&k.data, ID, "ridge", VisTheme::Dark).unwrap();
    assert_eq!(got, Some(dark));
    assert_eq!(thumb_get(&k.data, ID, "ridge", VisTheme::Light).unwrap(), None);
    assert_eq!(thumb_get(&k.data, ID, "other", VisTheme::Dark).unwrap(), None);
}

#[test]
fn an_oversize_or_non_png_still_is_refused() {
    let (k, _) = installed(b"one");
    let big = png(&vec![0; STILL_MAX]);
    assert!(thumb_put(&k.data, ID, "ridge", VisTheme::Dark, &big).is_err());
    let at_cap = png(&vec![0; STILL_MAX - PNG_SIGNATURE.len()]);
    thumb_put(&k.data, ID, "ridge", VisTheme::Dark, &at_cap).unwrap();
    assert!(thumb_put(&k.data, ID, "ridge", VisTheme::Dark, b"not a png").is_err());
}

#[test]
fn bad_ids_are_refused_before_any_path_is_built() {
    let (k, _) = installed(b"one");
    for id in ["../x", "a", "Com.Example.Demo", "com.example.demo/..", ""] {
        assert!(set_mark(&k.data, id, "ridge", VisMark::Flashing).is_err());
        assert!(trial_begin(&k.data, id, "ridge").is_err());
        assert!(thumb_get(&k.data, id, "ridge", VisTheme::Dark).is_err());
    }
    for kind in ["", "../x", "Ridge", "a/b", "trial.x", &"k".repeat(25)] {
        assert!(set_mark(&k.data, ID, kind, VisMark::Flashing).is_err());
        assert!(clear_mark(&k.data, ID, kind).is_err());
        assert!(trial_begin(&k.data, ID, kind).is_err());
        assert!(trial_end(&k.data, ID, kind, true).is_err());
        assert!(thumb_put(&k.data, ID, kind, VisTheme::Dark, &png(b"x")).is_err());
    }
}

#[test]
fn a_plugin_that_is_not_installed_takes_no_records() {
    let k = Kit::new();
    assert!(set_mark(&k.data, ID, "ridge", VisMark::Flashing).is_err());
    assert!(thumb_put(&k.data, ID, "ridge", VisTheme::Dark, &png(b"x")).is_err());
    assert!(!vis_store_dir(&k.data, ID).exists());
}

fn fill(k: &Kit) {
    set_mark(&k.data, ID, "ridge", VisMark::Flashing).unwrap();
    clear_mark(&k.data, ID, "ridge").unwrap();
    set_mark(&k.data, ID, "fern", VisMark::GraphicsReset).unwrap();
    assert!(trial_begin(&k.data, ID, "moss").unwrap());
    trial_end(&k.data, ID, "moss", true).unwrap();
    thumb_put(&k.data, ID, "ridge", VisTheme::Dark, &png(b"d")).unwrap();
    thumb_put(&k.data, ID, "ridge", VisTheme::Light, &png(b"l")).unwrap();
}

fn assert_empty(k: &Kit) {
    assert!(marks_after(&k.data, &fresh_flag()).is_empty());
    for theme in [VisTheme::Dark, VisTheme::Light] {
        assert_eq!(thumb_get(&k.data, ID, "ridge", theme).unwrap(), None);
    }
    let stills = vis_store_dir(&k.data, ID).join(STILLS_DIR);
    assert_eq!(fs::read_dir(stills).map_or(0, |r| r.count()), 0);
    let store = read_store(&vis_store_dir(&k.data, ID));
    assert!(store.marks.is_empty() && store.back_on.is_empty() && store.trialed.is_empty());
}

#[test]
fn a_same_version_update_with_other_bytes_drops_everything() {
    let (k, _) = installed(b"one");
    fill(&k);
    assert_eq!(marks_after(&k.data, &fresh_flag()).len(), 3);
    let next = k.source(&ui("1.0.0", &[]), &[("a.js", b"two")]);
    let token = k.inspect_path(&next).token;
    update(&k.data, &k.plugins, &token).unwrap();
    assert_empty(&k);
}

#[test]
fn a_developer_reload_with_other_bytes_drops_everything() {
    let (k, src) = installed(b"one");
    dev_mode::set(&k.data, &k.plugins, true).unwrap();
    fill(&k);
    fs::write(src.join("a.js"), b"two").unwrap();
    dev_mode::reload(&k.data, &k.plugins, ID, Limits::DEFAULT).unwrap();
    assert_empty(&k);
}

#[test]
fn an_update_with_the_same_bytes_keeps_the_records() {
    let (k, _) = installed(b"one");
    fill(&k);
    let next = k.source(&ui("1.0.0", &[]), &[("a.js", b"one")]);
    let token = k.inspect_path(&next).token;
    update(&k.data, &k.plugins, &token).unwrap();
    assert_eq!(marks_after(&k.data, &fresh_flag()).len(), 3);
}

#[test]
fn uninstall_removes_the_store_and_leaves_other_plugins_alone() {
    let (k, _) = installed(b"one");
    fill(&k);
    let other = vis_store_dir(&k.data, "com.example.other");
    fs::create_dir_all(&other).unwrap();
    uninstall(&k.data, &k.plugins, ID, false).unwrap();
    assert!(!vis_store_dir(&k.data, ID).exists());
    assert!(other.exists());
}


#[test]
fn a_trial_begun_on_a_store_without_a_key_still_becomes_a_reset_mark() {
    let (k, _) = installed(b"one");
    // A plugin installed before keys were recorded has no store.
    fs::remove_dir_all(vis_store_dir(&k.data, ID)).unwrap();
    assert!(trial_begin(&k.data, ID, "ridge").unwrap());
    let read = marks_after(&k.data, &fresh_flag());
    assert_eq!(read.len(), 1);
    assert!(read[0].graphics_reset);
}

#[test]
fn a_passed_trial_is_remembered_for_the_build_and_not_run_again() {
    let (k, _) = installed(b"one");
    assert!(trial_begin(&k.data, ID, "ridge").unwrap());
    trial_end(&k.data, ID, "ridge", true).unwrap();
    let read = marks_after(&k.data, &fresh_flag());
    assert!(read[0].trialed && !read[0].graphics_reset);
    assert!(!trial_begin(&k.data, ID, "ridge").unwrap());
    assert!(!vis_store_dir(&k.data, ID).join("trial.ridge").exists());
    // Another build trials again.
    fs::write(plugin_dir(&k.data, ID).join("a.js"), b"two").unwrap();
    record_build(&k.data, ID).unwrap();
    assert!(marks_after(&k.data, &fresh_flag()).is_empty());
    assert!(trial_begin(&k.data, ID, "ridge").unwrap());
}

#[test]
fn an_unfinished_trial_that_is_withdrawn_leaves_no_mark_and_no_record() {
    let (k, _) = installed(b"one");
    assert!(trial_begin(&k.data, ID, "ridge").unwrap());
    trial_end(&k.data, ID, "ridge", false).unwrap();
    assert!(marks_after(&k.data, &fresh_flag()).is_empty());
    assert!(trial_begin(&k.data, ID, "ridge").unwrap());
}

#[test]
fn a_kind_named_like_a_windows_device_gets_a_safe_still_file() {
    let (k, _) = installed(b"one");
    thumb_put(&k.data, ID, "con", VisTheme::Dark, &png(b"x")).unwrap();
    let got = thumb_get(&k.data, ID, "con", VisTheme::Dark).unwrap();
    assert_eq!(got, Some(png(b"x")));
    let stills = vis_store_dir(&k.data, ID).join(STILLS_DIR);
    let name = fs::read_dir(stills).unwrap().next().unwrap().unwrap().file_name();
    assert!(name.to_string_lossy().starts_with("k-con."));
}

#[test]
fn a_build_that_cannot_be_hashed_clears_the_old_records() {
    let (k, _) = installed(b"one");
    fill(&k);
    fs::remove_dir_all(plugin_dir(&k.data, ID)).unwrap();
    assert!(record_build(&k.data, ID).is_err());
    assert!(marks_after(&k.data, &fresh_flag()).is_empty());
    let stills = vis_store_dir(&k.data, ID).join(STILLS_DIR);
    assert_eq!(fs::read_dir(stills).map_or(0, |r| r.count()), 0);
}

#[test]
fn an_install_succeeds_when_the_store_cannot_be_written() {
    let k = Kit::new();
    // A file where the store root belongs makes every store write fail.
    fs::write(vis_store_root(&k.data), b"").unwrap();
    let src = k.source(&ui("1.0.0", &[]), &[]);
    let token = k.inspect_path(&src).token;
    install(&k.data, &k.plugins, &token, 10).unwrap();
    assert!(plugin_dir(&k.data, ID).is_dir());
    assert!(record_build(&k.data, ID).is_err());
}
