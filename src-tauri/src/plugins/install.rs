/*
 * Installing a plugin in two steps. Inspect copies the source (a folder or a `.plistoplugin` archive)
 * into `plugins/.staging/<token>/`, validates it with the same checks boot uses, and keeps it staged
 * under a token. Install moves the staged folder to `plugins/<id>/` and records it needs-consent and
 * disabled; nothing ever runs from the source location. The token is a handle, not a secret.
 */

// -- Library Imports --
use std::cell::Cell;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;

// -- Local Imports --
use super::copy_in::copy_in;
use super::extract::extract;
use super::frame_host::is_reparse_point;
use super::install_error::{ErrorCode, InstallError};
use super::lifecycle::{park, save_failed};
use super::manifest::{Capability, Compat, Tier};
use super::paths::{inbox_dir, plugin_dir, staging_dir};
use super::registry::{Entry, EntryState};
use super::revalidate::{check_folder, needs_newer};
use super::sidebar_decl::Layout;
use super::stage::{fits_under, Limits, Totals};
use super::state::{PluginRow, PluginsState, StagedPlugin, Withdraw};

const MAX_INBOX: usize = 64;
const PLUGIN_EXT: &str = "plistoplugin";

// A scanner can hold a file it has just seen; the move into place is retried briefly. It runs under
// the registry lock, so the wait stays short.
const RENAME_ATTEMPTS: u32 = 3;
const RENAME_RETRY_DELAY: Duration = Duration::from_millis(100);
// ERROR_ACCESS_DENIED and ERROR_SHARING_VIOLATION: the two a briefly held file reports.
const HELD_FILE_ERRORS: [i32; 2] = [5, 32];

/// What the review sheet shows before install.
#[derive(Clone, Debug, Serialize)]
pub struct Inspection {
    pub token: String,
    pub id: String,
    pub name: String,
    pub version: String,
    pub author: String,
    pub tier: Tier,
    pub capabilities: Vec<Capability>,
    pub native_reason: Option<String>,
    pub homepage: Option<String>,
    pub compat: Compat,
    pub file_count: usize,
    pub total_bytes: u64,
    /// The installed version when the id is already installed; empty when only its folder exists.
    pub installed: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InboxKind {
    Folder,
    File,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct InboxItem {
    pub name: String,
    pub path: String,
    pub kind: InboxKind,
}

/// 32 hex characters, unique per call within this run.
fn new_token() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let mut hasher = blake3::Hasher::new();
    hasher.update(&nanos.to_le_bytes());
    hasher.update(&std::process::id().to_le_bytes());
    hasher.update(&COUNTER.fetch_add(1, Ordering::Relaxed).to_le_bytes());
    hasher.finalize().to_hex()[..32].to_string()
}

/// The staging folder, created if missing. A link there would send writes outside the app data.
pub(super) fn staging_root(app_data: &Path) -> Result<PathBuf, InstallError> {
    let root = staging_dir(app_data);
    fs::create_dir_all(&root)
        .map_err(|e| InstallError::io("cannot create the staging folder", e))?;
    let meta = fs::symlink_metadata(&root)
        .map_err(|e| InstallError::io("cannot read the staging folder", e))?;
    if !meta.is_dir() || is_reparse_point(&meta) {
        return Err(InstallError::new(
            ErrorCode::LinkNotAllowed,
            "the staging folder is not a plain folder",
        ));
    }
    Ok(root)
}

/// A new, empty folder under the staging root and its token.
pub(super) fn new_staging_dir(root: &Path) -> Result<(String, PathBuf), InstallError> {
    loop {
        let token = new_token();
        let dir = root.join(&token);
        match fs::create_dir(&dir) {
            Ok(()) => return Ok((token, dir)),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(InstallError::io("cannot create a staging folder", e)),
        }
    }
}

/// Copies or extracts `source` into `dir`. A file is read as an archive; anything else as a folder.
fn stage_source(source: &Path, dir: &Path, limits: Limits) -> Result<Totals, InstallError> {
    if fs::metadata(source).is_ok_and(|m| m.is_file()) {
        return extract(source, dir, limits);
    }
    // A folder that holds the staging root would be copied into itself.
    if let (Ok(src), Ok(dest)) = (fs::canonicalize(source), fs::canonicalize(dir)) {
        if dest.starts_with(&src) {
            return Err(InstallError::new(
                ErrorCode::UnsafePath,
                "the folder holds Plisto's own plugin folders",
            ));
        }
    }
    copy_in(source, dir, limits)
}

/// Stages `source`, validates it, and keeps it under a new token. On any failure the staging folder
/// is removed. An incompatible `min_plisto` is reported in `compat`, not refused.
pub fn inspect(
    app_data: &Path,
    plugins: &PluginsState,
    source: &str,
    limits: Limits,
) -> Result<Inspection, InstallError> {
    let root = staging_root(app_data)?;
    let (token, dir) = new_staging_dir(&root)?;
    let checked = stage_source(Path::new(source), &dir, limits)
        .and_then(|totals| Ok((check_folder(&dir, None)?, totals)));
    let ((manifest, hash), totals) = match checked {
        Ok(found) => found,
        Err(e) => {
            let _ = fs::remove_dir_all(&dir);
            return Err(e);
        }
    };
    // Rust reaches long paths itself, but the webview and other tools may not.
    let fits = fits_under(&dir, totals.longest)
        && fits_under(&plugin_dir(app_data, &manifest.id), totals.longest);
    if !fits {
        let _ = fs::remove_dir_all(&dir);
        return Err(InstallError::new(
            ErrorCode::UnsafePath,
            "path too long for Windows",
        ));
    }
    let installed = match plugins.snapshot().entry(&manifest.id) {
        Some(entry) => Some(entry.version.clone()),
        None => fs::symlink_metadata(plugin_dir(app_data, &manifest.id))
            .is_ok()
            .then(String::new),
    };
    let evicted = plugins.keep_staged(StagedPlugin {
        token: token.clone(),
        dir,
        id: manifest.id.clone(),
        manifest_hash: hash,
        source: source.to_string(),
    });
    if let Some(old) = evicted {
        let _ = fs::remove_dir_all(old.dir);
    }
    Ok(Inspection {
        token,
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        author: manifest.author,
        tier: manifest.tier,
        capabilities: manifest.capabilities,
        native_reason: manifest.native_reason,
        homepage: manifest.homepage,
        compat: manifest.compat,
        file_count: totals.files,
        total_bytes: totals.bytes,
        installed,
    })
}

pub(super) fn is_held(e: &io::Error) -> bool {
    e.kind() == io::ErrorKind::PermissionDenied
        || e.raw_os_error()
            .is_some_and(|code| HELD_FILE_ERRORS.contains(&code))
}

/// Renames, retrying only an error a briefly held file can cause.
pub(super) fn rename_with_retry(from: &Path, to: &Path) -> io::Result<()> {
    let mut attempt = 1;
    loop {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) if attempt < RENAME_ATTEMPTS && is_held(&e) => {
                attempt += 1;
                thread::sleep(RENAME_RETRY_DELAY);
            }
            Err(e) => return Err(e),
        }
    }
}

/// Moves a staged plugin to `plugins/<id>/` and records it disabled, with no grants. An id that is
/// already installed is refused and stays staged under its token, for an update to pick up.
pub fn install(
    app_data: &Path,
    plugins: &PluginsState,
    token: &str,
    now: i64,
) -> Result<PluginRow, InstallError> {
    require_writable(plugins)?;
    let staged = claim(plugins, token)?;
    commit(app_data, plugins, staged, now)
}

/// Refuses any change when the registry could not be read at launch: a save would overwrite it.
pub(super) fn require_writable(plugins: &PluginsState) -> Result<(), InstallError> {
    if plugins.registry_writable() {
        return Ok(());
    }
    Err(InstallError::new(
        ErrorCode::RegistryUnavailable,
        "the plugin registry could not be read at launch",
    ))
}

/// Takes the record out of the staged table, so eviction and discard cannot remove its folder while
/// an install or update works on it.
pub(super) fn claim(plugins: &PluginsState, token: &str) -> Result<StagedPlugin, InstallError> {
    plugins.take_staged(token).ok_or_else(|| {
        InstallError::new(ErrorCode::UnknownToken, "no staged plugin for this token")
    })
}

/// Puts a claimed plugin back under its token, when its staged folder is still there.
pub(super) fn restage(plugins: &PluginsState, staged: StagedPlugin) {
    if !staged.dir.is_dir() {
        return;
    }
    if let Some(old) = plugins.keep_staged(staged) {
        let _ = fs::remove_dir_all(old.dir);
    }
}

/// Validates and commits a claimed plugin. On failure it goes back into the staged table.
fn commit(
    app_data: &Path,
    plugins: &PluginsState,
    staged: StagedPlugin,
    now: i64,
) -> Result<PluginRow, InstallError> {
    let result = commit_claimed(app_data, plugins, &staged, now);
    if result.is_err() {
        restage(plugins, staged);
    }
    result
}

fn commit_claimed(
    app_data: &Path,
    plugins: &PluginsState,
    staged: &StagedPlugin,
    now: i64,
) -> Result<PluginRow, InstallError> {
    let (manifest, hash) = check_folder(&staged.dir, Some(&staged.id))?;
    if hash != staged.manifest_hash {
        return Err(InstallError::new(
            ErrorCode::InvalidManifest,
            "plugin.json changed since it was inspected",
        ));
    }
    let target = plugin_dir(app_data, &staged.id);
    // Where the undo parked a folder it could not move back; deleted once the lock is released.
    let parked = Cell::new(None);
    let committed = plugins.mutate(
        app_data,
        Withdraw::No,
        |registry, problems| {
            if registry.entry(&staged.id).is_some() || fs::symlink_metadata(&target).is_ok() {
                return Err(InstallError::new(
                    ErrorCode::AlreadyInstalled,
                    format!("{} is already installed", staged.id),
                ));
            }
            rename_with_retry(&staged.dir, &target)
                .map_err(|e| InstallError::io("cannot move the plugin into place", e))?;
            let (state, problem) = match &manifest.compat {
                Compat::Compatible => (EntryState::NeedsConsent, None),
                Compat::NeedsNewer(min) => (EntryState::Incompatible, Some(needs_newer(min))),
            };
            let layout = manifest
                .sidebar
                .as_ref()
                .map_or(Layout::Compact, |s| s.layout);
            let entry = Entry {
                id: staged.id.clone(),
                version: manifest.version.clone(),
                tier: manifest.tier,
                enabled: false,
                granted: Vec::new(),
                installed_at: now,
                manifest_hash: hash.clone(),
                state,
                source_path: Some(staged.source.clone()),
                sidebar_layout: Some(layout),
                sidebar_collapsed: false,
                ready_enabled: None,
            };
            match &problem {
                Some(line) => problems.insert(staged.id.clone(), line.clone()),
                None => problems.remove(&staged.id),
            };
            registry.entries.push(entry.clone());
            Ok(PluginRow { entry, problem })
        },
        |e| {
            // Back to staging, so no half-removed plugin folder is left for boot to adopt.
            if rename_with_retry(&target, &staged.dir).is_err() {
                parked.set(Some(park(app_data, &target, &staged.id)));
            }
            save_failed(e)
        },
    );
    match parked.into_inner() {
        Some(Ok(holder)) => {
            let _ = remove_tree(&holder);
        }
        Some(Err(_)) => {
            let _ = remove_tree(&target);
        }
        None => {}
    }
    committed
}

/// Removes a staged plugin and forgets its token. An unknown token is a no-op.
pub fn discard(plugins: &PluginsState, token: &str) {
    if let Some(staged) = plugins.take_staged(token) {
        let _ = fs::remove_dir_all(staged.dir);
    }
}

/// The folders and `.plistoplugin` files directly in the inbox, sorted by name. Creates the inbox.
pub fn inbox(app_data: &Path) -> Result<Vec<InboxItem>, InstallError> {
    let dir = inbox_dir(app_data);
    fs::create_dir_all(&dir).map_err(|e| InstallError::io("cannot create the inbox", e))?;
    let read = fs::read_dir(&dir).map_err(|e| InstallError::io("cannot list the inbox", e))?;
    let mut items: Vec<InboxItem> = read
        .filter_map(Result::ok)
        .filter_map(|item| {
            let name = item.file_name().into_string().ok()?;
            let meta = fs::symlink_metadata(item.path()).ok()?;
            let kind = if meta.is_dir() && !is_reparse_point(&meta) {
                InboxKind::Folder
            } else if meta.is_file()
                && Path::new(&name)
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case(PLUGIN_EXT))
            {
                InboxKind::File
            } else {
                return None;
            };
            Some(InboxItem {
                path: item.path().to_string_lossy().into_owned(),
                name,
                kind,
            })
        })
        .collect();
    items.sort_by(|a, b| a.name.cmp(&b.name));
    items.truncate(MAX_INBOX);
    Ok(items)
}

/// Removes everything under the staging folder, left by a run that ended before install or discard.
/// Never fails; a link where the folder belongs is left alone, so nothing outside it is touched.
pub fn sweep_staging(app_data: &Path) {
    let root = staging_dir(app_data);
    let Ok(meta) = fs::symlink_metadata(&root) else {
        return;
    };
    if !meta.is_dir() || is_reparse_point(&meta) {
        eprintln!("plugins: the staging folder is not a plain folder; leaving it");
        return;
    }
    let Ok(read) = fs::read_dir(&root) else {
        return;
    };
    for item in read.filter_map(Result::ok) {
        let path = item.path();
        if let Err(e) = remove_tree(&path) {
            eprintln!(
                "plugins: cannot remove leftover staging {}: {e}",
                path.display()
            );
        }
    }
}

/// Removes a folder and everything in it, or a file. A link is removed itself, never followed.
pub(super) fn remove_tree(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(m) if m.is_dir() && !is_reparse_point(&m) => fs::remove_dir_all(path),
        _ => fs::remove_file(path).or_else(|_| fs::remove_dir(path)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::paths::{plugins_dir, registry_file, state_dir, validate_id};
    use crate::plugins::registry::{self, FileRead};
    use crate::plugins::revalidate::{adopt_folders, manifest_hash};
    use crate::plugins::stage::{Temp, MAX_FULL_PATH};
    use crate::plugins::state::MAX_STAGED;
    use std::collections::HashSet;
    use std::io::{Cursor, Write};
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

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
        assert_eq!(e.sidebar_layout, Some(Layout::Compact));
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

        let row = commit(&data, &plugins, staged, 3).unwrap();
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
}
