/*
 * The per-plugin visualizer store: the build key of the installed folder, the fault marks and
 * turned-back-on records per kind, and the stills per kind and theme. It lives in
 * `plugins-vis/<id>/` beside the plugin folders, never inside the folder the key hashes.
 * Every record carries the build key it was made under; one under another key is invisible to
 * reads and removed by the next write, so a replaced build starts clean. Writes are
 * temp-then-rename under one process lock.
 */

// -- Library Imports --
use std::collections::BTreeSet;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

// -- Local Imports --
use super::install::remove_tree;
use super::paths::{plugin_dir, validate_id, vis_store_dir, vis_store_root};
use super::visualizer_decl::valid_kind_id;

pub use stills::{thumb_get, thumb_put};
use stills::prune_stills;
use trial::sweep_trials;
pub use trial::{trial_begin, trial_end};

/// The visualizer runtime api version folded into every build key.
const RUNTIME_API: u32 = 1;
/// The largest still accepted, in bytes.
pub const STILL_MAX: usize = 1 << 20;
const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
const STORE_FILE: &str = "store.json";
const STILLS_DIR: &str = "stills";
const TRIAL_PREFIX: &str = "trial.";

static LOCK: Mutex<()> = Mutex::new(());
// Set once the trial markers left by the previous process have been turned into marks.
static SWEPT: AtomicBool = AtomicBool::new(false);

fn lock() -> MutexGuard<'static, ()> {
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// A fault that switches a kind off until the user turns it back on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VisMark {
    Flashing,
    GraphicsReset,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VisTheme {
    Light,
    Dark,
}

impl VisTheme {
    fn name(self) -> &'static str {
        match self {
            VisTheme::Light => "light",
            VisTheme::Dark => "dark",
        }
    }
}

/// Everything recorded for one kind of one plugin under its current build key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct KindState {
    pub id: String,
    pub kind: String,
    pub flashing: bool,
    pub graphics_reset: bool,
    pub turned_back_on: bool,
    /// The reset trial ran its full length under this build; it is not run again.
    pub trialed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct MarkRec {
    kind: String,
    mark: VisMark,
    key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct KindRec {
    kind: String,
    key: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Store {
    // The plugin's current build key; empty until one is recorded.
    #[serde(default)]
    key: String,
    #[serde(default)]
    marks: Vec<MarkRec>,
    #[serde(default)]
    back_on: Vec<KindRec>,
    #[serde(default)]
    trialed: Vec<KindRec>,
}

impl Store {
    /// Drops every record made under another build key.
    fn prune(&mut self) {
        let key = &self.key;
        self.marks.retain(|m| m.key == *key);
        self.back_on.retain(|b| b.key == *key);
        self.trialed.retain(|t| t.key == *key);
    }

    fn is_trialed(&self, kind: &str) -> bool {
        self.trialed
            .iter()
            .any(|t| t.kind == kind && self.live(&t.key))
    }

    fn live(&self, key: &str) -> bool {
        !self.key.is_empty() && self.key == key
    }

    fn has_mark(&self, kind: &str, mark: VisMark) -> bool {
        self.marks
            .iter()
            .any(|m| m.kind == kind && m.mark == mark && self.live(&m.key))
    }

    fn is_back_on(&self, kind: &str) -> bool {
        self.back_on
            .iter()
            .any(|b| b.kind == kind && self.live(&b.key))
    }
}

/// The build key of an installed folder: blake3 over the runtime api version, then each file's
/// relative path, size and bytes in sorted path order.
pub fn build_key(dir: &Path) -> io::Result<String> {
    let mut files = Vec::new();
    collect(dir, "", &mut files)?;
    files.sort();
    let mut hasher = blake3::Hasher::new();
    hasher.update(&RUNTIME_API.to_le_bytes());
    for (rel, path) in files {
        let size = fs::metadata(&path)?.len();
        hasher.update(&(rel.len() as u64).to_le_bytes());
        hasher.update(rel.as_bytes());
        hasher.update(&size.to_le_bytes());
        hasher.update_reader(fs::File::open(&path)?)?;
    }
    Ok(hasher.finalize().to_hex().to_string())
}

fn collect(dir: &Path, prefix: &str, out: &mut Vec<(String, PathBuf)>) -> io::Result<()> {
    for item in fs::read_dir(dir)? {
        let item = item?;
        let name = item.file_name().to_string_lossy().into_owned();
        let rel = format!("{prefix}{name}");
        let kind = item.file_type()?;
        if kind.is_dir() {
            collect(&item.path(), &format!("{rel}/"), out)?;
        } else if kind.is_file() {
            out.push((rel, item.path()));
        }
    }
    Ok(())
}

fn check_id(id: &str) -> Result<(), String> {
    validate_id(id).map_err(|e| format!("invalid plugin id: {e}"))
}

fn check_ids(id: &str, kind: &str) -> Result<(), String> {
    check_id(id)?;
    if !valid_kind_id(kind) {
        return Err("invalid visualizer kind".to_string());
    }
    Ok(())
}

fn read_store(dir: &Path) -> Store {
    fs::read(dir.join(STORE_FILE))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

/// Writes `bytes` to a synced temp file beside `path`, then renames it over `path`.
fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".tmp");
    let temp = path.with_file_name(name);
    let written = fs::File::create(&temp)
        .and_then(|mut f| f.write_all(bytes).and_then(|()| f.sync_all()))
        .and_then(|()| fs::rename(&temp, path));
    if written.is_err() {
        let _ = fs::remove_file(&temp);
    }
    written
}

fn write_store(dir: &Path, store: &mut Store) -> io::Result<()> {
    store.prune();
    fs::create_dir_all(dir)?;
    let bytes = serde_json::to_vec(store).map_err(io::Error::other)?;
    write_atomic(&dir.join(STORE_FILE), &bytes)
}

/// Makes sure installed plugin `id` has a recorded build key, for a plugin installed before keys
/// were recorded. The folder is hashed outside the lock, and only when no key is stored.
fn ensure_key(app_data: &Path, id: &str) -> Result<(), String> {
    check_id(id)?;
    let dir = vis_store_dir(app_data, id);
    if !read_store(&dir).key.is_empty() {
        return Ok(());
    }
    let key = build_key(&plugin_dir(app_data, id))
        .map_err(|e| format!("plugin {id} is not installed: {e}"))?;
    let _guard = lock();
    let mut store = read_store(&dir);
    if store.key.is_empty() {
        store.key = key;
        write_store(&dir, &mut store).map_err(io_text)?;
    }
    Ok(())
}

/// The store of `id`. Run `ensure_key` first; without a key the plugin is not installed.
fn open(app_data: &Path, id: &str) -> Result<(PathBuf, Store), String> {
    let dir = vis_store_dir(app_data, id);
    let store = read_store(&dir);
    if store.key.is_empty() {
        return Err(format!("plugin {id} has no recorded build"));
    }
    Ok((dir, store))
}

fn io_text(e: io::Error) -> String {
    format!("cannot save the visualizer store: {e}")
}

/// Records the build key of the folder now installed for `id`, and drops everything made under any
/// other key, stills included. Called after an install, an update or a developer reload. When the
/// folder cannot be hashed the recorded key is cleared, so nothing of the old build survives.
pub fn record_build(app_data: &Path, id: &str) -> Result<(), String> {
    check_id(id)?;
    let hashed = build_key(&plugin_dir(app_data, id));
    let _guard = lock();
    let dir = vis_store_dir(app_data, id);
    let mut store = read_store(&dir);
    match hashed {
        Ok(key) => store.key = key,
        Err(e) => {
            if dir.is_dir() {
                store.key.clear();
                let _ = write_store(&dir, &mut store);
                prune_stills(&dir, "");
            }
            return Err(io_text(e));
        }
    }
    write_store(&dir, &mut store).map_err(io_text)?;
    prune_stills(&dir, &store.key);
    Ok(())
}

/// Removes everything stored for `id`. Album and track picks live in the database and stay.
pub fn remove(app_data: &Path, id: &str) {
    if check_id(id).is_ok() {
        let _guard = lock();
        let _ = remove_tree(&vis_store_dir(app_data, id));
    }
}

/// Every kind with a fault mark or a turned-back-on record under its plugin's current build key.
/// The first call in a process first turns trial markers left by the last process into marks.
pub fn marks(app_data: &Path) -> Vec<KindState> {
    marks_after(app_data, &SWEPT)
}

fn marks_after(app_data: &Path, swept: &AtomicBool) -> Vec<KindState> {
    let _guard = lock();
    sweep_trials(app_data, swept);
    let mut out = Vec::new();
    let Ok(plugins) = fs::read_dir(vis_store_root(app_data)) else {
        return out;
    };
    for item in plugins.flatten() {
        let id = item.file_name().to_string_lossy().into_owned();
        if check_id(&id).is_err() {
            continue;
        }
        let store = read_store(&item.path());
        let mut kinds = BTreeSet::new();
        for m in store.marks.iter().filter(|m| store.live(&m.key)) {
            kinds.insert(m.kind.as_str());
        }
        for b in store.back_on.iter().filter(|b| store.live(&b.key)) {
            kinds.insert(b.kind.as_str());
        }
        for t in store.trialed.iter().filter(|t| store.live(&t.key)) {
            kinds.insert(t.kind.as_str());
        }
        for kind in kinds {
            out.push(KindState {
                id: id.clone(),
                kind: kind.to_string(),
                flashing: store.has_mark(kind, VisMark::Flashing),
                graphics_reset: store.has_mark(kind, VisMark::GraphicsReset),
                turned_back_on: store.is_back_on(kind),
                trialed: store.is_trialed(kind),
            });
        }
    }
    out.sort_by(|a, b| (&a.id, &a.kind).cmp(&(&b.id, &b.kind)));
    out
}

/// Marks `kind` of `id` with `mark` under the current build key. A fresh mark cancels the
/// turned-back-on record, except a flashing mark on a kind turned back on, which is ignored: the
/// kind is left alone under that build. A graphics reset always applies.
pub fn set_mark(app_data: &Path, id: &str, kind: &str, mark: VisMark) -> Result<(), String> {
    check_ids(id, kind)?;
    ensure_key(app_data, id)?;
    let _guard = lock();
    let (dir, mut store) = open(app_data, id)?;
    if mark == VisMark::Flashing && store.is_back_on(kind) {
        return Ok(());
    }
    store.marks.retain(|m| !(m.kind == kind && m.mark == mark));
    store.back_on.retain(|b| b.kind != kind);
    let key = store.key.clone();
    store.marks.push(MarkRec {
        kind: kind.to_string(),
        mark,
        key,
    });
    write_store(&dir, &mut store).map_err(io_text)
}

/// Removes every fault mark on `kind` and records it as turned back on under the current build key.
pub fn clear_mark(app_data: &Path, id: &str, kind: &str) -> Result<(), String> {
    check_ids(id, kind)?;
    ensure_key(app_data, id)?;
    let _guard = lock();
    let (dir, mut store) = open(app_data, id)?;
    store.marks.retain(|m| m.kind != kind);
    store.back_on.retain(|b| b.kind != kind);
    let key = store.key.clone();
    store.back_on.push(KindRec {
        kind: kind.to_string(),
        key,
    });
    write_store(&dir, &mut store).map_err(io_text)
}

mod stills;
mod trial;

#[cfg(test)]
mod tests;
