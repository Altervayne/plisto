// Installs from a folder or an archive: staging, limits, and what a refusal leaves behind.

// -- Library Imports --
use serde_json::json;
use std::collections::HashSet;
use std::io::{Cursor, Write};
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

// -- Local Imports --
use super::*;
use crate::plugins::paths::{plugins_dir, registry_file, state_dir, validate_id};
use crate::plugins::registry::{self, FileRead};
use crate::plugins::revalidate::{adopt_folders, manifest_hash};
use crate::plugins::stage::{Temp, MAX_FULL_PATH};
use crate::plugins::state::MAX_STAGED;
use crate::plugins::test_kit::{ui, Kit};

const ID: &str = "com.example.demo";
const VERSION: &str = "2.7.0";

fn manifest(id: &str, min: &str) -> String {
    format!(
        r#"{{"manifest_version":1,"id":"{id}","name":"Demo","version":"1.2.0","tier":"ui",
            "entry":"ui/index.html","capabilities":["storage"],"min_plisto":"{min}","author":"A"}}"#
    )
}

/// A source folder for `id` under the temp dir.
fn folder(t: &Temp, name: &str, json: &str) -> PathBuf {
    let src = t.0.join(name);
    fs::create_dir_all(src.join("ui")).unwrap();
    fs::write(src.join("plugin.json"), json).unwrap();
    fs::write(src.join("ui/index.html"), b"<p>").unwrap();
    src
}

fn app_data(t: &Temp) -> PathBuf {
    let dir = t.0.join("appdata");
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn boot(app_data: &Path) -> PluginsState {
    PluginsState::boot(app_data, VERSION, 1, 50)
}

fn staged_count(app_data: &Path) -> usize {
    fs::read_dir(staging_dir(app_data)).map_or(0, |r| r.count())
}

fn inspect_path(
    app_data: &Path,
    plugins: &PluginsState,
    src: &Path,
) -> Result<Inspection, InstallError> {
    inspect(app_data, plugins, src.to_str().unwrap(), Limits::DEFAULT)
}

#[test]
fn inspect_reports_the_manifest_and_discard_leaves_no_trace() {
    let t = Temp::new("install");
    let data = app_data(&t);
    let plugins = boot(&data);
    let src = folder(&t, "src", &manifest(ID, "1.0.0"));
    let found = inspect_path(&data, &plugins, &src).unwrap();
    assert_eq!(found.token.len(), 32);
    assert!(found.token.bytes().all(|b| b.is_ascii_hexdigit()));
    assert_eq!(found.id, ID);
    assert_eq!(found.version, "1.2.0");
    assert_eq!(found.capabilities, vec![Capability::Storage]);
    assert_eq!(found.compat, Compat::Compatible);
    assert_eq!(
        (found.file_count, found.total_bytes),
        (2, fs::metadata(src.join("plugin.json")).unwrap().len() + 3)
    );
    assert_eq!(found.installed, None);
    assert_eq!(staged_count(&data), 1);

    discard(&plugins, &found.token);
    assert_eq!(staged_count(&data), 0);
    assert!(plugins.staged(&found.token).is_none());
    // An unknown token is a quiet no-op.
    discard(&plugins, &found.token);
    assert!(src.join("plugin.json").is_file(), "the source is untouched");
}

#[test]
fn a_refused_source_leaves_no_staging() {
    let t = Temp::new("install");
    let data = app_data(&t);
    let plugins = boot(&data);
    let bad = folder(&t, "bad", "{ nope");
    assert_eq!(
        inspect_path(&data, &plugins, &bad).unwrap_err().code,
        ErrorCode::InvalidManifest
    );
    let no_entry = folder(&t, "no-entry", &manifest(ID, "1.0.0"));
    fs::remove_file(no_entry.join("ui/index.html")).unwrap();
    assert_eq!(
        inspect_path(&data, &plugins, &no_entry).unwrap_err().code,
        ErrorCode::MissingFile
    );
    let bad_icon = folder(
        &t,
        "bad-icon",
        &manifest(ID, "1.0.0").replace("\"author\"", "\"icon\":\"icon.png\",\"author\""),
    );
    fs::write(bad_icon.join("icon.png"), b"not a png").unwrap();
    assert_eq!(
        inspect_path(&data, &plugins, &bad_icon).unwrap_err().code,
        ErrorCode::BadIcon
    );
    assert_eq!(
        inspect_path(&data, &plugins, &t.0.join("nowhere"))
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
    assert_eq!(
        inspect_path(&data, &plugins, &data).unwrap_err().code,
        ErrorCode::UnsafePath
    );
    let archive = t.0.join("evil.plistoplugin");
    let mut w = ZipWriter::new(Cursor::new(Vec::new()));
    for name in ["plugin.json", "../evil.txt"] {
        w.start_file(name, SimpleFileOptions::default()).unwrap();
        w.write_all(b"{}").unwrap();
    }
    fs::write(&archive, w.finish().unwrap().into_inner()).unwrap();
    assert_eq!(
        inspect_path(&data, &plugins, &archive).unwrap_err().code,
        ErrorCode::UnsafePath
    );
    assert_eq!(staged_count(&data), 0);
}

#[test]
fn an_incompatible_plugin_is_reported_not_refused() {
    let t = Temp::new("install");
    let data = app_data(&t);
    let plugins = boot(&data);
    let src = folder(&t, "src", &manifest(ID, "999.0.0"));
    let found = inspect_path(&data, &plugins, &src).unwrap();
    assert_eq!(found.compat, Compat::NeedsNewer("999.0.0".into()));
    let row = install(&data, &plugins, &found.token, 7).unwrap();
    assert_eq!(row.entry.state, EntryState::Incompatible);
    assert!(!row.entry.enabled);
    assert!(row.problem.unwrap().contains("999.0.0"));
}

#[test]
fn install_lands_needs_consent_and_survives_a_reload() {
    let t = Temp::new("install");
    let data = app_data(&t);
    let plugins = boot(&data);
    let json = manifest(ID, "1.0.0");
    let src = folder(&t, "src", &json);
    let found = inspect_path(&data, &plugins, &src).unwrap();
    let row = install(&data, &plugins, &found.token, 77).unwrap();
    let e = &row.entry;
    assert_eq!(e.state, EntryState::NeedsConsent);
    assert!(!e.enabled && e.granted.is_empty());
    assert_eq!(e.manifest_hash, manifest_hash(json.as_bytes()));
    assert_eq!(e.installed_at, 77);
    assert_eq!(e.source_path.as_deref(), src.to_str());
    assert!(row.problem.is_none());
    assert!(!plugins.is_enabled(ID));
    assert!(plugin_dir(&data, ID).join("ui/index.html").is_file());
    assert_eq!(staged_count(&data), 0);
    assert!(plugins.staged(&found.token).is_none());
    assert_eq!(plugins.rows().len(), 1);

    let again = boot(&data);
    let rows = again.rows();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].entry, row.entry);
    assert!(rows[0].problem.is_none());
    match registry::read_file(&data) {
        FileRead::Parsed(read) => assert_eq!(read.entries[0].id, ID),
        other => panic!("{other:?}"),
    }
}

#[test]
fn install_from_an_archive_with_a_wrapping_folder() {
    let t = Temp::new("install");
    let data = app_data(&t);
    let plugins = boot(&data);
    let mut w = ZipWriter::new(Cursor::new(Vec::new()));
    let opts = SimpleFileOptions::default();
    for (name, body) in [
        ("demo/plugin.json", manifest(ID, "1.0.0")),
        ("demo/ui/index.html", "<p>".to_string()),
    ] {
        w.start_file(name, opts).unwrap();
        w.write_all(body.as_bytes()).unwrap();
    }
    let archive = t.0.join("demo.plistoplugin");
    fs::write(&archive, w.finish().unwrap().into_inner()).unwrap();
    let found = inspect_path(&data, &plugins, &archive).unwrap();
    assert_eq!(found.file_count, 2);
    install(&data, &plugins, &found.token, 1).unwrap();
    assert!(plugin_dir(&data, ID).join("plugin.json").is_file());
}

#[test]
fn a_tampered_staged_manifest_is_refused() {
    let t = Temp::new("install");
    let data = app_data(&t);
    let plugins = boot(&data);
    let src = folder(&t, "src", &manifest(ID, "1.0.0"));
    let found = inspect_path(&data, &plugins, &src).unwrap();
    let staged = plugins.staged(&found.token).unwrap();
    fs::write(
        staged.dir.join("plugin.json"),
        manifest(ID, "1.0.0").replace("\"Demo\"", "\"Other\""),
    )
    .unwrap();
    assert_eq!(
        install(&data, &plugins, &found.token, 1).unwrap_err().code,
        ErrorCode::InvalidManifest
    );
    assert!(!plugin_dir(&data, ID).exists());
    assert!(plugins.rows().is_empty());
}

#[test]
fn an_installed_id_is_refused_and_stays_staged() {
    let t = Temp::new("install");
    let data = app_data(&t);
    let plugins = boot(&data);
    let src = folder(&t, "src", &manifest(ID, "1.0.0"));
    let first = inspect_path(&data, &plugins, &src).unwrap();
    install(&data, &plugins, &first.token, 1).unwrap();

    let second = inspect_path(&data, &plugins, &src).unwrap();
    assert_eq!(second.installed.as_deref(), Some("1.2.0"));
    let err = install(&data, &plugins, &second.token, 2).unwrap_err();
    assert_eq!(err.code, ErrorCode::AlreadyInstalled);
    let kept = plugins.staged(&second.token).unwrap();
    assert!(kept.dir.join("plugin.json").is_file());
    assert_eq!(plugins.rows().len(), 1);

    // A folder with the id but no registry row counts too.
    let other = "com.example.other";
    fs::create_dir_all(plugin_dir(&data, other)).unwrap();
    let src = folder(&t, "src-other", &manifest(other, "1.0.0"));
    let found = inspect_path(&data, &plugins, &src).unwrap();
    assert_eq!(found.installed.as_deref(), Some(""));
    assert_eq!(
        install(&data, &plugins, &found.token, 2).unwrap_err().code,
        ErrorCode::AlreadyInstalled
    );
}

#[test]
fn unknown_tokens_are_refused() {
    let t = Temp::new("install");
    let data = app_data(&t);
    let plugins = boot(&data);
    assert_eq!(
        install(&data, &plugins, "0123", 1).unwrap_err().code,
        ErrorCode::UnknownToken
    );
}

#[test]
fn a_ninth_inspection_evicts_the_oldest() {
    let t = Temp::new("install");
    let data = app_data(&t);
    let plugins = boot(&data);
    let src = folder(&t, "src", &manifest(ID, "1.0.0"));
    let tokens: Vec<String> = (0..9)
        .map(|_| inspect_path(&data, &plugins, &src).unwrap().token)
        .collect();
    assert_eq!(tokens.iter().collect::<HashSet<_>>().len(), 9);
    assert_eq!(staged_count(&data), 8);
    assert!(plugins.staged(&tokens[0]).is_none());
    assert!(!staging_dir(&data).join(&tokens[0]).exists());
    assert!(tokens[1..].iter().all(|tk| plugins.staged(tk).is_some()));
}

#[test]
fn boot_sweeps_staging_and_never_adopts_it_or_the_inbox() {
    let t = Temp::new("install");
    let data = app_data(&t);
    let plugins = boot(&data);
    let src = folder(&t, "src", &manifest(ID, "1.0.0"));
    inspect_path(&data, &plugins, &src).unwrap();
    fs::write(staging_dir(&data).join("stray.txt"), b"x").unwrap();
    fs::create_dir_all(inbox_dir(&data).join(ID)).unwrap();
    fs::write(
        inbox_dir(&data).join(ID).join("plugin.json"),
        manifest(ID, "1.0.0"),
    )
    .unwrap();
    // A plugin-shaped folder in either place must not read as installed.
    let staged_like = staging_dir(&data).join(ID);
    fs::create_dir_all(&staged_like).unwrap();

    let again = boot(&data);
    assert_eq!(staged_count(&data), 0);
    assert!(staging_dir(&data).is_dir());
    assert!(again.rows().is_empty());
    assert!(inbox_dir(&data).join(ID).join("plugin.json").is_file());
    let (adopted, _) = adopt_folders(&data, 0, &HashSet::new());
    assert!(adopted.is_empty());
    for name in ["inbox", ".staging"] {
        assert!(plugins_dir(&data).join(name).is_dir());
        assert!(validate_id(name).is_err(), "{name}");
    }
}

#[test]
fn install_is_refused_after_a_failed_boot_read() {
    let t = Temp::new("install");
    let data = app_data(&t);
    // A folder where the registry file belongs: every read fails.
    fs::create_dir_all(registry_file(&data)).unwrap();
    let plugins = boot(&data);
    assert!(!plugins.registry_writable());
    let src = folder(&t, "src", &manifest(ID, "1.0.0"));
    let found = inspect_path(&data, &plugins, &src).unwrap();
    assert_eq!(
        install(&data, &plugins, &found.token, 1).unwrap_err().code,
        ErrorCode::RegistryUnavailable
    );
    assert!(registry_file(&data).is_dir());
    assert!(!plugin_dir(&data, ID).exists());
}

#[test]
fn a_failed_save_moves_the_folder_back_to_staging() {
    let t = Temp::new("install");
    let data = app_data(&t);
    let plugins = boot(&data);
    let src = folder(&t, "src", &manifest(ID, "1.0.0"));
    let found = inspect_path(&data, &plugins, &src).unwrap();
    // A file where the state folder belongs makes the save fail.
    fs::remove_dir_all(state_dir(&data)).unwrap();
    fs::write(state_dir(&data), b"").unwrap();
    let err = install(&data, &plugins, &found.token, 1).unwrap_err();
    assert_eq!(err.code, ErrorCode::Io);
    assert!(!plugin_dir(&data, ID).exists());
    assert!(plugins.rows().is_empty());
    let kept = plugins.staged(&found.token).unwrap();
    assert!(kept.dir.join("ui/index.html").is_file());

    // Once the save can succeed, the same token installs.
    fs::remove_file(state_dir(&data)).unwrap();
    install(&data, &plugins, &found.token, 1).unwrap();
    assert!(plugin_dir(&data, ID).join("plugin.json").is_file());
}

#[test]
fn a_claimed_plugin_survives_discard_and_eviction() {
    let t = Temp::new("install");
    let data = app_data(&t);
    let plugins = boot(&data);
    let src = folder(&t, "src", &manifest(ID, "1.0.0"));
    let found = inspect_path(&data, &plugins, &src).unwrap();
    let staged = claim(&plugins, &found.token).unwrap();

    // Neither a discard nor a full table can reach it now.
    discard(&plugins, &found.token);
    let other = folder(&t, "src-other", &manifest("com.example.other", "1.0.0"));
    for _ in 0..MAX_STAGED + 1 {
        inspect_path(&data, &plugins, &other).unwrap();
    }
    assert!(staged.dir.join("ui/index.html").is_file());
    assert_eq!(
        claim(&plugins, &found.token).unwrap_err().code,
        ErrorCode::UnknownToken
    );

    let row = commit(&data, &plugins, staged, 3, false).unwrap();
    assert_eq!(row.entry.id, ID);
    assert!(plugin_dir(&data, ID).join("ui/index.html").is_file());
}

#[test]
fn a_failed_commit_puts_the_token_back() {
    let t = Temp::new("install");
    let data = app_data(&t);
    let plugins = boot(&data);
    let src = folder(&t, "src", &manifest(ID, "1.0.0"));
    let found = inspect_path(&data, &plugins, &src).unwrap();
    let staged = plugins.staged(&found.token).unwrap();
    fs::write(staged.dir.join("plugin.json"), "{ nope").unwrap();
    assert_eq!(
        install(&data, &plugins, &found.token, 1).unwrap_err().code,
        ErrorCode::InvalidManifest
    );
    assert_eq!(plugins.staged(&found.token), Some(staged));
}

#[test]
fn paths_too_long_for_windows_are_refused_at_inspect() {
    let t = Temp::new("install");
    let data = app_data(&t);
    let plugins = boot(&data);
    // The staging path is the longer of the two: `.staging/<32 hex>` against a shorter id.
    let base = staging_dir(&data).join("0".repeat(32));
    let room = MAX_FULL_PATH - base.to_string_lossy().chars().count() - 1;
    for (name, fits) in [(room, true), (room + 1, false)] {
        let src = folder(&t, &format!("src-{name}"), &manifest(ID, "1.0.0"));
        fs::write(src.join("a".repeat(name)), b"x").unwrap();
        let result = inspect_path(&data, &plugins, &src);
        if fits {
            discard(&plugins, &result.unwrap().token);
        } else {
            let err = result.unwrap_err();
            assert_eq!(err.code, ErrorCode::UnsafePath);
            assert_eq!(err.detail, "path too long for Windows");
        }
        assert_eq!(staged_count(&data), 0);
    }
}

#[test]
fn rename_retries_only_a_held_file() {
    assert!(is_held(&io::Error::from_raw_os_error(32)));
    assert!(is_held(&io::Error::from_raw_os_error(5)));
    assert!(is_held(&io::Error::from(io::ErrorKind::PermissionDenied)));
    assert!(!is_held(&io::Error::from_raw_os_error(2)));
    assert!(!is_held(&io::Error::from(io::ErrorKind::AlreadyExists)));
}

#[test]
fn the_inbox_lists_folders_and_plugin_files_only() {
    let t = Temp::new("install");
    let data = app_data(&t);
    assert!(inbox(&data).unwrap().is_empty());
    let dir = inbox_dir(&data);
    fs::create_dir_all(dir.join("b-folder")).unwrap();
    fs::write(dir.join("a.plistoplugin"), b"").unwrap();
    fs::write(dir.join("C.PLISTOPLUGIN"), b"").unwrap();
    fs::write(dir.join("notes.txt"), b"").unwrap();
    let items = inbox(&data).unwrap();
    let names: Vec<_> = items.iter().map(|i| (i.name.as_str(), i.kind)).collect();
    assert_eq!(
        names,
        [
            ("C.PLISTOPLUGIN", InboxKind::File),
            ("a.plistoplugin", InboxKind::File),
            ("b-folder", InboxKind::Folder),
        ]
    );
    assert!(Path::new(&items[0].path).is_absolute());
    for n in 0..70 {
        fs::write(dir.join(format!("p{n:02}.plistoplugin")), b"").unwrap();
    }
    assert_eq!(inbox(&data).unwrap().len(), MAX_INBOX);
}

#[test]
fn an_inspection_carries_the_origins_and_sidebar_count() {
    let k = Kit::new();
    let mut manifest = ui("1.0.0", &["network", "ui.sidebar"]);
    manifest["network"] = json!(["https://a.example.com"]);
    manifest["sidebar"] = json!({
        "layout": "compact",
        "items": [
            {"id": "home", "type": "nav", "label": "Home", "route": "/"},
            {"id": "more", "type": "nav", "label": "More", "route": "/more"}
        ]
    });
    let found = k.inspect_path(&k.source(&manifest, &[]));
    assert_eq!(found.origins, ["https://a.example.com"]);
    assert_eq!(found.sidebar_items, 2);

    let plain = k.inspect_path(&k.source(&ui("1.0.0", &[]), &[]));
    assert!(plain.origins.is_empty());
    assert_eq!(plain.sidebar_items, 0);
    let json = serde_json::to_value(&plain).unwrap();
    assert_eq!(json["origins"], json!([]));
    assert_eq!(json["sidebar_items"], 0);
}

#[test]
fn an_inspection_reports_saved_data_left_under_a_new_id() {
    let k = Kit::new();
    let manifest = ui("1.0.0", &["storage"]);
    assert!(!k.inspect_path(&k.source(&manifest, &[])).leftover_data);

    let data = data_dir(&k.data, manifest["id"].as_str().unwrap());
    fs::create_dir_all(&data).unwrap();
    fs::write(data.join("kv.json"), b"{}").unwrap();
    let found = k.inspect_path(&k.source(&manifest, &[]));
    assert!(found.leftover_data);
    assert_eq!(serde_json::to_value(&found).unwrap()["leftover_data"], true);

    // Once the id is installed, the data is its own.
    install(&k.data, &k.plugins, &found.token, 1).unwrap();
    let again = k.inspect_path(&k.source(&ui("1.1.0", &["storage"]), &[]));
    assert!(!again.leftover_data);
}

/// Saved data under the demo id, as an earlier plugin of that id left it.
fn leave_data(k: &Kit) -> PathBuf {
    let data = data_dir(&k.data, ID);
    fs::create_dir_all(&data).unwrap();
    fs::write(data.join("kv.json"), b"{\"a\":1}").unwrap();
    data
}

#[test]
fn clearing_data_on_install_deletes_what_was_left_under_the_id() {
    let k = Kit::new();
    let data = leave_data(&k);
    let token = k.inspect(&ui("1.0.0", &["storage"]));
    let row = install_new(&k.data, &k.plugins, &token, 1, true).unwrap();
    assert_eq!(row.entry.id, ID);
    assert!(!data.exists());
    assert!(plugin_dir(&k.data, ID).join("plugin.json").is_file());
}

#[test]
fn without_clearing_the_new_plugin_inherits_the_data() {
    let k = Kit::new();
    let data = leave_data(&k);
    let token = k.inspect(&ui("1.0.0", &["storage"]));
    install_new(&k.data, &k.plugins, &token, 1, false).unwrap();
    assert_eq!(fs::read(data.join("kv.json")).unwrap(), b"{\"a\":1}");
}

#[cfg(windows)]
#[test]
fn a_data_delete_that_fails_commits_nothing() {
    let k = Kit::new();
    let data = leave_data(&k);
    let token = k.inspect(&ui("1.0.0", &["storage"]));
    let held = crate::plugins::test_kit::hold(&data.join("kv.json"));
    let err = install_new(&k.data, &k.plugins, &token, 1, true).unwrap_err();
    drop(held);
    assert_eq!(err.code, ErrorCode::Io);
    assert!(!plugin_dir(&k.data, ID).exists());
    assert!(k.plugins.rows().is_empty());
    assert!(k.plugins.staged(&token).is_some());
    assert_eq!(fs::read(data.join("kv.json")).unwrap(), b"{\"a\":1}");
}

#[test]
fn clearing_data_for_an_installed_id_is_refused_and_deletes_nothing() {
    let k = Kit::new();
    k.install(&ui("1.0.0", &["storage"]));
    let data = leave_data(&k);
    let token = k.inspect(&ui("1.1.0", &["storage"]));
    let err = install_new(&k.data, &k.plugins, &token, 1, true).unwrap_err();
    assert_eq!(err.code, ErrorCode::AlreadyInstalled);
    assert_eq!(fs::read(data.join("kv.json")).unwrap(), b"{\"a\":1}");
    assert!(k.plugins.staged(&token).is_some());
}

#[test]
fn the_inbox_path_is_created_when_missing() {
    let t = Temp::new("inbox-path");
    let path = inbox_path(&t.0).unwrap();
    assert_eq!(Path::new(&path), inbox_dir(&t.0));
    assert!(Path::new(&path).is_dir());
    assert_eq!(inbox_path(&t.0).unwrap(), path);
}

#[test]
fn the_inbox_path_fails_with_io_when_a_file_is_in_the_way() {
    let t = Temp::new("inbox-path");
    fs::write(plugins_dir(&t.0), b"").unwrap();
    assert_eq!(inbox_path(&t.0).unwrap_err().code, ErrorCode::Io);
}
