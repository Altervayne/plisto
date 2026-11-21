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
use super::lifecycle::{busy, park, remove_data, save_failed};
use super::listing::{listing, Listing};
use super::manifest::{Capability, Compat, Tier};
use super::paths::{data_dir, inbox_dir, plugin_dir, staging_dir};
use super::registry::{Entry, EntryState};
use super::revalidate::{check_folder, needs_newer};
use super::stage::{fits_under, Limits, Totals};
use super::state::{PluginRow, PluginsState, StagedPlugin, Withdraw};
use super::summary::sidebar_item_count;
use super::visualizer_decl::VisualizerDecl;

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
    /// The network origins the manifest declares.
    pub origins: Vec<String>,
    /// How many sidebar items the manifest declares.
    pub sidebar_items: usize,
    /// The id is not installed but saved data under it is already there, left by an earlier plugin
    /// that claimed the same id; an install hands that data to this one.
    pub leftover_data: bool,
    /// Where Settings will list the plugin once installed.
    pub listing: Listing,
    pub visualizers: Vec<VisualizerDecl>,
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
    let leftover_data =
        installed.is_none() && fs::symlink_metadata(data_dir(app_data, &manifest.id)).is_ok();
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
    let sidebar_items = sidebar_item_count(&manifest);
    let listing = listing(&manifest);
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
        origins: manifest.network,
        sidebar_items,
        leftover_data,
        listing,
        visualizers: manifest.visualizers,
    })
}

pub(super) fn is_held(e: &io::Error) -> bool {
    e.kind() == io::ErrorKind::PermissionDenied
        || e.raw_os_error()
            .is_some_and(|code| HELD_FILE_ERRORS.contains(&code))
}

/// Renames, retrying only an error a briefly held file can cause.
pub(crate) fn rename_with_retry(from: &Path, to: &Path) -> io::Result<()> {
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
/// already installed is refused and stays staged under its token, for an update to pick up. Runs in
/// the id's lifecycle turn; while another operation holds it, the install is refused as busy and the
/// token stays staged.
pub fn install(
    app_data: &Path,
    plugins: &PluginsState,
    token: &str,
    now: i64,
) -> Result<PluginRow, InstallError> {
    install_new(app_data, plugins, token, now, false)
}

/// `install`; with `clear_data`, the saved data left under the id is deleted first, in the same turn.
/// A delete that fails refuses the install with nothing committed. An installed id is refused as
/// already installed before anything is deleted.
pub fn install_new(
    app_data: &Path,
    plugins: &PluginsState,
    token: &str,
    now: i64,
    clear_data: bool,
) -> Result<PluginRow, InstallError> {
    require_writable(plugins)?;
    let staged = claim(plugins, token)?;
    let Some(_turn) = plugins.try_turn(&staged.id) else {
        let id = staged.id.clone();
        restage(plugins, staged);
        return Err(busy(&id));
    };
    commit(app_data, plugins, staged, now, clear_data)
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
    clear_data: bool,
) -> Result<PluginRow, InstallError> {
    let result = commit_claimed(app_data, plugins, &staged, now, clear_data);
    if result.is_err() {
        restage(plugins, staged);
    }
    result
}

fn already_installed(id: &str) -> InstallError {
    InstallError::new(
        ErrorCode::AlreadyInstalled,
        format!("{id} is already installed"),
    )
}

fn commit_claimed(
    app_data: &Path,
    plugins: &PluginsState,
    staged: &StagedPlugin,
    now: i64,
    clear_data: bool,
) -> Result<PluginRow, InstallError> {
    let (manifest, hash) = check_folder(&staged.dir, Some(&staged.id))?;
    if hash != staged.manifest_hash {
        return Err(InstallError::new(
            ErrorCode::InvalidManifest,
            "plugin.json changed since it was inspected",
        ));
    }
    let target = plugin_dir(app_data, &staged.id);
    if clear_data {
        // The turn is held, so the id cannot be installed between this check and the commit.
        if plugins.snapshot().entry(&staged.id).is_some() || fs::symlink_metadata(&target).is_ok() {
            return Err(already_installed(&staged.id));
        }
        remove_data(app_data, &staged.id)?;
    }
    // Where the undo parked a folder it could not move back; deleted once the lock is released.
    let parked = Cell::new(None);
    let committed = plugins.mutate(
        app_data,
        Withdraw::No,
        |registry, problems| {
            if registry.entry(&staged.id).is_some() || fs::symlink_metadata(&target).is_ok() {
                return Err(already_installed(&staged.id));
            }
            rename_with_retry(&staged.dir, &target)
                .map_err(|e| InstallError::io("cannot move the plugin into place", e))?;
            let (state, problem) = match &manifest.compat {
                Compat::Compatible => (EntryState::NeedsConsent, None),
                Compat::NeedsNewer(min) => (EntryState::Incompatible, Some(needs_newer(min))),
            };
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
                sidebar_collapsed: false,
                ready_enabled: None,
                consented_network: Vec::new(),
            };
            match &problem {
                Some(line) => problems.insert(staged.id.clone(), line.clone()),
                None => problems.remove(&staged.id),
            };
            registry.entries.push(entry.clone());
            Ok(PluginRow::new(entry, problem))
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

/// The inbox folder, created if missing.
pub fn inbox_path(app_data: &Path) -> Result<String, InstallError> {
    let dir = inbox_dir(app_data);
    fs::create_dir_all(&dir).map_err(|e| InstallError::io("cannot create the inbox", e))?;
    Ok(dir.to_string_lossy().into_owned())
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
mod tests;
