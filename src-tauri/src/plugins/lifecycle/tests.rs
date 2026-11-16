// Enable, approve, disable and uninstall on installed test plugins, and what each leaves in the registry.

// -- Library Imports --
use serde_json::json;

// -- Local Imports --
use super::*;
use crate::plugins::paths::{registry_file, staging_dir};
use crate::plugins::revalidate::manifest_hash;
use crate::plugins::test_kit::{grants, native, ui, Kit, ID};

/// `enable` with the hash recorded for the demo plugin, as the review sheet would send it.
fn consent(
    plugins: &PluginsState,
    data: &Path,
    caps: Option<&[&str]>,
    ack: bool,
) -> Result<PluginRow, InstallError> {
    let hash = plugins
        .snapshot()
        .entry(ID)
        .map(|e| e.manifest_hash.clone());
    let given = caps.map(grants);
    enable(data, plugins, ID, given.as_deref(), ack, hash.as_deref())
}

#[test]
fn the_exact_declared_set_is_accepted_in_any_order() {
    let k = Kit::new();
    k.install(&ui("1.0.0", &["storage", "ui.toast"]));
    let before = k.plugins.generation();
    let row = consent(&k.plugins, &k.data, Some(&["ui.toast", "storage"]), false).unwrap();
    assert_eq!(row.entry.state, EntryState::Ready);
    assert!(row.entry.enabled);
    assert_eq!(
        row.entry.granted,
        vec![Capability::Storage, Capability::UiToast]
    );
    assert!(k.plugins.is_enabled(ID));
    assert_eq!(k.plugins.generation(), before + 1);
    // Saved: a reboot keeps it ready and served.
    assert!(k.relaunch().is_enabled(ID));
}

#[test]
fn any_other_grant_set_is_refused_and_changes_nothing() {
    let k = Kit::new();
    k.install(&ui("1.0.0", &["storage", "ui.toast"]));
    let before = k.plugins.snapshot();
    let generation = k.plugins.generation();
    let cases: [Option<&[&str]>; 6] = [
        None,
        Some(&[]),
        Some(&["storage"]),
        Some(&["storage", "ui.toast", "network"]),
        Some(&["storage", "storage"]),
        Some(&["storage", "time.travel"]),
    ];
    for case in cases {
        let err = consent(&k.plugins, &k.data, case, true).unwrap_err();
        assert_eq!(err.code, ErrorCode::ConsentMismatch, "{case:?}");
    }
    assert_eq!(k.plugins.snapshot(), before);
    assert_eq!(k.plugins.generation(), generation);
    assert!(!k.plugins.is_enabled(ID));
}

#[test]
fn consent_needs_the_hash_of_the_reviewed_manifest() {
    let k = Kit::new();
    k.install(&ui("1.0.0", &["storage"]));
    let caps = grants(&["storage"]);
    let before = k.plugins.snapshot();
    for reviewed in [None, Some("0".repeat(64))] {
        let err = enable(
            &k.data,
            &k.plugins,
            ID,
            Some(&caps),
            false,
            reviewed.as_deref(),
        )
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::ManifestChanged, "{reviewed:?}");
    }
    assert_eq!(k.plugins.snapshot(), before);
    assert!(!k.plugins.is_enabled(ID));
    consent(&k.plugins, &k.data, Some(&["storage"]), false).unwrap();
    assert!(k.plugins.is_enabled(ID));

    // A ready plugin needs no hash, but a wrong one is still refused.
    disable(&k.data, &k.plugins, ID).unwrap();
    let err = enable(&k.data, &k.plugins, ID, None, false, Some("stale")).unwrap_err();
    assert_eq!(err.code, ErrorCode::ManifestChanged);
    enable(&k.data, &k.plugins, ID, None, false, None).unwrap();
    assert!(k.plugins.is_enabled(ID));
}

#[test]
fn an_edited_manifest_is_granted_only_with_its_own_hash() {
    let k = Kit::new();
    let first = ui("1.0.0", &["network"]);
    let mut first = first;
    first["network"] = json!(["https://a.example.com"]);
    k.install(&first);
    let old_hash = k.plugins.snapshot().entries[0].manifest_hash.clone();
    let mut edited = first.clone();
    edited["network"] = json!(["https://evil.example.com"]);
    let edited = edited.to_string();
    fs::write(plugin_dir(&k.data, ID).join("plugin.json"), &edited).unwrap();
    let caps = grants(&["network"]);

    let err = enable(&k.data, &k.plugins, ID, Some(&caps), false, Some(&old_hash)).unwrap_err();
    assert_eq!(err.code, ErrorCode::ManifestChanged);
    // The same request again: the new hash is now recorded, but it is not the one reviewed.
    let err = enable(&k.data, &k.plugins, ID, Some(&caps), false, Some(&old_hash)).unwrap_err();
    assert_eq!(err.code, ErrorCode::ManifestChanged);
    assert!(!k.plugins.is_enabled(ID));
    let new_hash = manifest_hash(edited.as_bytes());
    enable(&k.data, &k.plugins, ID, Some(&caps), false, Some(&new_hash)).unwrap();
    assert!(k.plugins.is_enabled(ID));
}

#[test]
fn an_empty_recorded_hash_counts_as_changed() {
    let k = Kit::new();
    k.install(&ui("1.0.0", &["storage"]));
    k.set_entry(|e| e.manifest_hash.clear());
    let err = enable(
        &k.data,
        &k.plugins,
        ID,
        Some(&grants(&["storage"])),
        false,
        Some(""),
    )
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::ManifestChanged);
    assert!(!k.saved_entry().manifest_hash.is_empty());
    assert!(!k.plugins.is_enabled(ID));
}

#[test]
fn a_native_plugin_needs_the_acknowledgement() {
    let k = Kit::new();
    k.install(&native("1.0.0", &["audio.tap"]));
    let err = consent(&k.plugins, &k.data, Some(&["audio.tap"]), false).unwrap_err();
    assert_eq!(err.code, ErrorCode::NativeAckRequired);
    assert!(!k.plugins.is_enabled(ID));
    let row = consent(&k.plugins, &k.data, Some(&["audio.tap"]), true).unwrap();
    assert_eq!(row.entry.state, EntryState::Ready);
    assert!(k.plugins.is_enabled(ID));
}

#[test]
fn enable_runs_the_starter_and_approve_does_not() {
    let k = Kit::new();
    k.install(&native("1.0.0", &["audio.tap"]));
    approval(&k.plugins, &k.data, Some(&["audio.tap"]), true).unwrap();
    assert!(k.starts().is_empty());
    enable(&k.data, &k.plugins, ID, None, false, None).unwrap();
    // Runs after the change is saved, so the plugin is already serving.
    assert_eq!(k.starts(), [ID]);
    let err = enable(&k.data, &k.plugins, ID, Some(&[][..]), false, None).unwrap_err();
    assert_eq!(err.code, ErrorCode::ConsentMismatch);
    assert_eq!(k.starts(), [ID], "a refused enable starts nothing");
}

#[test]
fn an_enable_that_demotes_a_running_plugin_stops_it() {
    let k = Kit::new();
    k.install(&native("1.0.0", &[]));
    k.enable(&[]);
    let mut edited = native("1.0.0", &[]);
    edited["name"] = json!("Edited");
    fs::write(
        plugin_dir(&k.data, ID).join("plugin.json"),
        edited.to_string(),
    )
    .unwrap();
    let err = enable(&k.data, &k.plugins, ID, None, false, None).unwrap_err();
    assert_eq!(err.code, ErrorCode::ManifestChanged);
    assert!(!k.plugins.is_enabled(ID));
    assert_eq!(k.stops(), [ID]);
    assert_eq!(k.starts(), [ID], "only the first enable started it");
}

#[test]
fn a_failed_uninstall_starts_the_stopped_plugin_again() {
    let k = Kit::new();
    k.install(&native("1.0.0", &[]));
    k.enable(&[]);
    k.break_saves();
    uninstall(&k.data, &k.plugins, ID, false).unwrap_err();
    assert_eq!(k.stops(), [ID]);
    assert_eq!(k.starts(), [ID, ID]);
    assert!(k.plugins.is_enabled(ID));
}

#[test]
fn an_enable_during_an_uninstall_starts_nothing() {
    let k = Kit::new();
    k.install(&native("1.0.0", &[]));
    k.enable(&[]);
    let plugins = std::sync::Arc::new(k.relaunch());
    k.record(&plugins);
    let weak = std::sync::Arc::downgrade(&plugins);
    let data = k.data.clone();
    plugins.set_stopper(std::sync::Arc::new(move |id: &str| {
        let p = weak.upgrade().unwrap();
        let refused = enable(&data, &p, id, None, false, None).unwrap_err();
        assert_eq!(refused.code, ErrorCode::Busy);
    }));
    uninstall(&k.data, &plugins, ID, false).unwrap();
    assert_eq!(k.starts(), [ID]);
    assert!(plugins.rows().is_empty());
    assert!(!plugins.is_enabled(ID));
}

#[test]
fn disable_keeps_consent_and_enable_again_needs_no_grants() {
    let k = Kit::new();
    k.install(&ui("1.0.0", &["storage"]));
    k.enable(&["storage"]);
    assert!(k.stops().is_empty());

    let row = disable(&k.data, &k.plugins, ID).unwrap();
    assert!(!row.entry.enabled);
    assert_eq!(row.entry.state, EntryState::Ready);
    assert_eq!(row.entry.granted, vec![Capability::Storage]);
    assert!(!k.plugins.is_enabled(ID));
    assert_eq!(k.stops(), [ID]);

    // Disabling again changes nothing and stops nothing.
    let generation = k.plugins.generation();
    disable(&k.data, &k.plugins, ID).unwrap();
    assert_eq!(k.plugins.generation(), generation);
    assert_eq!(k.stops(), [ID]);

    // Wrong grants are still refused on a ready plugin; none at all is fine.
    let err = consent(&k.plugins, &k.data, Some(&[]), false).unwrap_err();
    assert_eq!(err.code, ErrorCode::ConsentMismatch);
    let row = enable(&k.data, &k.plugins, ID, None, false, None).unwrap();
    assert!(row.entry.enabled);
    assert!(k.plugins.is_enabled(ID));

    // Enabling an enabled plugin is a quiet success.
    let generation = k.plugins.generation();
    enable(&k.data, &k.plugins, ID, None, false, None).unwrap();
    assert_eq!(k.plugins.generation(), generation);
}

#[test]
fn disabling_a_broken_plugin_sticks_through_its_recovery() {
    let k = Kit::new();
    k.install(&ui("1.0.0", &["storage"]));
    k.enable(&["storage"]);
    let live = plugin_dir(&k.data, ID);
    let aside = k.data.join("aside");
    fs::rename(&live, &aside).unwrap();
    let plugins = k.reboot();
    assert_eq!(plugins.rows()[0].entry.ready_enabled, Some(true));
    let generation = plugins.generation();
    disable(&k.data, &plugins, ID).unwrap();
    assert_eq!(plugins.generation(), generation + 1);

    fs::rename(&aside, &live).unwrap();
    let recovered = k.reboot();
    let e = &recovered.rows()[0].entry;
    assert_eq!(e.state, EntryState::Ready);
    assert!(!e.enabled);
    assert!(!recovered.is_enabled(ID));
}

#[test]
fn broken_and_incompatible_plugins_are_refused() {
    let k = Kit::new();
    k.install(&ui("1.0.0", &["storage"]));
    let mut legacy = ui("1.0.0", &["storage"]);
    legacy["id"] = json!("com.example.legacy");
    legacy["min_plisto"] = json!("999.0.0");
    k.install(&legacy);
    let err = enable(
        &k.data,
        &k.plugins,
        "com.example.legacy",
        Some(&grants(&["storage"])),
        false,
        None,
    )
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::Incompatible);

    fs::remove_dir_all(plugin_dir(&k.data, ID)).unwrap();
    let plugins = k.reboot();
    let err = consent(&plugins, &k.data, Some(&["storage"]), false).unwrap_err();
    assert_eq!(err.code, ErrorCode::Broken);
    assert!(!plugins.is_enabled(ID));
}

#[test]
fn a_folder_that_broke_since_install_is_marked_broken_and_refused() {
    let k = Kit::new();
    k.install(&ui("1.0.0", &["storage"]));
    fs::remove_file(plugin_dir(&k.data, ID).join("index.html")).unwrap();
    let generation = k.plugins.generation();
    let err = consent(&k.plugins, &k.data, Some(&["storage"]), false).unwrap_err();
    assert_eq!(err.code, ErrorCode::Broken);
    let rows = k.plugins.rows();
    assert_eq!(rows[0].entry.state, EntryState::Broken);
    assert!(rows[0].problem.as_deref().unwrap().contains("'entry'"));
    // The refusal saved a change, so the event goes out.
    assert_eq!(k.plugins.generation(), generation + 1);
    assert!(!k.plugins.is_enabled(ID));
    assert_eq!(k.saved_entry().state, EntryState::Broken);
}

#[test]
fn a_manifest_changed_since_install_asks_for_consent_again() {
    let k = Kit::new();
    let first = ui("1.0.0", &["storage"]);
    k.install(&first);
    k.enable(&["storage"]);
    disable(&k.data, &k.plugins, ID).unwrap();

    let mut edited = first.clone();
    edited["name"] = json!("Edited");
    let edited = edited.to_string();
    fs::write(plugin_dir(&k.data, ID).join("plugin.json"), &edited).unwrap();
    let generation = k.plugins.generation();
    let err = enable(&k.data, &k.plugins, ID, None, false, None).unwrap_err();
    assert_eq!(err.code, ErrorCode::ManifestChanged);
    assert_eq!(k.plugins.generation(), generation + 1);
    let saved = k.saved_entry();
    assert_eq!(saved.state, EntryState::NeedsConsent);
    assert!(!saved.enabled && saved.granted.is_empty());
    assert_eq!(saved.manifest_hash, manifest_hash(edited.as_bytes()));
    assert!(!k.plugins.is_enabled(ID));
    consent(&k.plugins, &k.data, Some(&["storage"]), false).unwrap();
    assert!(k.plugins.is_enabled(ID));
}

#[test]
fn an_edited_plugin_leaves_the_serving_set_even_when_the_save_fails() {
    let k = Kit::new();
    k.install(&ui("1.0.0", &["storage"]));
    k.enable(&["storage"]);
    let before = k.plugins.snapshot();
    let mut edited = ui("1.0.0", &["storage"]);
    edited["name"] = json!("Edited");
    fs::write(
        plugin_dir(&k.data, ID).join("plugin.json"),
        edited.to_string(),
    )
    .unwrap();
    k.break_saves();
    let err = enable(&k.data, &k.plugins, ID, None, false, None).unwrap_err();
    assert_eq!(err.code, ErrorCode::Io);
    assert_eq!(k.plugins.snapshot(), before, "memory is left as it was");
    assert!(!k.plugins.is_enabled(ID));
    // An unrelated change does not put it back.
    let mut other = ui("1.0.0", &[]);
    other["id"] = json!("com.example.other");
    k.unbreak_saves();
    k.install(&other);
    assert!(!k.plugins.is_enabled(ID));
}

#[test]
fn unknown_ids_are_not_found() {
    let k = Kit::new();
    for code in [
        enable(&k.data, &k.plugins, ID, None, false, None)
            .unwrap_err()
            .code,
        disable(&k.data, &k.plugins, ID).unwrap_err().code,
        uninstall(&k.data, &k.plugins, ID, true).unwrap_err().code,
    ] {
        assert_eq!(code, ErrorCode::NotFound);
    }
    assert!(k.stops().is_empty());
}

#[test]
fn install_bumps_the_generation() {
    let k = Kit::new();
    let generation = k.plugins.generation();
    k.install(&ui("1.0.0", &["storage"]));
    assert_eq!(k.plugins.generation(), generation + 1);
}

#[test]
fn uninstall_keeps_the_data_unless_asked() {
    let k = Kit::new();
    k.install(&ui("1.0.0", &["storage"]));
    k.enable(&["storage"]);
    let data = data_dir(&k.data, ID);
    fs::create_dir_all(&data).unwrap();
    fs::write(data.join("kv.json"), b"{}").unwrap();

    let done = uninstall(&k.data, &k.plugins, ID, false).unwrap();
    assert_eq!(done.data_warning, None);
    assert!(!plugin_dir(&k.data, ID).exists());
    assert!(data.join("kv.json").is_file());
    assert!(k.plugins.rows().is_empty());
    assert!(!k.plugins.is_enabled(ID));
    assert_eq!(k.stops(), [ID]);
    assert_eq!(fs::read_dir(staging_dir(&k.data)).unwrap().count(), 0);
    assert!(k.reboot().rows().is_empty(), "nothing is adopted again");

    k.install(&ui("1.0.0", &["storage"]));
    uninstall(&k.data, &k.plugins, ID, true).unwrap();
    assert!(!data.exists());
    assert!(
        data_dir(&k.data, "").is_dir(),
        "only that plugin's data goes"
    );
}

#[cfg(windows)]
#[test]
fn a_data_folder_that_cannot_go_is_a_warning() {
    let k = Kit::new();
    k.install(&ui("1.0.0", &["storage"]));
    let data = data_dir(&k.data, ID);
    fs::create_dir_all(&data).unwrap();
    fs::write(data.join("kv.json"), b"{}").unwrap();
    let held = crate::plugins::test_kit::hold(&data.join("kv.json"));
    let done = uninstall(&k.data, &k.plugins, ID, true).unwrap();
    drop(held);
    assert!(done.data_warning.is_some());
    assert!(k.plugins.rows().is_empty());
    assert!(!plugin_dir(&k.data, ID).exists());
    assert!(data.join("kv.json").is_file());
}

#[test]
fn uninstall_also_removes_a_leftover_old_folder() {
    let k = Kit::new();
    k.install(&ui("1.0.0", &["storage"]));
    let old = old_dir(&k.data, ID);
    fs::create_dir_all(&old).unwrap();
    fs::write(
        old.join("plugin.json"),
        ui("0.9.0", &["storage"]).to_string(),
    )
    .unwrap();
    fs::write(old.join("index.html"), b"<p>").unwrap();
    uninstall(&k.data, &k.plugins, ID, false).unwrap();
    assert!(!old.exists());
    let again = k.reboot();
    assert!(
        again.rows().is_empty(),
        "the old version does not come back"
    );
    assert!(!plugin_dir(&k.data, ID).exists());
}

#[test]
fn a_broken_entry_with_no_folder_uninstalls() {
    let k = Kit::new();
    k.install(&ui("1.0.0", &["storage"]));
    fs::remove_dir_all(plugin_dir(&k.data, ID)).unwrap();
    let plugins = k.reboot();
    assert_eq!(plugins.rows()[0].entry.state, EntryState::Broken);
    uninstall(&k.data, &plugins, ID, true).unwrap();
    assert!(plugins.rows().is_empty());
}

#[test]
fn a_failed_uninstall_save_puts_the_folders_back() {
    let k = Kit::new();
    k.install(&ui("1.0.0", &["storage"]));
    k.enable(&["storage"]);
    let old = old_dir(&k.data, ID);
    fs::create_dir_all(&old).unwrap();
    let before = k.plugins.snapshot();
    k.break_saves();
    let err = uninstall(&k.data, &k.plugins, ID, true).unwrap_err();
    assert_eq!(err.code, ErrorCode::Io);
    assert!(plugin_dir(&k.data, ID).join("plugin.json").is_file());
    assert!(old.is_dir());
    assert_eq!(k.plugins.snapshot(), before);
    assert!(k.plugins.is_enabled(ID));
    assert_eq!(fs::read_dir(staging_dir(&k.data)).unwrap().count(), 0);
}

#[test]
fn nothing_changes_after_a_failed_boot_read() {
    let k = Kit::new();
    k.install(&ui("1.0.0", &["storage"]));
    fs::remove_file(registry_file(&k.data)).unwrap();
    fs::create_dir_all(registry_file(&k.data)).unwrap();
    let plugins = k.reboot();
    assert!(!plugins.registry_writable());
    let codes = [
        consent(&plugins, &k.data, Some(&["storage"]), false)
            .unwrap_err()
            .code,
        disable(&k.data, &plugins, ID).unwrap_err().code,
        uninstall(&k.data, &plugins, ID, true).unwrap_err().code,
    ];
    assert!(codes.iter().all(|c| *c == ErrorCode::RegistryUnavailable));
    assert!(registry_file(&k.data).is_dir());
    assert!(plugin_dir(&k.data, ID).join("plugin.json").is_file());
}

/// `approve` with the hash recorded for the demo plugin, as the review sheet would send it.
fn approval(
    plugins: &PluginsState,
    data: &Path,
    caps: Option<&[&str]>,
    ack: bool,
) -> Result<PluginRow, InstallError> {
    let hash = plugins
        .snapshot()
        .entry(ID)
        .map(|e| e.manifest_hash.clone());
    let given = caps.map(grants);
    approve(data, plugins, ID, given.as_deref(), ack, hash.as_deref())
}

#[test]
fn approve_grants_consent_and_leaves_the_plugin_off() {
    let k = Kit::new();
    k.install(&ui("1.0.0", &["storage", "ui.toast"]));
    let generation = k.plugins.generation();
    let row = approval(&k.plugins, &k.data, Some(&["ui.toast", "storage"]), false).unwrap();
    assert_eq!(row.entry.state, EntryState::Ready);
    assert!(!row.entry.enabled);
    assert_eq!(
        row.entry.granted,
        vec![Capability::Storage, Capability::UiToast]
    );
    assert!(!k.plugins.is_enabled(ID));
    assert_eq!(k.plugins.generation(), generation + 1);
    assert!(k.stops().is_empty());
    let saved = k.saved_entry();
    assert_eq!(saved.state, EntryState::Ready);
    assert!(!saved.enabled);
    assert_eq!(saved.granted, row.entry.granted);
    assert!(!k.reboot().is_enabled(ID));

    // Enabling afterwards needs no grants.
    let row = enable(&k.data, &k.plugins, ID, None, false, None).unwrap();
    assert!(row.entry.enabled);
    assert!(k.plugins.is_enabled(ID));
}

#[test]
fn approve_refuses_what_enable_refuses() {
    let k = Kit::new();
    k.install(&ui("1.0.0", &["storage", "ui.toast"]));
    let before = k.plugins.snapshot();
    let generation = k.plugins.generation();
    let caps = grants(&["storage", "ui.toast"]);
    for reviewed in [None, Some("0".repeat(64))] {
        let err = approve(
            &k.data,
            &k.plugins,
            ID,
            Some(&caps),
            false,
            reviewed.as_deref(),
        )
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::ManifestChanged, "{reviewed:?}");
    }
    let cases: [Option<&[&str]>; 4] = [
        None,
        Some(&["storage"]),
        Some(&["storage", "ui.toast", "network"]),
        Some(&["storage", "storage"]),
    ];
    for case in cases {
        let err = approval(&k.plugins, &k.data, case, true).unwrap_err();
        assert_eq!(err.code, ErrorCode::ConsentMismatch, "{case:?}");
    }
    assert_eq!(k.plugins.snapshot(), before);
    assert_eq!(k.plugins.generation(), generation);

    let err = approve(&k.data, &k.plugins, "com.example.none", None, false, None).unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
}

#[test]
fn approving_a_native_plugin_needs_the_acknowledgement() {
    let k = Kit::new();
    k.install(&native("1.0.0", &["audio.tap"]));
    let err = approval(&k.plugins, &k.data, Some(&["audio.tap"]), false).unwrap_err();
    assert_eq!(err.code, ErrorCode::NativeAckRequired);
    assert_eq!(
        k.plugins.snapshot().entries[0].state,
        EntryState::NeedsConsent
    );
    let row = approval(&k.plugins, &k.data, Some(&["audio.tap"]), true).unwrap();
    assert_eq!(row.entry.state, EntryState::Ready);
    assert!(!row.entry.enabled);
}

#[test]
fn approving_a_ready_plugin_changes_nothing() {
    let k = Kit::new();
    k.install(&ui("1.0.0", &["storage"]));
    k.enable(&["storage"]);
    let before = k.plugins.snapshot();
    let generation = k.plugins.generation();

    // Enabled stays enabled.
    let row = approve(&k.data, &k.plugins, ID, None, false, None).unwrap();
    assert!(row.entry.enabled);
    assert!(k.plugins.is_enabled(ID));
    assert_eq!(k.plugins.snapshot(), before);
    assert_eq!(k.plugins.generation(), generation);

    // Disabled stays disabled.
    disable(&k.data, &k.plugins, ID).unwrap();
    let before = k.plugins.snapshot();
    let generation = k.plugins.generation();
    let row = approval(&k.plugins, &k.data, Some(&["storage"]), false).unwrap();
    assert!(!row.entry.enabled);
    assert!(!k.plugins.is_enabled(ID));
    assert_eq!(k.plugins.snapshot(), before);
    assert_eq!(k.plugins.generation(), generation);
    assert_eq!(k.stops(), [ID]);
}

#[test]
fn approve_demotes_a_changed_folder_as_enable_does() {
    let k = Kit::new();
    let first = ui("1.0.0", &["storage"]);
    k.install(&first);
    k.enable(&["storage"]);
    let mut edited = first.clone();
    edited["name"] = json!("Edited");
    let edited = edited.to_string();
    fs::write(plugin_dir(&k.data, ID).join("plugin.json"), &edited).unwrap();
    let generation = k.plugins.generation();
    let err = approve(&k.data, &k.plugins, ID, None, false, None).unwrap_err();
    assert_eq!(err.code, ErrorCode::ManifestChanged);
    assert_eq!(k.plugins.generation(), generation + 1);
    let saved = k.saved_entry();
    assert_eq!(saved.state, EntryState::NeedsConsent);
    assert!(!saved.enabled && saved.granted.is_empty());
    assert_eq!(saved.manifest_hash, manifest_hash(edited.as_bytes()));
    assert!(
        !k.plugins.is_enabled(ID),
        "the demotion takes it out of service"
    );
    assert_eq!(k.stops(), [ID], "the demotion stops the running plugin");

    fs::remove_file(plugin_dir(&k.data, ID).join("index.html")).unwrap();
    let err = approval(&k.plugins, &k.data, Some(&["storage"]), false).unwrap_err();
    assert_eq!(err.code, ErrorCode::Broken);
    assert_eq!(k.saved_entry().state, EntryState::Broken);
}

#[test]
fn approve_refuses_a_broken_plugin_and_an_unwritable_registry() {
    let k = Kit::new();
    k.install(&ui("1.0.0", &["storage"]));
    fs::remove_dir_all(plugin_dir(&k.data, ID)).unwrap();
    let plugins = k.reboot();
    let err = approval(&plugins, &k.data, Some(&["storage"]), false).unwrap_err();
    assert_eq!(err.code, ErrorCode::Broken);

    let k = Kit::new();
    k.install(&ui("1.0.0", &["storage"]));
    fs::remove_file(registry_file(&k.data)).unwrap();
    fs::create_dir_all(registry_file(&k.data)).unwrap();
    let plugins = k.reboot();
    let err = approval(&plugins, &k.data, Some(&["storage"]), false).unwrap_err();
    assert_eq!(err.code, ErrorCode::RegistryUnavailable);
}

fn networked(origins: &[&str]) -> serde_json::Value {
    let mut manifest = ui("1.0.0", &["network"]);
    manifest["network"] = json!(origins);
    manifest
}

/// The origins the demo plugin is served with, or None when it is not serving.
fn served_origins(plugins: &PluginsState) -> Option<Vec<String>> {
    plugins
        .enabled_set()
        .serving(ID)
        .map(|s| s.origins.to_vec())
}

#[test]
fn enabling_serves_the_reviewed_origins_and_a_boot_rebuilds_them() {
    let k = Kit::new();
    let list = ["https://a.example.com", "https://b.example.com:8443"];
    k.install(&networked(&list));
    assert!(k.plugins.rows()[0].granted_origins.is_empty());
    k.enable(&["network"]);
    assert_eq!(served_origins(&k.plugins).unwrap(), list);

    let row = &k.plugins.rows()[0];
    assert_eq!(row.granted_origins, list);
    let json = serde_json::to_value(row).unwrap();
    assert_eq!(json["granted_origins"], json!(list));
    assert!(json.get("consented_network").is_none());
    let text = fs::read_to_string(registry_file(&k.data)).unwrap();
    assert!(!text.contains("example.com"), "{text}");

    let booted = k.relaunch();
    assert_eq!(served_origins(&booted).unwrap(), list);
    assert!(!booted.enabled_set().serving(ID).unwrap().dev_mode);

    // The serving set follows the developer switch.
    k.plugins
        .mutate(
            &k.data,
            Withdraw::No,
            |registry, _| {
                registry.dev_mode = true;
                Ok(())
            },
            save_failed,
        )
        .unwrap();
    assert!(k.plugins.enabled_set().serving(ID).unwrap().dev_mode);
    assert_eq!(served_origins(&k.plugins).unwrap(), list);
}

#[test]
fn approve_holds_the_origins_and_serves_none_until_enabled() {
    let k = Kit::new();
    k.install(&networked(&["https://a.example.com"]));
    let row = approval(&k.plugins, &k.data, Some(&["network"]), false).unwrap();
    assert_eq!(row.granted_origins, ["https://a.example.com"]);
    assert_eq!(served_origins(&k.plugins), None);
    enable(&k.data, &k.plugins, ID, None, false, None).unwrap();
    assert_eq!(
        served_origins(&k.plugins).unwrap(),
        ["https://a.example.com"]
    );
}

#[test]
fn a_manifest_rewritten_mid_run_changes_nothing_until_the_next_enable_or_boot() {
    let k = Kit::new();
    k.install(&networked(&["https://a.example.com"]));
    k.enable(&["network"]);
    let rewritten = networked(&["https://evil.example.com"]).to_string();
    fs::write(plugin_dir(&k.data, ID).join("plugin.json"), &rewritten).unwrap();
    assert_eq!(
        served_origins(&k.plugins).unwrap(),
        ["https://a.example.com"]
    );
    assert_eq!(
        k.plugins.rows()[0].granted_origins,
        ["https://a.example.com"]
    );

    let booted = k.relaunch();
    assert_eq!(served_origins(&booted), None);
    assert!(booted.rows()[0].granted_origins.is_empty());

    let err = enable(&k.data, &k.plugins, ID, None, false, None).unwrap_err();
    assert_eq!(err.code, ErrorCode::ManifestChanged);
    assert_eq!(served_origins(&k.plugins), None);
    let e = k.plugins.snapshot().entries[0].clone();
    assert_eq!(e.state, EntryState::NeedsConsent);
    assert!(e.consented_network.is_empty());

    // Consent to the rewritten manifest holds its own list.
    let hash = manifest_hash(rewritten.as_bytes());
    let caps = grants(&["network"]);
    enable(&k.data, &k.plugins, ID, Some(&caps), false, Some(&hash)).unwrap();
    assert_eq!(
        served_origins(&k.plugins).unwrap(),
        ["https://evil.example.com"]
    );
}

#[test]
fn disable_withdraws_the_origins_and_reset_consent_empties_them() {
    let k = Kit::new();
    k.install(&networked(&["https://a.example.com"]));
    k.enable(&["network"]);
    disable(&k.data, &k.plugins, ID).unwrap();
    assert_eq!(served_origins(&k.plugins), None);
    enable(&k.data, &k.plugins, ID, None, false, None).unwrap();
    assert_eq!(
        served_origins(&k.plugins).unwrap(),
        ["https://a.example.com"]
    );

    let mut e = k.plugins.snapshot().entries[0].clone();
    reset_consent(&mut e);
    assert!(e.consented_network.is_empty() && e.granted.is_empty());
}

#[test]
fn an_enable_that_finds_the_folder_broken_or_outdated_empties_the_origins() {
    for (code, state) in [
        (ErrorCode::Broken, EntryState::Broken),
        (ErrorCode::Incompatible, EntryState::Incompatible),
    ] {
        let k = Kit::new();
        k.install(&networked(&["https://a.example.com"]));
        k.enable(&["network"]);
        let dir = plugin_dir(&k.data, ID);
        if state == EntryState::Broken {
            fs::remove_file(dir.join("index.html")).unwrap();
        } else {
            let mut outdated = networked(&["https://a.example.com"]);
            outdated["min_plisto"] = json!("999.0.0");
            fs::write(dir.join("plugin.json"), outdated.to_string()).unwrap();
        }
        let err = enable(&k.data, &k.plugins, ID, None, false, None).unwrap_err();
        assert_eq!(err.code, code);
        let e = k.plugins.snapshot().entries[0].clone();
        assert_eq!(e.state, state);
        assert!(e.consented_network.is_empty(), "{state:?}");
        assert!(k.plugins.rows()[0].granted_origins.is_empty());
        assert_eq!(served_origins(&k.plugins), None);
    }
}

#[test]
fn an_entry_claiming_network_with_no_list_serves_no_origin() {
    let k = Kit::new();
    k.install(&ui("1.0.0", &["storage"]));
    k.enable(&["storage"]);
    k.set_entry(|e| e.granted.push(Capability::Network));
    let serving = k.plugins.enabled_set().serving(ID).unwrap();
    assert!(serving.granted.contains(&Capability::Network));
    assert!(serving.origins.is_empty());
}

#[test]
fn the_sidebar_collapsed_flag_is_saved_and_returned() {
    let k = Kit::new();
    k.install(&ui("1.0.0", &["storage"]));
    assert!(!k.plugins.snapshot().entries[0].sidebar_collapsed);
    let generation = k.plugins.generation();
    let row = set_sidebar_collapsed(&k.data, &k.plugins, ID, true).unwrap();
    assert!(row.entry.sidebar_collapsed);
    assert!(k.saved_entry().sidebar_collapsed);
    assert_eq!(k.plugins.generation(), generation + 1);
    assert!(k.reboot().rows()[0].entry.sidebar_collapsed);

    // The same value again saves nothing; an enabled plugin stays in service.
    k.enable(&["storage"]);
    let generation = k.plugins.generation();
    set_sidebar_collapsed(&k.data, &k.plugins, ID, true).unwrap();
    assert_eq!(k.plugins.generation(), generation);
    let row = set_sidebar_collapsed(&k.data, &k.plugins, ID, false).unwrap();
    assert!(!row.entry.sidebar_collapsed);
    assert!(row.entry.enabled);
    assert!(k.plugins.is_enabled(ID));
    assert!(k.stops().is_empty());
}

#[test]
fn the_sidebar_collapsed_flag_is_allowed_on_a_broken_plugin_and_refused_for_an_unknown_id() {
    let k = Kit::new();
    k.install(&ui("1.0.0", &["storage"]));
    fs::remove_dir_all(plugin_dir(&k.data, ID)).unwrap();
    let plugins = k.reboot();
    assert_eq!(plugins.rows()[0].entry.state, EntryState::Broken);
    let row = set_sidebar_collapsed(&k.data, &plugins, ID, true).unwrap();
    assert!(row.entry.sidebar_collapsed);
    assert_eq!(row.entry.state, EntryState::Broken);

    let err = set_sidebar_collapsed(&k.data, &plugins, "com.example.none", true).unwrap_err();
    assert_eq!(err.code, ErrorCode::NotInstalled);
}
