// The plugin state owner against a registry on disk: snapshots, the enabled and serving sets, lifecycle turns.

// -- Library Imports --
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

// -- Local Imports --
use super::*;
use crate::plugins::manifest::Tier;
use crate::plugins::paths::{
    plugin_dir, registry_bad_file, registry_file, safe_mode_file, state_dir,
};
use crate::plugins::registry::EntryState;

const ID: &str = "com.example.demo";
const VERSION: &str = "2.7.0";

struct AppData(PathBuf);

impl AppData {
    fn new() -> AppData {
        static N: AtomicUsize = AtomicUsize::new(0);
        AppData(std::env::temp_dir().join(format!(
            "plisto-plugins-state-test-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        )))
    }

    fn install(&self, id: &str) -> String {
        let json = format!(
            r#"{{"manifest_version":1,"id":"{id}","name":"Demo","version":"1.0.0","tier":"ui",
                "entry":"index.html","capabilities":[],"min_plisto":"1.0.0","author":"A"}}"#
        );
        let dir = plugin_dir(&self.0, id);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("plugin.json"), &json).unwrap();
        fs::write(dir.join("index.html"), "<p></p>").unwrap();
        crate::plugins::revalidate::manifest_hash(json.as_bytes())
    }

    fn write_registry(&self, bytes: &[u8]) {
        fs::create_dir_all(state_dir(&self.0)).unwrap();
        fs::write(registry_file(&self.0), bytes).unwrap();
    }

    fn boot(&self) -> PluginsState {
        PluginsState::boot(&self.0, VERSION, 1, 50)
    }
}

impl Drop for AppData {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn entry(id: &str, hash: &str, enabled: bool) -> Entry {
    Entry {
        id: id.to_string(),
        version: "1.0.0".into(),
        tier: Tier::Ui,
        enabled,
        granted: Vec::new(),
        installed_at: 1,
        manifest_hash: hash.to_string(),
        state: EntryState::Ready,
        source_path: None,
        sidebar_collapsed: false,
        ready_enabled: None,
        consented_network: Vec::new(),
    }
}

fn save(d: &AppData, entries: Vec<Entry>) {
    let registry = Registry {
        entries,
        ..Registry::default()
    };
    registry::save(&d.0, &registry).unwrap();
}

#[test]
fn booting_with_no_plugins_folder_and_no_registry_gives_an_empty_state() {
    let d = AppData::new();
    let state = d.boot();
    assert!(state.rows().is_empty());
    assert_eq!(state.boot_state(), BootState::default());
    assert!(!state.is_enabled(ID));
    // Booting writes the marker and nothing else.
    assert!(state_dir(&d.0).join(".session").is_file());
    assert!(!registry_file(&d.0).exists());
    assert!(!d.0.join("plugins").exists());
}

#[test]
fn only_enabled_ready_entries_are_in_the_serving_set() {
    let d = AppData::new();
    let hash = d.install(ID);
    let off_hash = d.install("com.example.off");
    d.install("com.example.fresh");
    let mut fresh = entry("com.example.fresh", "", true);
    fresh.state = EntryState::NeedsConsent;
    save(
        &d,
        vec![
            entry(ID, &hash, true),
            entry("com.example.off", &off_hash, false),
            fresh,
            entry("com.example.gone", "x", true),
        ],
    );
    let state = d.boot();
    assert!(state.is_enabled(ID));
    for id in [
        "com.example.off",
        "com.example.fresh",
        "com.example.gone",
        "com.example.never",
    ] {
        assert!(!state.is_enabled(id), "{id}");
    }
    let rows = state.rows();
    assert_eq!(rows.len(), 4);
    let gone = rows
        .iter()
        .find(|r| r.entry.id == "com.example.gone")
        .unwrap();
    assert_eq!(gone.entry.state, EntryState::Broken);
    assert!(gone.problem.is_some());
    let live = rows.iter().find(|r| r.entry.id == ID).unwrap();
    assert!(live.problem.is_none());
}

#[test]
fn the_enabled_handle_follows_a_replace() {
    let d = AppData::new();
    let hash = d.install(ID);
    save(&d, vec![entry(ID, &hash, true)]);
    let state = d.boot();
    let handle = state.enabled_set();
    assert!(handle.contains(ID));
    let mut registry = state.snapshot();
    registry.entries[0].enabled = false;
    state.replace(registry, Problems::new());
    assert!(!handle.contains(ID));
    assert!(!state.is_enabled(ID));
}

#[test]
fn a_garbage_registry_is_quarantined_and_every_plugin_needs_consent() {
    let d = AppData::new();
    d.install(ID);
    d.install("com.example.two");
    let garbage = b"\x00\xff garbage";
    d.write_registry(garbage);
    let state = d.boot();

    assert_eq!(fs::read(registry_bad_file(&d.0)).unwrap(), garbage);
    let rows = state.rows();
    assert_eq!(rows.len(), 2);
    for row in &rows {
        assert_eq!(row.entry.state, EntryState::NeedsConsent);
        assert!(!row.entry.enabled && row.entry.granted.is_empty());
        assert_eq!(row.entry.installed_at, 50);
    }
    assert!(!state.is_enabled(ID));
    assert!(plugin_dir(&d.0, ID).join("plugin.json").is_file());
    // The rebuilt registry is on disk, so the next boot does not quarantine again.
    let again = d.boot();
    assert_eq!(again.rows().len(), 2);
    assert_eq!(fs::read(registry_bad_file(&d.0)).unwrap(), garbage);
}

#[test]
fn every_bad_registry_shape_boots() {
    let cases: [&[u8]; 7] = [
        b"",
        b"   ",
        b"{\"entries\": [{\"id\": \"com.exa",
        b"[1, 2, 3]",
        br#"{"entries": "x"}"#,
        br#"{"version": 99, "entries": []}"#,
        br#"{"version": "one", "entries": []}"#,
    ];
    for bytes in cases {
        let d = AppData::new();
        d.install(ID);
        d.write_registry(bytes);
        let state = d.boot();
        assert!(
            registry_bad_file(&d.0).is_file(),
            "{:?}",
            String::from_utf8_lossy(bytes)
        );
        assert_eq!(fs::read(registry_bad_file(&d.0)).unwrap(), bytes);
        assert_eq!(state.rows().len(), 1);
        assert!(!state.is_enabled(ID));
    }
}

#[test]
fn one_bad_entry_is_dropped_and_its_folder_adopted_as_needs_consent() {
    let d = AppData::new();
    let hash = d.install(ID);
    d.install("com.example.warp");
    d.write_registry(
        format!(
            r#"{{"entries": [
                    {{"id": "{ID}", "tier": "ui", "state": "ready", "enabled": true,
                      "manifest_hash": "{hash}"}},
                    {{"id": "com.example.warp", "tier": "warp", "state": "ready", "enabled": true}},
                    {{"tier": "ui"}}]}}"#
        )
        .as_bytes(),
    );
    let state = d.boot();
    assert!(
        !registry_bad_file(&d.0).exists(),
        "the file is not quarantined"
    );
    assert!(state.is_enabled(ID));
    assert!(!state.is_enabled("com.example.warp"));
    let rows = state.rows();
    assert_eq!(rows.len(), 2);
    let warp = rows
        .iter()
        .find(|r| r.entry.id == "com.example.warp")
        .unwrap();
    assert_eq!(warp.entry.state, EntryState::NeedsConsent);
    assert!(!warp.entry.enabled);
}

#[test]
fn a_missing_registry_adopts_the_plugin_folders() {
    let d = AppData::new();
    d.install(ID);
    d.install("com.example.bad");
    fs::write(
        plugin_dir(&d.0, "com.example.bad").join("plugin.json"),
        "{ nope",
    )
    .unwrap();
    fs::create_dir_all(plugin_dir(&d.0, "Not.Valid")).unwrap();
    fs::create_dir_all(d.0.join("plugins").join("inbox")).unwrap();
    let state = d.boot();
    let rows = state.rows();
    let ids: Vec<_> = rows.iter().map(|r| r.entry.id.as_str()).collect();
    assert_eq!(ids, ["com.example.bad", ID]);
    assert_eq!(rows[0].entry.state, EntryState::Broken);
    assert!(rows[0].problem.is_some());
    assert_eq!(rows[1].entry.state, EntryState::NeedsConsent);
    assert!(rows.iter().all(|r| !r.entry.enabled));
    assert!(!state.is_enabled(ID));
    assert!(!registry_bad_file(&d.0).exists());
    // Saved, so the next boot reads the same two rows from the file.
    assert_eq!(d.boot().rows().len(), 2);
}

#[test]
fn a_registry_that_cannot_be_read_is_left_alone_and_everything_boots_disabled() {
    let d = AppData::new();
    d.install(ID);
    // A directory where the file belongs: every read fails.
    fs::create_dir_all(registry_file(&d.0)).unwrap();
    let state = d.boot();
    assert!(registry_file(&d.0).is_dir(), "the file is not touched");
    assert!(!registry_bad_file(&d.0).exists());
    let rows = state.rows();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].entry.state, EntryState::NeedsConsent);
    assert!(!state.is_enabled(ID));
}

#[test]
fn a_failed_quarantine_does_not_save_over_the_bad_file() {
    let d = AppData::new();
    d.install(ID);
    let garbage = b"not a registry";
    d.write_registry(garbage);
    // Every quarantine slot is a directory, so the move cannot happen.
    let bad = registry_bad_file(&d.0);
    fs::create_dir_all(&bad).unwrap();
    for n in 1..5 {
        let mut name = bad.clone().into_os_string();
        name.push(format!(".{n}"));
        fs::create_dir_all(name).unwrap();
    }
    let state = d.boot();
    assert_eq!(fs::read(registry_file(&d.0)).unwrap(), garbage);
    assert_eq!(state.rows().len(), 1);
    assert!(!state.is_enabled(ID));
}

#[test]
fn a_second_quarantine_keeps_the_first_bad_file() {
    let d = AppData::new();
    d.write_registry(b"first garbage");
    d.boot();
    d.write_registry(b"second garbage");
    d.boot();
    assert_eq!(fs::read(registry_bad_file(&d.0)).unwrap(), b"first garbage");
    let mut second = registry_bad_file(&d.0).into_os_string();
    second.push(".1");
    assert_eq!(fs::read(second).unwrap(), b"second garbage");
}

#[test]
fn a_registry_that_names_hostile_ids_never_reaches_the_disk_paths() {
    let d = AppData::new();
    d.write_registry(
        br#"{"entries": [
                {"id": "../../escape", "tier": "ui", "state": "ready", "enabled": true},
                {"id": "C:\\Windows", "tier": "ui", "state": "ready", "enabled": true}]}"#,
    );
    let state = d.boot();
    assert!(state.rows().is_empty());
    assert!(!state.is_enabled("../../escape"));
}

#[test]
fn a_revalidated_registry_is_saved_so_the_marks_persist() {
    let d = AppData::new();
    save(&d, vec![entry("com.example.gone", "x", true)]);
    d.boot();
    match registry::read_file(&d.0) {
        FileRead::Parsed(read) => {
            assert_eq!(read.entries[0].state, EntryState::Broken);
            assert!(!read.entries[0].enabled);
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_second_boot_after_an_unclean_exit_reports_it() {
    let d = AppData::new();
    d.boot();
    let second = d.boot();
    assert!(second.boot_state().unclean);
    session::clear(&d.0);
    assert!(!d.boot().boot_state().unclean);
}

/// The demo plugin installed, ready and, when `on`, enabled.
fn demo(d: &AppData, on: bool) {
    let hash = d.install(ID);
    save(d, vec![entry(ID, &hash, on)]);
}

/// A change that saves nothing.
fn touch(state: &PluginsState, d: &AppData, withdraw: Withdraw<'_>) {
    state
        .mutate(
            &d.0,
            withdraw,
            |_, _| Ok(()),
            |e| InstallError::io("save", e),
        )
        .unwrap();
}

/// A boot after a run that never exited, with the demo plugin enabled.
fn held(d: &AppData) -> PluginsState {
    demo(d, true);
    d.boot();
    d.boot()
}

fn view(runtime: Runtime, unclean: bool, safe_flag: bool) -> BootView {
    BootView {
        runtime,
        unclean,
        safe_flag,
    }
}

#[test]
fn a_clean_boot_runs() {
    let d = AppData::new();
    demo(&d, true);
    let state = d.boot();
    assert_eq!(state.boot_view(), view(Runtime::Running, false, false));
    assert!(state.is_enabled(ID));
}

#[test]
fn an_unclean_boot_with_a_plugin_serving_is_held() {
    let d = AppData::new();
    let state = held(&d);
    assert_eq!(state.boot_view(), view(Runtime::Held, true, false));
    assert!(!state.is_enabled(ID));
    // The registry still says enabled.
    assert!(state.snapshot().entries[0].enabled);
}

#[test]
fn an_unclean_boot_with_nothing_serving_runs() {
    let d = AppData::new();
    demo(&d, false);
    d.boot();
    assert_eq!(d.boot().boot_view(), view(Runtime::Running, true, false));
}

#[test]
fn the_safe_mode_flag_wins() {
    let d = AppData::new();
    demo(&d, true);
    session::set_safe_mode(&d.0, true).unwrap();
    assert_eq!(d.boot().boot_view(), view(Runtime::Safe, false, true));
    session::set_safe_mode(&d.0, true).unwrap();
    let unclean = d.boot();
    assert_eq!(unclean.boot_view(), view(Runtime::Safe, true, true));
    assert!(!unclean.is_enabled(ID));
}

#[test]
fn the_safe_mode_flag_lasts_one_boot() {
    let d = AppData::new();
    demo(&d, true);
    session::set_safe_mode(&d.0, true).unwrap();
    let safe = d.boot();
    assert_eq!(safe.runtime(), Runtime::Safe);
    assert!(!safe.is_enabled(ID));
    assert!(!crate::plugins::paths::safe_mode_file(&d.0).exists());
    // The session that read it still reports it; the next launch does not.
    assert!(safe.boot_view().safe_flag);
    session::clear(&d.0);
    let next = d.boot();
    assert_eq!(next.boot_view(), view(Runtime::Running, false, false));
    assert!(next.is_enabled(ID));
}

#[test]
fn the_boot_view_serializes_snake_case() {
    let json = serde_json::to_value(view(Runtime::Held, true, false)).unwrap();
    assert_eq!(
        json,
        serde_json::json!({ "runtime": "held", "unclean": true, "safe_flag": false })
    );
    for (runtime, name) in [(Runtime::Running, "running"), (Runtime::Safe, "safe")] {
        assert_eq!(serde_json::to_value(runtime).unwrap(), name);
    }
}

#[test]
fn nothing_serves_while_held_or_safe_whatever_changes() {
    for safe in [false, true] {
        let d = AppData::new();
        demo(&d, true);
        d.boot();
        session::set_safe_mode(&d.0, safe).unwrap();
        let state = d.boot();
        assert_ne!(state.runtime(), Runtime::Running);
        let handle = state.enabled_set();
        touch(&state, &d, Withdraw::No);
        assert!(!handle.contains(ID), "mutate, safe {safe}");
        touch(&state, &d, Withdraw::While(ID));
        assert!(!handle.contains(ID), "mutate while, safe {safe}");
        state.replace(state.snapshot(), Problems::new());
        assert!(!handle.contains(ID), "replace, safe {safe}");
        drop(state.withdraw(ID));
        assert!(!handle.contains(ID), "withdraw, safe {safe}");
    }
}

#[test]
fn resolving_a_held_boot_to_run_fills_the_serving_set_once() {
    let d = AppData::new();
    let state = held(&d);
    let handle = state.enabled_set();
    assert_eq!(
        state.resolve_boot(false),
        view(Runtime::Running, true, false)
    );
    assert!(handle.contains(ID));
    // Resolved: a second answer of either kind changes nothing.
    assert_eq!(state.resolve_held(false), None);
    assert_eq!(state.resolve_held(true), None);
    assert_eq!(state.resolve_boot(true).runtime, Runtime::Running);
    assert!(handle.contains(ID));
}

#[test]
fn resolving_a_held_boot_to_safe_keeps_plugins_off_and_writes_no_file() {
    let d = AppData::new();
    let state = held(&d);
    assert_eq!(state.resolve_boot(true), view(Runtime::Safe, true, false));
    assert!(!state.is_enabled(ID));
    assert!(!safe_mode_file(&d.0).exists());
    assert_eq!(state.resolve_boot(false).runtime, Runtime::Safe);
    assert!(!state.is_enabled(ID));
    // The next launch after a clean exit runs.
    session::clear(&d.0);
    assert_eq!(d.boot().runtime(), Runtime::Running);
}

#[test]
fn resolve_changes_nothing_unless_the_boot_is_held() {
    let d = AppData::new();
    demo(&d, true);
    let running = d.boot();
    assert_eq!(running.resolve_held(true), None);
    assert_eq!(running.resolve_boot(true).runtime, Runtime::Running);
    assert!(running.is_enabled(ID));

    session::clear(&d.0);
    session::set_safe_mode(&d.0, true).unwrap();
    let safe = d.boot();
    assert_eq!(safe.resolve_held(false), None);
    assert_eq!(safe.resolve_boot(false).runtime, Runtime::Safe);
    assert!(!safe.is_enabled(ID));
}

#[test]
fn a_withdrawn_plugin_stays_out_through_any_change_until_its_guard_drops() {
    let d = AppData::new();
    demo(&d, true);
    let state = d.boot();
    let guard = state.withdraw(ID);
    assert!(!state.is_enabled(ID));
    touch(&state, &d, Withdraw::No);
    touch(&state, &d, Withdraw::While(ID));
    state.replace(state.snapshot(), Problems::new());
    assert!(!state.is_enabled(ID));
    drop(guard);
    assert!(state.is_enabled(ID));
}

#[test]
fn overlapping_guards_on_one_id_restore_only_when_both_drop() {
    let d = AppData::new();
    demo(&d, true);
    let state = d.boot();
    let first = state.withdraw(ID);
    let second = state.withdraw(ID);
    drop(first);
    assert!(!state.is_enabled(ID));
    drop(second);
    assert!(state.is_enabled(ID));
}

#[test]
fn a_guard_dropped_after_a_disable_leaves_the_plugin_out() {
    let d = AppData::new();
    demo(&d, true);
    let state = d.boot();
    let guard = state.withdraw(ID);
    let mut registry = state.snapshot();
    registry.entries[0].enabled = false;
    state.replace(registry, Problems::new());
    drop(guard);
    assert!(!state.is_enabled(ID));
}

#[test]
fn a_poisoned_lock_ends_plugins_for_the_session() {
    let d = AppData::new();
    demo(&d, true);
    let state = d.boot();
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _inner = state.inner.lock().unwrap();
        panic!("poisons the state lock");
    }));
    assert_eq!(state.runtime(), Runtime::Safe);
    assert!(!state.is_enabled(ID));
    assert_eq!(state.resolve_held(false), None);
    touch(&state, &d, Withdraw::No);
    assert!(!state.is_enabled(ID));
}

/// A safe hook that sends every view it is given.
fn watch_safe(state: &PluginsState) -> std::sync::mpsc::Receiver<BootView> {
    let (tx, rx) = std::sync::mpsc::channel();
    let tx = Mutex::new(tx);
    state.set_on_safe(Arc::new(move |view| {
        let _ = tx.lock().unwrap().send(view);
    }));
    rx
}

#[test]
fn a_poisoned_lock_runs_the_safe_hook_once() {
    let d = AppData::new();
    demo(&d, true);
    let state = d.boot();
    let safe = watch_safe(&state);
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _inner = state.inner.lock().unwrap();
        panic!("poisons the state lock");
    }));
    assert_eq!(state.runtime(), Runtime::Safe);
    let view = safe
        .recv_timeout(std::time::Duration::from_secs(10))
        .unwrap();
    assert_eq!(view.runtime, Runtime::Safe);
    // Every later read of the poisoned lock finds it safe already.
    state.runtime();
    touch(&state, &d, Withdraw::No);
    assert!(safe
        .recv_timeout(std::time::Duration::from_millis(200))
        .is_err());
}

#[test]
fn resolving_to_safe_runs_the_safe_hook_and_running_does_not() {
    let d = AppData::new();
    let state = held(&d);
    let safe = watch_safe(&state);
    state.resolve_boot(true);
    assert_eq!(safe.try_recv().unwrap().runtime, Runtime::Safe);

    let d = AppData::new();
    let state = held(&d);
    let safe = watch_safe(&state);
    state.resolve_boot(false);
    assert!(safe.try_recv().is_err());
}

#[test]
fn a_change_that_panics_empties_the_serving_set_at_once() {
    let d = AppData::new();
    demo(&d, true);
    let state = d.boot();
    let handle = state.enabled_set();
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        state.mutate(
            &d.0,
            Withdraw::No,
            |_, _| -> Result<(), InstallError> { panic!("fails inside a change") },
            |e| InstallError::io("save", e),
        )
    }));
    assert!(!handle.contains(ID));
    assert_eq!(state.runtime(), Runtime::Safe);
}

#[test]
fn a_steady_boot_with_held_origins_leaves_the_file_alone() {
    let d = AppData::new();
    let json = format!(
        r#"{{"manifest_version":1,"id":"{ID}","name":"Demo","version":"1.0.0","tier":"ui",
            "entry":"index.html","capabilities":["network"],"network":["https://a.example.com"],
            "min_plisto":"1.0.0","author":"A"}}"#
    );
    let dir = plugin_dir(&d.0, ID);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("plugin.json"), &json).unwrap();
    fs::write(dir.join("index.html"), "<p></p>").unwrap();
    let hash = crate::plugins::revalidate::manifest_hash(json.as_bytes());
    save(
        &d,
        vec![Entry {
            granted: vec![Capability::Network],
            ..entry(ID, &hash, true)
        }],
    );
    let bytes = fs::read(registry_file(&d.0)).unwrap();
    let modified = fs::metadata(registry_file(&d.0))
        .unwrap()
        .modified()
        .unwrap();
    for _ in 0..2 {
        session::clear(&d.0);
        let state = d.boot();
        let serving = state.enabled_set().serving(ID).unwrap();
        assert_eq!(&*serving.origins, ["https://a.example.com"]);
        assert_eq!(fs::read(registry_file(&d.0)).unwrap(), bytes);
        let now = fs::metadata(registry_file(&d.0))
            .unwrap()
            .modified()
            .unwrap();
        assert_eq!(now, modified, "the file was rewritten");
    }
}

#[test]
fn rows_serialize_flat_with_the_problem() {
    let d = AppData::new();
    save(&d, vec![entry("com.example.gone", "x", true)]);
    let state = d.boot();
    let json = serde_json::to_value(state.rows()).unwrap();
    assert_eq!(json[0]["id"], "com.example.gone");
    assert_eq!(json[0]["state"], "broken");
    assert_eq!(json[0]["tier"], "ui");
    assert_eq!(json[0]["granted"], serde_json::json!([]));
    assert!(json[0]["problem"].is_string());
}
