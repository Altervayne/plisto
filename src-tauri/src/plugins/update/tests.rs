// Updates of an installed plugin: what keeps consent, what asks again, and what a failed swap leaves.

// -- Library Imports --
use serde_json::json;
use std::sync::{Arc, Mutex};

// -- Local Imports --
use super::*;
use crate::plugins::lifecycle::{disable, enable, uninstall};
use crate::plugins::paths::{data_dir, registry_file, staging_dir, state_dir};
use crate::plugins::revalidate::{adopt_folders, manifest_hash};
use crate::plugins::stage::Limits;
use crate::plugins::test_kit::{native, ui, Kit, ID};

fn staging_count(k: &Kit) -> usize {
    fs::read_dir(staging_dir(&k.data)).map_or(0, |r| r.count())
}

/// Installed at 1.0.0 with `caps`, consented and enabled.
fn running(caps: &[&str]) -> Kit {
    let k = Kit::new();
    k.install(&ui("1.0.0", caps));
    k.enable(caps);
    k
}

#[test]
fn the_same_origin_set_carries_the_new_list_and_a_changed_set_empties_it() {
    let k = Kit::new();
    let mut first = ui("1.0.0", &["network"]);
    first["network"] = json!(["https://a.example.com", "https://b.example.com"]);
    k.install(&first);
    k.enable(&["network"]);

    let reordered = ["https://b.example.com", "https://a.example.com"];
    let mut next = ui("1.1.0", &["network"]);
    next["network"] = json!(reordered);
    let done = update(&k.data, &k.plugins, &k.inspect(&next)).unwrap();
    assert_eq!(done.row.granted_origins, reordered);
    let serving = k.plugins.enabled_set().serving(ID).unwrap();
    assert_eq!(&*serving.origins, reordered);

    let mut changed = ui("1.2.0", &["network"]);
    changed["network"] = json!(["https://c.example.com"]);
    let done = update(&k.data, &k.plugins, &k.inspect(&changed)).unwrap();
    assert_eq!(done.row.entry.state, EntryState::NeedsConsent);
    assert!(done.row.granted_origins.is_empty());
    assert!(k.plugins.enabled_set().serving(ID).is_none());
    assert!(k.plugins.snapshot().entries[0].consented_network.is_empty());
}

#[test]
fn an_unchanged_surface_keeps_the_plugin_ready_and_enabled() {
    let k = running(&["storage"]);
    // The user's own choices and data.
    k.set_entry(|e| e.sidebar_collapsed = true);
    let installed_at = k.plugins.snapshot().entries[0].installed_at;
    let data = data_dir(&k.data, ID);
    fs::create_dir_all(&data).unwrap();
    fs::write(data.join("kv.json"), b"{\"a\":1}").unwrap();

    let next = ui("1.1.0", &["storage"]);
    let token = k.inspect(&next);
    let generation = k.plugins.generation();
    let done = update(&k.data, &k.plugins, &token).unwrap();
    assert_eq!(done.previous_version, "1.0.0");
    let e = &done.row.entry;
    assert_eq!(e.version, "1.1.0");
    assert_eq!(e.state, EntryState::Ready);
    assert!(e.enabled);
    assert_eq!(e.granted, vec![Capability::Storage]);
    assert_eq!(e.installed_at, installed_at);
    assert!(e.sidebar_collapsed);
    assert_eq!(e.manifest_hash, manifest_hash(next.to_string().as_bytes()));
    assert!(e.source_path.as_deref().unwrap().contains("src-"));
    assert_eq!(k.saved_entry(), *e);
    assert!(k.plugins.is_enabled(ID));
    assert_eq!(k.plugins.generation(), generation + 1);
    assert_eq!(k.stops(), [ID]);

    let on_disk = fs::read_to_string(plugin_dir(&k.data, ID).join("plugin.json")).unwrap();
    assert!(on_disk.contains("1.1.0"));
    assert!(!old_dir(&k.data, ID).exists());
    assert_eq!(staging_count(&k), 0);
    assert!(k.plugins.staged(&token).is_none());
    assert_eq!(fs::read(data.join("kv.json")).unwrap(), b"{\"a\":1}");
}

#[test]
fn a_new_capability_asks_for_consent_again() {
    let k = running(&["storage"]);
    let token = k.inspect(&ui("1.1.0", &["storage", "ui.toast"]));
    let e = update(&k.data, &k.plugins, &token).unwrap().row.entry;
    assert_eq!(e.state, EntryState::NeedsConsent);
    assert!(!e.enabled && e.granted.is_empty());
    assert!(!k.plugins.is_enabled(ID));
    assert_eq!(k.saved_entry(), e);
}

#[test]
fn a_dropped_capability_also_asks_again() {
    let k = running(&["storage", "ui.toast"]);
    let token = k.inspect(&ui("1.1.0", &["storage"]));
    let e = update(&k.data, &k.plugins, &token).unwrap().row.entry;
    assert_eq!(e.state, EntryState::NeedsConsent);
}

#[test]
fn a_change_of_network_origins_asks_again() {
    let mut first = ui("1.0.0", &["network"]);
    first["network"] = json!(["https://a.example.com"]);
    let k = Kit::new();
    k.install(&first);
    k.enable(&["network"]);
    let mut next = first.clone();
    next["version"] = json!("1.1.0");
    next["network"] = json!(["https://a.example.com", "https://b.example.com"]);
    let token = k.inspect(&next);
    let e = update(&k.data, &k.plugins, &token).unwrap().row.entry;
    assert_eq!(e.state, EntryState::NeedsConsent);
    assert!(!k.plugins.is_enabled(ID));
}

#[test]
fn a_changed_native_reason_asks_again() {
    let k = Kit::new();
    k.install(&native("1.0.0", &["audio.tap"]));
    k.enable(&["audio.tap"]);
    let mut next = native("1.1.0", &["audio.tap"]);
    next["native_reason"] = json!("A different reason.");
    let token = k.inspect(&next);
    let e = update(&k.data, &k.plugins, &token).unwrap().row.entry;
    assert_eq!(e.state, EntryState::NeedsConsent);
}

/// Installed native at 1.0.0 with `audio.tap`, consented and enabled.
fn running_native() -> Kit {
    let k = Kit::new();
    k.install(&native("1.0.0", &["audio.tap"]));
    k.enable(&["audio.tap"]);
    k
}

/// Stages the installed native manifest, byte for byte, with a different exe beside it.
fn same_manifest_new_exe(k: &Kit) -> String {
    let src = k.source(
        &native("1.0.0", &["audio.tap"]),
        &[("bin/tool.exe", b"MZ new")],
    );
    let found = k.inspect_path(&src);
    let installed = k.plugins.snapshot().entries[0].manifest_hash.clone();
    assert_eq!(
        k.plugins.staged(&found.token).unwrap().manifest_hash,
        installed
    );
    found.token
}

fn live_exe(k: &Kit) -> Vec<u8> {
    fs::read(plugin_dir(&k.data, ID).join("bin/tool.exe")).unwrap()
}

/// A folder where the registry's temp file goes: every save fails and the saved file stays.
fn jam_saves(k: &Kit) {
    fs::create_dir_all(state_dir(&k.data).join("registry.json.tmp")).unwrap();
}

fn unjam_saves(k: &Kit) {
    fs::remove_dir(state_dir(&k.data).join("registry.json.tmp")).unwrap();
}

fn assert_needs_consent(plugins: &PluginsState) {
    let e = plugins.snapshot().entry(ID).unwrap().clone();
    assert_eq!(e.state, EntryState::NeedsConsent);
    assert!(!e.enabled && e.granted.is_empty() && e.ready_enabled.is_none());
    assert!(!plugins.is_enabled(ID));
    // What a boot or an update's end would start.
    assert!(plugins.snapshot().serving().is_empty());
}

/// Every start after the enable's found the plugin out of the serving set, so none launched.
fn assert_nothing_started(k: &Kit) {
    let starts = k.starts();
    assert_eq!(starts[0], ID, "the enable's start");
    let refused = format!("{ID} (not serving)");
    assert!(starts[1..].iter().all(|s| *s == refused), "{starts:?}");
}

const NO_HOOK: &dyn Fn() = &|| {};

#[test]
fn a_crash_between_the_swap_and_its_save_leaves_new_native_files_needing_consent() {
    let k = running_native();
    let token = same_manifest_new_exe(&k);
    let staged = claim(&k.plugins, &token).unwrap();
    let crashed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        update_claimed(&k.data, &k.plugins, &staged, &|| panic!("crash"), NO_HOOK)
    }));
    assert!(crashed.is_err());
    assert_eq!(live_exe(&k), b"MZ new");
    assert!(old_dir(&k.data, ID).exists());
    assert_nothing_started(&k);

    let plugins = k.relaunch();
    assert!(!old_dir(&k.data, ID).exists());
    assert_eq!(live_exe(&k), b"MZ new");
    assert_needs_consent(&plugins);
}

#[test]
fn boot_takes_consent_from_a_native_plugin_with_an_old_folder_beside_it() {
    let k = running_native();
    fs::create_dir_all(old_dir(&k.data, ID)).unwrap();
    let plugins = k.relaunch();
    assert!(!old_dir(&k.data, ID).exists());
    assert_needs_consent(&plugins);
    assert_nothing_started(&k);
}

#[cfg(windows)]
#[test]
fn an_old_folder_that_cannot_be_deleted_takes_no_consent_at_any_boot() {
    let k = running_native();
    let old = old_dir(&k.data, ID);
    fs::create_dir_all(&old).unwrap();
    fs::write(old.join("stuck.bin"), b"x").unwrap();
    let held = crate::plugins::test_kit::hold(&old.join("stuck.bin"));
    for _ in 0..2 {
        let plugins = k.relaunch();
        assert!(old.exists());
        assert!(plugins.is_enabled(ID));
        assert_eq!(
            plugins.snapshot().entry(ID).unwrap().state,
            EntryState::Ready
        );
    }
    drop(held);
}

#[test]
fn a_native_update_whose_reset_cannot_be_saved_moves_nothing() {
    let k = running_native();
    let before = k.plugins.snapshot();
    let token = same_manifest_new_exe(&k);
    jam_saves(&k);
    let err = update(&k.data, &k.plugins, &token).unwrap_err();
    assert_eq!(err.code, ErrorCode::Io);
    assert_eq!(k.plugins.snapshot(), before);
    assert!(k.plugins.is_enabled(ID));
    assert_eq!(live_exe(&k), b"MZ");
    assert!(k.plugins.staged(&token).is_some());
    // The approved plugin runs again; nothing of the update was ever live.
    assert_eq!(k.starts(), [ID, ID]);
}

#[test]
fn a_failed_save_with_a_clean_undo_keeps_the_reset_it_could_not_undo() {
    let k = running_native();
    let token = same_manifest_new_exe(&k);
    let staged = claim(&k.plugins, &token).unwrap();
    let err = update_claimed(&k.data, &k.plugins, &staged, &|| jam_saves(&k), NO_HOOK).unwrap_err();
    assert_eq!(err.code, ErrorCode::Io);
    assert_eq!(live_exe(&k), b"MZ");
    assert!(!old_dir(&k.data, ID).exists());
    // The restore could not be saved either, so the reset holds in memory and on disk.
    assert_needs_consent(&k.plugins);
    assert_eq!(k.saved_entry().state, EntryState::NeedsConsent);
    k.plugins.start(ID);
    assert_nothing_started(&k);
    unjam_saves(&k);
    assert_needs_consent(&k.relaunch());
}

#[test]
fn a_failed_save_a_clean_undo_and_a_saved_restore_bring_back_the_approved_plugin() {
    let k = running_native();
    let before = k.plugins.snapshot();
    let token = same_manifest_new_exe(&k);
    let staged = claim(&k.plugins, &token).unwrap();
    let err = update_claimed(&k.data, &k.plugins, &staged, &|| jam_saves(&k), &|| {
        unjam_saves(&k)
    })
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::Io);
    assert_eq!(k.plugins.snapshot(), before);
    assert_eq!(k.saved_entry(), before.entries[0]);
    assert_eq!(live_exe(&k), b"MZ");
    // The start `update` makes at its end runs the original exe.
    k.plugins.start(ID);
    assert_eq!(k.starts(), [ID, ID]);
    assert_eq!(live_exe(&k), b"MZ");
}

#[cfg(windows)]
#[test]
fn a_failed_save_and_undo_then_a_boot_leave_new_native_files_needing_consent() {
    let k = running_native();
    let live = plugin_dir(&k.data, ID);
    let token = same_manifest_new_exe(&k);
    let staged = claim(&k.plugins, &token).unwrap();
    let held = std::cell::RefCell::new(None);
    let fail = || {
        jam_saves(&k);
        *held.borrow_mut() = Some(crate::plugins::test_kit::hold(&live.join("bin/tool.exe")));
    };
    let err = update_claimed(&k.data, &k.plugins, &staged, &fail, NO_HOOK).unwrap_err();
    drop(held.take());
    assert_eq!(err.code, ErrorCode::NeedsReinstall);
    let e = k.plugins.snapshot().entry(ID).unwrap().clone();
    assert_eq!(e.state, EntryState::Broken);
    assert!(!e.enabled && e.granted.is_empty() && e.ready_enabled.is_none());
    assert_eq!(live_exe(&k), b"MZ new");
    k.plugins.start(ID);
    assert_nothing_started(&k);

    unjam_saves(&k);
    let plugins = k.relaunch();
    assert_eq!(live_exe(&k), b"MZ new");
    assert_needs_consent(&plugins);
}

#[cfg(windows)]
#[test]
fn a_failed_native_swap_with_a_clean_undo_restores_the_plugin_as_it_was() {
    let k = running_native();
    let before = k.plugins.snapshot();
    let token = same_manifest_new_exe(&k);
    let staged = k.plugins.staged(&token).unwrap();
    let held = crate::plugins::test_kit::hold(&staged.dir.join("index.html"));
    let err = update(&k.data, &k.plugins, &token).unwrap_err();
    drop(held);
    assert_eq!(err.code, ErrorCode::Io);
    assert_eq!(k.plugins.snapshot(), before);
    assert_eq!(k.saved_entry(), before.entries[0]);
    assert!(k.plugins.is_enabled(ID));
    assert_eq!(live_exe(&k), b"MZ");
    assert!(!old_dir(&k.data, ID).exists());
    assert_eq!(k.starts(), [ID, ID], "the original exe, as approved");
}

#[test]
fn a_second_update_of_the_same_id_is_busy_while_the_first_runs() {
    let k = running_native();
    let plugins = Arc::new(k.relaunch());
    k.record(&plugins);
    let before = plugins.snapshot();
    // Two reloads of one source: the installed plugin.json byte for byte, another exe.
    let src = k.source(
        &native("1.0.0", &["audio.tap"]),
        &[("bin/tool.exe", b"MZ new")],
    );
    let inspect = || {
        let source = src.to_str().unwrap();
        crate::plugins::install::inspect(&k.data, &plugins, source, Limits::DEFAULT)
            .unwrap()
            .token
    };
    let a = inspect();
    let b = inspect();
    let refused = Arc::new(Mutex::new(Vec::new()));
    let weak = Arc::downgrade(&plugins);
    let (data, log, b_token) = (k.data.clone(), refused.clone(), b.clone());
    // A's stop is inside its turn: B, an uninstall, an enable and a disable all meet the turn.
    plugins.set_stopper(Arc::new(move |id: &str| {
        let p = weak.upgrade().unwrap();
        let mut log = log.lock().unwrap();
        log.push(update(&data, &p, &b_token).unwrap_err().code);
        log.push(uninstall(&data, &p, id, false).unwrap_err().code);
        log.push(enable(&data, &p, id, None, false, None).unwrap_err().code);
        log.push(disable(&data, &p, id).unwrap_err().code);
    }));
    let a_staged = claim(&plugins, &a).unwrap();
    let in_turn = |f: &dyn Fn()| {
        assert!(
            plugins.try_turn(ID).is_none(),
            "the turn is held through the swap"
        );
        f()
    };
    let err = update_claimed(
        &k.data,
        &plugins,
        &a_staged,
        &|| in_turn(&|| jam_saves(&k)),
        &|| in_turn(&|| unjam_saves(&k)),
    )
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::Io);
    assert_eq!(*refused.lock().unwrap(), [ErrorCode::Busy; 4]);

    // A failed with a clean undo: the approved plugin is back, and none of the source's files
    // are live.
    assert_eq!(plugins.snapshot(), before);
    assert_eq!(k.saved_entry(), before.entries[0]);
    assert_eq!(live_exe(&k), b"MZ");
    assert!(!old_dir(&k.data, ID).exists());
    assert!(plugins.staged(&b).is_some(), "B waits under its token");

    // B, run after A, can only end needing consent over the source's files.
    plugins.set_stopper(Arc::new(|_: &str| {}));
    let done = update(&k.data, &plugins, &b).unwrap();
    assert_eq!(done.row.entry.state, EntryState::NeedsConsent);
    assert_eq!(live_exe(&k), b"MZ new");
    assert!(!plugins.is_enabled(ID));
    assert_eq!(k.starts().last().unwrap(), &format!("{ID} (not serving)"));
}

#[test]
fn an_update_while_the_turn_is_held_is_busy_and_stops_nothing() {
    let k = running_native();
    let token = same_manifest_new_exe(&k);
    let held = k.plugins.try_turn(ID).unwrap();
    let err = update(&k.data, &k.plugins, &token).unwrap_err();
    assert_eq!(err.code, ErrorCode::Busy);
    assert!(k.stops().is_empty());
    assert!(k.plugins.is_enabled(ID));
    assert_eq!(live_exe(&k), b"MZ");
    assert!(k.plugins.staged(&token).is_some());
    drop(held);
    assert_eq!(
        update(&k.data, &k.plugins, &token).unwrap().row.entry.state,
        EntryState::NeedsConsent
    );
}

#[test]
fn an_update_during_an_uninstall_is_busy() {
    let k = running_native();
    let plugins = Arc::new(k.relaunch());
    k.record(&plugins);
    let token = k.inspect_into(&plugins, &native("1.1.0", &["audio.tap"]));
    let weak = Arc::downgrade(&plugins);
    let data = k.data.clone();
    let seen = Arc::new(Mutex::new(None));
    let log = seen.clone();
    plugins.set_stopper(Arc::new(move |_: &str| {
        let p = weak.upgrade().unwrap();
        *log.lock().unwrap() = Some(update(&data, &p, &token).unwrap_err().code);
    }));
    uninstall(&k.data, &plugins, ID, false).unwrap();
    assert_eq!(*seen.lock().unwrap(), Some(ErrorCode::Busy));
    assert!(!plugin_dir(&k.data, ID).exists());
    assert!(plugins.rows().is_empty());
}

#[test]
fn a_native_update_with_an_unchanged_surface_asks_again() {
    let k = running_native();
    let token = k.inspect(&native("1.1.0", &["audio.tap"]));
    let done = update(&k.data, &k.plugins, &token).unwrap();
    let e = &done.row.entry;
    assert_eq!(e.state, EntryState::NeedsConsent);
    assert!(!e.enabled && e.granted.is_empty());
    assert!(!k.plugins.is_enabled(ID));
    assert_eq!(k.saved_entry(), *e);
    assert_eq!(done.previous_author, "A");
}

#[test]
fn a_native_update_with_another_author_and_exe_asks_again() {
    let k = running_native();
    let mut next = native("9.9.9", &["audio.tap"]);
    next["author"] = json!("Someone else");
    next["entry"] = json!("bin/other.exe");
    let src = k.source(&next, &[("bin/other.exe", b"MZ")]);
    let token = k.inspect_path(&src).token;
    let done = update(&k.data, &k.plugins, &token).unwrap();
    assert_eq!(done.row.entry.state, EntryState::NeedsConsent);
    assert!(!k.plugins.is_enabled(ID));
    assert!(k.plugins.enabled_set().serving(ID).is_none());
    assert_eq!(done.previous_author, "A");
    assert_eq!(k.starts(), [ID.to_string(), format!("{ID} (not serving)")]);
}

#[test]
fn a_native_downgrade_or_same_version_replacement_asks_again() {
    for version in ["0.9.0", "1.0.0"] {
        let k = running_native();
        let mut next = native(version, &["audio.tap"]);
        // The same version with other bytes: the exe is not part of plugin.json.
        next["name"] = json!("Demo again");
        let token = k.inspect(&next);
        let done = update(&k.data, &k.plugins, &token).unwrap();
        assert_eq!(done.row.entry.version, version);
        assert_eq!(done.row.entry.state, EntryState::NeedsConsent, "{version}");
        assert!(!k.plugins.is_enabled(ID), "{version}");
    }
}

#[test]
fn a_changed_author_asks_again_for_a_ui_update_downgrade_or_replacement() {
    for version in ["1.1.0", "0.9.0", "1.0.0"] {
        let k = running(&["storage"]);
        let mut next = ui(version, &["storage"]);
        next["author"] = json!("Someone else");
        let done = update(&k.data, &k.plugins, &k.inspect(&next)).unwrap();
        let e = &done.row.entry;
        assert_eq!(e.state, EntryState::NeedsConsent, "{version}");
        assert!(!e.enabled && e.granted.is_empty(), "{version}");
        assert!(!k.plugins.is_enabled(ID), "{version}");
        assert_eq!(done.previous_author, "A");
        assert_eq!(done.previous_version, "1.0.0");
    }
}

#[test]
fn a_ui_same_version_replacement_with_an_unchanged_surface_stays_ready() {
    let k = running(&["storage"]);
    let mut next = ui("1.0.0", &["storage"]);
    next["name"] = json!("Demo again");
    let done = update(&k.data, &k.plugins, &k.inspect(&next)).unwrap();
    assert_eq!(done.row.entry.state, EntryState::Ready);
    assert!(k.plugins.is_enabled(ID));
}

#[test]
fn an_installed_folder_edited_after_consent_does_not_carry_consent_over() {
    let k = running(&["storage"]);
    // Edited on disk to match the update; the recorded hash still names the reviewed one.
    let next = ui("1.1.0", &["storage"]);
    fs::write(
        plugin_dir(&k.data, ID).join("plugin.json"),
        next.to_string(),
    )
    .unwrap();
    let token = k.inspect(&next);
    let e = update(&k.data, &k.plugins, &token).unwrap().row.entry;
    assert_eq!(e.state, EntryState::NeedsConsent);
    assert!(!k.plugins.is_enabled(ID));
}

#[test]
fn a_needs_consent_plugin_stays_needs_consent() {
    let k = Kit::new();
    k.install(&ui("1.0.0", &["storage"]));
    let token = k.inspect(&ui("1.1.0", &["storage"]));
    let e = update(&k.data, &k.plugins, &token).unwrap().row.entry;
    assert_eq!(e.state, EntryState::NeedsConsent);
    assert!(!e.enabled && e.granted.is_empty());
}

#[test]
fn a_disabled_ready_plugin_stays_disabled_and_a_downgrade_is_allowed() {
    let k = running(&["storage"]);
    disable(&k.data, &k.plugins, ID).unwrap();
    let token = k.inspect(&ui("0.9.0", &["storage"]));
    let done = update(&k.data, &k.plugins, &token).unwrap();
    assert_eq!(done.previous_version, "1.0.0");
    assert_eq!(done.row.entry.version, "0.9.0");
    assert_eq!(done.row.entry.state, EntryState::Ready);
    assert!(!done.row.entry.enabled);
    assert!(!k.plugins.is_enabled(ID));
}

#[test]
fn refusals_leave_the_installed_plugin_and_the_token_alone() {
    let k = running(&["storage"]);
    let before = k.plugins.snapshot();
    let installed = fs::read(plugin_dir(&k.data, ID).join("plugin.json")).unwrap();

    let other_tier = native("2.0.0", &["storage"]);
    let mut too_new = ui("2.0.0", &["storage"]);
    too_new["min_plisto"] = json!("999.0.0");
    let mut stranger = ui("1.0.0", &["storage"]);
    stranger["id"] = json!("com.example.stranger");
    for (manifest, code) in [
        (other_tier, ErrorCode::TierChanged),
        (too_new, ErrorCode::Incompatible),
        (stranger, ErrorCode::NotInstalled),
    ] {
        let token = k.inspect(&manifest);
        let err = update(&k.data, &k.plugins, &token).unwrap_err();
        assert_eq!(err.code, code);
        assert!(k.plugins.staged(&token).is_some(), "{code:?}");
    }
    assert_eq!(k.plugins.snapshot(), before);
    assert!(k.plugins.is_enabled(ID));
    assert_eq!(
        fs::read(plugin_dir(&k.data, ID).join("plugin.json")).unwrap(),
        installed
    );
    assert!(k.stops().is_empty(), "nothing was stopped for a refusal");
    assert_eq!(
        update(&k.data, &k.plugins, "nope").unwrap_err().code,
        ErrorCode::UnknownToken
    );
}

#[test]
fn a_tampered_staged_manifest_is_refused() {
    let k = running(&["storage"]);
    let before = k.plugins.snapshot();
    let token = k.inspect(&ui("1.1.0", &["storage"]));
    let staged = k.plugins.staged(&token).unwrap();
    fs::write(
        staged.dir.join("plugin.json"),
        ui("1.1.0", &["storage", "ui.toast"]).to_string(),
    )
    .unwrap();
    let err = update(&k.data, &k.plugins, &token).unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidManifest);
    assert_eq!(k.plugins.snapshot(), before);
    assert!(k.plugins.staged(&token).is_some());
    assert!(k.stops().is_empty());
}

#[test]
fn a_leftover_old_folder_is_moved_aside_and_the_update_goes_on() {
    let k = running(&["storage"]);
    let old = old_dir(&k.data, ID);
    fs::create_dir_all(&old).unwrap();
    fs::write(old.join("stale.txt"), b"x").unwrap();
    let token = k.inspect(&ui("1.1.0", &["storage"]));
    update(&k.data, &k.plugins, &token).unwrap();
    assert!(!old.exists());
    assert_eq!(staging_count(&k), 0);
    assert!(k.plugins.is_enabled(ID));
}

#[test]
fn a_failed_save_rolls_the_swap_back() {
    let k = running(&["storage"]);
    let before = k.plugins.snapshot();
    let installed = fs::read(plugin_dir(&k.data, ID).join("plugin.json")).unwrap();
    let token = k.inspect(&ui("1.1.0", &["storage", "ui.toast"]));
    k.break_saves();
    let generation = k.plugins.generation();
    let err = update(&k.data, &k.plugins, &token).unwrap_err();
    assert_eq!(err.code, ErrorCode::Io);
    assert_eq!(k.plugins.snapshot(), before);
    assert_eq!(k.plugins.generation(), generation);
    assert!(k.plugins.is_enabled(ID), "back in the serving set");
    assert_eq!(
        fs::read(plugin_dir(&k.data, ID).join("plugin.json")).unwrap(),
        installed
    );
    assert!(!old_dir(&k.data, ID).exists());
    let kept = k.plugins.staged(&token).unwrap();
    assert!(kept.dir.join("plugin.json").is_file());
}

#[test]
fn an_update_starts_the_stopped_plugin_again() {
    let k = running(&["storage"]);
    let token = k.inspect(&ui("1.1.0", &["storage"]));
    update(&k.data, &k.plugins, &token).unwrap();
    assert_eq!(k.stops(), [ID]);
    assert_eq!(
        k.starts(),
        [ID, ID],
        "after the enable, then after the update"
    );
}

#[test]
fn a_rolled_back_update_starts_the_stopped_plugin_again() {
    let k = running(&["storage"]);
    let token = k.inspect(&ui("1.1.0", &["storage"]));
    k.break_saves();
    update(&k.data, &k.plugins, &token).unwrap_err();
    assert_eq!(k.stops(), [ID]);
    assert_eq!(k.starts(), [ID, ID]);
    assert!(k.plugins.is_enabled(ID));
}

#[test]
fn the_extra_retry_is_only_for_a_held_file() {
    let held = || Err(io::Error::from_raw_os_error(32));
    let mut tried = false;
    assert!(once_more(held(), || {
        tried = true;
        Ok(())
    })
    .is_ok());
    assert!(tried);
    for first in [Ok(()), Err(io::Error::from_raw_os_error(2))] {
        let mut tried = false;
        let _ = once_more(first, || {
            tried = true;
            Ok(())
        });
        assert!(!tried);
    }
    assert!(ROLLBACK_RETRY_DELAY <= Duration::from_millis(200));
}

#[cfg(windows)]
#[test]
fn a_held_file_in_the_update_rolls_the_swap_back() {
    let k = running(&["storage"]);
    let before = k.plugins.snapshot();
    let token = k.inspect(&ui("1.1.0", &["storage"]));
    let staged = k.plugins.staged(&token).unwrap();
    let held = crate::plugins::test_kit::hold(&staged.dir.join("index.html"));
    let err = update(&k.data, &k.plugins, &token).unwrap_err();
    drop(held);
    assert_eq!(err.code, ErrorCode::Io);
    assert_eq!(k.plugins.snapshot(), before);
    assert!(k.plugins.is_enabled(ID));
    let on_disk = fs::read_to_string(plugin_dir(&k.data, ID).join("plugin.json")).unwrap();
    assert!(on_disk.contains("1.0.0"));
    assert!(!old_dir(&k.data, ID).exists());
    // Once the file is free, the same token updates.
    update(&k.data, &k.plugins, &token).unwrap();
    assert!(k.plugins.is_enabled(ID));
}

#[cfg(windows)]
#[test]
fn an_undo_that_fails_marks_the_plugin_broken_and_reinstall_works() {
    let k = running(&["storage"]);
    let live = plugin_dir(&k.data, ID);
    let token = k.inspect(&ui("1.1.0", &["storage"]));
    let staged = claim(&k.plugins, &token).unwrap();
    k.break_saves();
    let held = std::cell::RefCell::new(None);
    let hold_new = || {
        *held.borrow_mut() = Some(crate::plugins::test_kit::hold(&live.join("index.html")));
    };
    let err = update_claimed(&k.data, &k.plugins, &staged, &hold_new, NO_HOOK).unwrap_err();
    drop(held.take());
    assert_eq!(err.code, ErrorCode::NeedsReinstall);
    assert!(err
        .detail
        .contains("uninstall this plugin, then install it again"));
    let rows = k.plugins.rows();
    assert_eq!(rows[0].entry.state, EntryState::Broken);
    assert_eq!(rows[0].problem.as_deref(), Some(err.detail.as_str()));
    assert!(!k.plugins.is_enabled(ID));
    assert!(old_dir(&k.data, ID).exists(), "the only copy is kept");

    k.unbreak_saves();
    uninstall(&k.data, &k.plugins, ID, false).unwrap();
    assert!(!live.exists() && !old_dir(&k.data, ID).exists());
    k.install(&ui("1.0.0", &["storage"]));
    k.enable(&["storage"]);
    assert!(k.plugins.is_enabled(ID));
}

#[test]
fn the_stopper_runs_unlocked_after_the_plugin_left_the_serving_set() {
    let k = running(&["storage"]);
    let plugins = Arc::new(k.relaunch());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let weak = Arc::downgrade(&plugins);
    let log = seen.clone();
    plugins.set_stopper(Arc::new(move |id: &str| {
        let p = weak.upgrade().unwrap();
        log.lock().unwrap().push((p.is_enabled(id), p.rows().len()));
    }));
    let token = k.inspect_into(&plugins, &ui("1.1.0", &["storage"]));
    update(&k.data, &plugins, &token).unwrap();
    assert!(plugins.is_enabled(ID));
    disable(&k.data, &plugins, ID).unwrap();
    enable(&k.data, &plugins, ID, None, false, None).unwrap();
    uninstall(&k.data, &plugins, ID, false).unwrap();
    assert_eq!(*seen.lock().unwrap(), [(false, 1), (false, 1), (false, 1)]);
}

#[test]
fn an_enable_between_the_stop_and_the_swap_starts_nothing() {
    let k = running(&["storage"]);
    let plugins = Arc::new(k.relaunch());
    k.record(&plugins);
    let weak = Arc::downgrade(&plugins);
    let data = k.data.clone();
    // The stop is the moment the old binary is down and the swap has not happened yet.
    plugins.set_stopper(Arc::new(move |id: &str| {
        let p = weak.upgrade().unwrap();
        let refused = enable(&data, &p, id, None, false, None).unwrap_err();
        assert_eq!(refused.code, ErrorCode::Busy);
        assert!(!p.is_enabled(id));
    }));
    let token = k.inspect_into(&plugins, &ui("1.1.0", &["storage"]));
    update(&k.data, &plugins, &token).unwrap();
    // The kit's enable, then only the update's own start, after its turn.
    assert_eq!(k.starts(), [ID, ID]);
    assert!(plugins.is_enabled(ID));
}

#[test]
fn nothing_is_updated_after_a_failed_boot_read() {
    let k = Kit::new();
    k.install(&ui("1.0.0", &["storage"]));
    let registry = registry_file(&k.data);
    fs::remove_file(&registry).unwrap();
    fs::create_dir_all(&registry).unwrap();
    let plugins = k.reboot();
    assert_eq!(
        update(&k.data, &plugins, "any").unwrap_err().code,
        ErrorCode::RegistryUnavailable
    );
    assert!(registry.is_dir());
}

#[test]
fn boot_puts_back_an_old_folder_whose_swap_was_cut_short() {
    let k = running(&["storage"]);
    let live = plugin_dir(&k.data, ID);
    fs::rename(&live, old_dir(&k.data, ID)).unwrap();
    let plugins = k.relaunch();
    assert!(live.join("plugin.json").is_file());
    assert!(!old_dir(&k.data, ID).exists());
    assert!(plugins.is_enabled(ID));
}

#[test]
fn boot_deletes_an_old_folder_left_beside_the_new_one() {
    let k = running(&["storage"]);
    let old = old_dir(&k.data, ID);
    fs::create_dir_all(old.join("ui")).unwrap();
    fs::write(old.join("plugin.json"), b"{}").unwrap();
    let plugins = k.relaunch();
    assert!(!old.exists());
    assert!(plugin_dir(&k.data, ID).join("plugin.json").is_file());
    assert!(plugins.is_enabled(ID));
}

#[test]
fn boot_deletes_the_old_folder_of_a_plugin_the_registry_no_longer_lists() {
    let k = running(&["storage"]);
    let live = plugin_dir(&k.data, ID);
    let aside = k.data.join("aside");
    fs::rename(&live, &aside).unwrap();
    uninstall(&k.data, &k.plugins, ID, false).unwrap();
    fs::rename(&aside, old_dir(&k.data, ID)).unwrap();
    let plugins = k.reboot();
    assert!(!old_dir(&k.data, ID).exists());
    assert!(!live.exists());
    assert!(plugins.rows().is_empty());
}

#[test]
fn without_a_readable_registry_boot_puts_an_old_folder_back() {
    let k = running(&["storage"]);
    let live = plugin_dir(&k.data, ID);
    fs::rename(&live, old_dir(&k.data, ID)).unwrap();
    fs::write(registry_file(&k.data), b"not a registry").unwrap();
    let plugins = k.reboot();
    assert!(live.join("plugin.json").is_file());
    assert!(!old_dir(&k.data, ID).exists());
    assert_eq!(plugins.rows()[0].entry.state, EntryState::NeedsConsent);
}

#[test]
fn swap_folders_are_never_adopted() {
    let k = Kit::new();
    for name in [format!("{ID}.old"), format!("{ID}.new")] {
        assert!(validate_id(&name).is_err(), "{name}");
        let dir = plugins_dir(&k.data).join(&name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("plugin.json"), ui("1.0.0", &[]).to_string()).unwrap();
    }
    let (adopted, _) = adopt_folders(&k.data, 0, &HashSet::new());
    assert!(adopted.is_empty());
}
