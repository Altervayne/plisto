/*
 * The plugin system's managed state: the registry as loaded at boot, the per-plugin problems found
 * then, and the set of ids the frame host may serve. The frame host answers on a COM callback for every
 * request, so its set is a separate lock-guarded copy that never waits on the registry or the disk.
 * Boot reads the registry once and never fails: every bad file, folder or manifest ends as a marked
 * entry or an empty list, not an error. The runtime is the one switch for every plugin path: the
 * serving set stays empty unless it is running, so nothing that reads the set can serve or start a
 * plugin while it is held or safe.
 */

// -- Library Imports --
use std::collections::{HashMap, HashSet, VecDeque};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, RwLock};

use serde::Serialize;

// -- Local Imports --
use super::api::state::ApiState;
use super::install::sweep_staging;
use super::manifest::{Capability, Tier};
use super::install_error::{ErrorCode, InstallError};
use super::registry::{self, Entry, EntryState, FileRead, Registry};
use super::revalidate::{adopt_folders, demote, revalidate, Problems};
use super::session::{self, BootState};
use super::update::recover_swaps;

/// How many inspected, not yet installed plugins are kept staged; one more evicts the oldest.
pub const MAX_STAGED: usize = 8;

/// Stops a plugin's running code: before its files are touched, and when it is disabled. Called
/// without the state lock held, so it may wait on the plugin.
pub trait Stopper: Send + Sync {
    fn stop(&self, id: &str);
}

impl<F: Fn(&str) + Send + Sync> Stopper for F {
    fn stop(&self, id: &str) {
        self(id)
    }
}

/// Starts a plugin's running code once it is enabled. Called without the state lock held; it checks
/// for itself that the plugin is still serving.
pub trait Starter: Send + Sync {
    fn start(&self, plugins: &PluginsState, id: &str);
}

/// What a serving plugin was granted, copied out of its registry entry so plugin calls never wait
/// on the registry lock.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Serving {
    pub tier: Tier,
    pub version: String,
    pub granted: Vec<Capability>,
}

/// The enabled, ready plugins. Cheap to clone; every clone sees the same set.
#[derive(Clone, Default)]
pub struct EnabledSet(Arc<RwLock<HashMap<String, Serving>>>);

impl EnabledSet {
    /// Whether the id may be served. A poisoned lock answers no.
    pub fn contains(&self, id: &str) -> bool {
        self.0.read().is_ok_and(|set| set.contains_key(id))
    }

    /// The id's serving entry. A poisoned lock answers none.
    pub fn serving(&self, id: &str) -> Option<Serving> {
        self.0.read().ok()?.get(id).cloned()
    }

    /// A set serving only `id`, for handler tests.
    #[cfg(test)]
    pub(crate) fn only(id: &str, serving: Serving) -> EnabledSet {
        EnabledSet(Arc::new(RwLock::new(HashMap::from([(id.to_string(), serving)]))))
    }

    fn replace(&self, serving: HashMap<String, Serving>) {
        *self.0.write().unwrap_or_else(PoisonError::into_inner) = serving;
    }

    fn remove(&self, id: &str) {
        self.0
            .write()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(id);
    }
}

/// Whether plugins may run this session. Decided at boot; only a held runtime changes, once.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Runtime {
    /// The last run ended uncleanly with plugins serving: nothing runs until the user chooses.
    Held,
    Running,
    /// No plugin runs this session.
    Safe,
}

/// The runtime with what the previous run left behind.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct BootView {
    pub runtime: Runtime,
    pub unclean: bool,
    pub safe_flag: bool,
}

/// Keeps one plugin out of the serving set until it drops, whatever changes meanwhile. Holds on one
/// id stack; the id serves again once the last one drops and the registry still serves it.
#[must_use = "the plugin serves again as soon as the guard drops"]
pub struct Withdrawn<'a> {
    state: &'a PluginsState,
    id: String,
}

impl Drop for Withdrawn<'_> {
    fn drop(&mut self) {
        let mut inner = self.state.inner();
        if let Some(holds) = inner.withdrawn.get_mut(&self.id) {
            *holds -= 1;
            if *holds == 0 {
                inner.withdrawn.remove(&self.id);
            }
        }
        self.state.enabled.replace(inner.serving());
    }
}

/// Empties the serving set when dropped during a panic. The panic poisons the state lock, which
/// `inner()` then reads as a safe runtime; this closes the set at once instead of at the next lock.
struct EmptyOnPanic<'a>(&'a EnabledSet);

impl Drop for EmptyOnPanic<'_> {
    fn drop(&mut self) {
        if std::thread::panicking() {
            self.0.replace(HashMap::new());
        }
    }
}

/// A plugin copied into staging and inspected, waiting for install or discard. Memory only.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StagedPlugin {
    pub token: String,
    pub dir: PathBuf,
    pub id: String,
    pub manifest_hash: String,
    pub source: String,
}

struct Inner {
    registry: Registry,
    problems: Problems,
    staged: VecDeque<StagedPlugin>,
    // Ids kept out of the serving set whatever the registry says: a demotion of them could not be
    // saved. Cleared by the next saved change of that id.
    held_out: HashSet<String>,
    // Open `Withdrawn` guards per id.
    withdrawn: HashMap<String, u32>,
    runtime: Runtime,
}

impl Inner {
    /// What the frame host may serve. Every write of the serving set takes it from here.
    fn serving(&self) -> HashMap<String, Serving> {
        if self.runtime != Runtime::Running {
            return HashMap::new();
        }
        let mut serving = self.registry.serving();
        serving.retain(|id, _| !self.held_out.contains(id) && !self.withdrawn.contains_key(id));
        serving
    }
}

/// Safe mode wins; an unclean exit holds only when a plugin would serve.
fn boot_runtime(boot: BootState, registry: &Registry) -> Runtime {
    if boot.safe_mode {
        Runtime::Safe
    } else if boot.unclean && registry.entries.iter().any(Entry::is_serving) {
        Runtime::Held
    } else {
        Runtime::Running
    }
}

/// How a `PluginsState::mutate` call treats one plugin's place in the serving set.
#[derive(Clone, Copy, Debug)]
pub enum Withdraw<'a> {
    /// The serving set follows the registry.
    No,
    /// Out while the change runs, then back when the registry still serves it.
    While(&'a str),
    /// Out while the change runs, and kept out when its save fails: the change takes rights away
    /// and must hold in memory even when the disk refuses it.
    Demoting(&'a str),
}

impl<'a> Withdraw<'a> {
    fn id(self) -> Option<&'a str> {
        match self {
            Withdraw::No => None,
            Withdraw::While(id) | Withdraw::Demoting(id) => Some(id),
        }
    }
}

/// One registry entry as the frontend sees it, with the problem found at boot, if any.
#[derive(Clone, Debug, Serialize)]
pub struct PluginRow {
    #[serde(flatten)]
    pub entry: Entry,
    pub problem: Option<String>,
}

pub struct PluginsState {
    inner: Mutex<Inner>,
    enabled: EnabledSet,
    boot: BootState,
    // False when the boot read could not get at the file, so saving would overwrite contents never read.
    registry_writable: bool,
    stopper: RwLock<Arc<dyn Stopper>>,
    starter: RwLock<Option<Arc<dyn Starter>>>,
    // Bumped by every registry change kept in memory, so a caller can tell whether its call changed it.
    generation: AtomicU64,
    api: ApiState,
}

impl PluginsState {
    pub fn new(registry: Registry, problems: Problems, boot: BootState) -> PluginsState {
        let inner = Inner {
            runtime: boot_runtime(boot, &registry),
            registry,
            problems,
            staged: VecDeque::new(),
            held_out: HashSet::new(),
            withdrawn: HashMap::new(),
        };
        let enabled = EnabledSet::default();
        enabled.replace(inner.serving());
        PluginsState {
            inner: Mutex::new(inner),
            enabled,
            boot,
            registry_writable: true,
            stopper: RwLock::new(Arc::new(|_: &str| {})),
            starter: RwLock::new(None),
            generation: AtomicU64::new(0),
            api: ApiState::default(),
        }
    }

    /// No plugins and a clean boot.
    pub fn empty() -> PluginsState {
        PluginsState::new(Registry::default(), Problems::new(), BootState::default())
    }

    /// Reads the previous run's marker, loads and re-validates the registry, then stamps this run.
    /// An unreadable registry is moved aside and rebuilt with every plugin folder needing consent;
    /// a missing one is an empty registry. Leftover staging from an earlier run is removed first.
    /// Never panics and never deletes a plugin folder.
    pub fn boot(app_data: &Path, app_version: &str, pid: u32, now: i64) -> PluginsState {
        let boot = session::boot_state(app_data, app_version);
        sweep_staging(app_data);
        let (registry, problems, registry_writable) = load(app_data, now);
        if let Err(e) = session::stamp(app_data, app_version, pid) {
            eprintln!("plugins: cannot write the session marker: {e}");
        }
        PluginsState {
            registry_writable,
            ..PluginsState::new(registry, problems, boot)
        }
    }

    /// A lock poisoned by a panic ends plugins for the session: the runtime turns safe and the serving
    /// set empties, so nothing runs on state the panic may have left half changed.
    fn inner(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|poisoned| {
            let mut inner = poisoned.into_inner();
            inner.runtime = Runtime::Safe;
            self.enabled.replace(HashMap::new());
            inner
        })
    }

    /// What the previous run left behind. Whether plugins may run is `runtime`.
    pub fn boot_state(&self) -> BootState {
        self.boot
    }

    pub fn runtime(&self) -> Runtime {
        self.inner().runtime
    }

    pub fn boot_view(&self) -> BootView {
        self.view(self.runtime())
    }

    fn view(&self, runtime: Runtime) -> BootView {
        BootView {
            runtime,
            unclean: self.boot.unclean,
            safe_flag: self.boot.safe_mode,
        }
    }

    /// Answers a held runtime: `safe` keeps every plugin off for this session and writes no file;
    /// otherwise plugins run and the serving set fills. Changes nothing unless the runtime is held.
    pub fn resolve_boot(&self, safe: bool) -> BootView {
        self.resolve_held(safe).unwrap_or_else(|| self.boot_view())
    }

    /// `resolve_boot`, returning None when the runtime was not held and nothing changed.
    pub fn resolve_held(&self, safe: bool) -> Option<BootView> {
        let mut inner = self.inner();
        if inner.runtime != Runtime::Held {
            return None;
        }
        inner.runtime = if safe { Runtime::Safe } else { Runtime::Running };
        self.enabled.replace(inner.serving());
        Some(self.view(inner.runtime))
    }

    pub fn registry_writable(&self) -> bool {
        self.registry_writable
    }

    /// The handle the frame host keeps.
    pub fn enabled_set(&self) -> EnabledSet {
        self.enabled.clone()
    }

    pub fn is_enabled(&self, id: &str) -> bool {
        self.enabled.contains(id)
    }

    pub fn rows(&self) -> Vec<PluginRow> {
        let inner = self.inner();
        inner
            .registry
            .entries
            .iter()
            .map(|entry| PluginRow {
                entry: entry.clone(),
                problem: inner.problems.get(&entry.id).cloned(),
            })
            .collect()
    }

    pub fn snapshot(&self) -> Registry {
        self.inner().registry.clone()
    }

    /// Swaps in a new registry and refreshes the frame host's set under the same lock, so the two
    /// never disagree.
    pub fn replace(&self, registry: Registry, problems: Problems) {
        let mut inner = self.inner();
        inner.registry = registry;
        inner.problems = problems;
        inner.held_out.clear();
        self.enabled.replace(inner.serving());
    }

    /// Takes `id` out of the serving set until the guard drops. Taken under the lock, so no change
    /// running now or later can put it back meanwhile.
    pub fn withdraw(&self, id: &str) -> Withdrawn<'_> {
        let mut inner = self.inner();
        *inner.withdrawn.entry(id.to_string()).or_insert(0) += 1;
        self.enabled.remove(id);
        Withdrawn {
            state: self,
            id: id.to_string(),
        }
    }

    pub fn set_stopper(&self, stopper: Arc<dyn Stopper>) {
        *self.stopper.write().unwrap_or_else(PoisonError::into_inner) = stopper;
    }

    pub fn set_starter(&self, starter: Arc<dyn Starter>) {
        *self.starter.write().unwrap_or_else(PoisonError::into_inner) = Some(starter);
    }

    /// Runs the starter for `id`, if one is set. Never holds a state lock while it runs.
    pub fn start(&self, id: &str) {
        let starter = self
            .starter
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        if let Some(starter) = starter {
            starter.start(self, id);
        }
    }

    /// The plugin API's per-plugin memory.
    pub fn api(&self) -> &ApiState {
        &self.api
    }

    /// Drops the plugin's API state, then runs the stopper for `id`. Never holds a state lock while
    /// either runs.
    pub fn stop(&self, id: &str) {
        self.api.forget(id);
        let stopper = self
            .stopper
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        stopper.stop(id);
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    /// Changes the registry and saves it, all under the lock, so two changes never interleave.
    /// `change` works on a copy of the registry and the problems and may move files; when it fails,
    /// nothing is saved. When the save fails, `undo` puts the files back and memory is left as it was.
    /// A change that leaves both as they were saves nothing. `withdraw` says how one id leaves the
    /// serving set meanwhile; afterwards the set follows the registry. A `NeedsReinstall` error means
    /// the withdrawn plugin's files are in an unknown state: its entry is marked broken in memory even
    /// when that cannot be saved.
    pub fn mutate<T>(
        &self,
        app_data: &Path,
        withdraw: Withdraw<'_>,
        change: impl FnOnce(&mut Registry, &mut Problems) -> Result<T, InstallError>,
        undo: impl FnOnce(io::Error) -> InstallError,
    ) -> Result<T, InstallError> {
        let mut inner = self.inner();
        let _on_panic = EmptyOnPanic(&self.enabled);
        if let Some(id) = withdraw.id() {
            self.enabled.remove(id);
        }
        let mut registry = inner.registry.clone();
        let mut problems = inner.problems.clone();
        let result = match change(&mut registry, &mut problems) {
            Ok(value) if registry == inner.registry && problems == inner.problems => Ok(value),
            Ok(value) => match self.save(app_data, &registry) {
                Ok(()) => {
                    let before = &inner.registry;
                    let held_out = inner
                        .held_out
                        .iter()
                        .filter(|id| before.entry(id) == registry.entry(id))
                        .cloned()
                        .collect();
                    inner.held_out = held_out;
                    inner.registry = registry;
                    inner.problems = problems;
                    self.generation.fetch_add(1, Ordering::SeqCst);
                    Ok(value)
                }
                Err(e) => {
                    if let Withdraw::Demoting(id) = withdraw {
                        inner.held_out.insert(id.to_string());
                    }
                    Err(undo(e))
                }
            },
            Err(e) => Err(e),
        };
        if let (Err(e), Some(id)) = (&result, withdraw.id()) {
            if e.code == ErrorCode::NeedsReinstall {
                self.mark_broken(&mut inner, app_data, id, &e.detail);
            }
        }
        self.enabled.replace(inner.serving());
        result
    }

    fn mark_broken(&self, inner: &mut Inner, app_data: &Path, id: &str, problem: &str) {
        let Some(entry) = inner.registry.entries.iter_mut().find(|e| e.id == id) else {
            return;
        };
        demote(entry, EntryState::Broken);
        inner.problems.insert(id.to_string(), problem.to_string());
        self.generation.fetch_add(1, Ordering::SeqCst);
        if let Err(e) = self.save(app_data, &inner.registry) {
            eprintln!("plugins: cannot save the broken mark for {id}: {e}");
        }
    }

    /// Never writes over a registry the boot could not read.
    fn save(&self, app_data: &Path, registry: &Registry) -> io::Result<()> {
        if !self.registry_writable {
            return Err(io::Error::other("the registry could not be read at launch"));
        }
        registry::save(app_data, registry)
    }

    /// Records a staged plugin. Returns the oldest one when the table was full; the caller removes
    /// its folder outside the lock.
    pub fn keep_staged(&self, staged: StagedPlugin) -> Option<StagedPlugin> {
        let mut inner = self.inner();
        inner.staged.push_back(staged);
        (inner.staged.len() > MAX_STAGED)
            .then(|| inner.staged.pop_front())
            .flatten()
    }

    pub fn staged(&self, token: &str) -> Option<StagedPlugin> {
        self.inner()
            .staged
            .iter()
            .find(|s| s.token == token)
            .cloned()
    }

    pub fn take_staged(&self, token: &str) -> Option<StagedPlugin> {
        let mut inner = self.inner();
        let at = inner.staged.iter().position(|s| s.token == token)?;
        inner.staged.remove(at)
    }
}

/// Loads the registry for this run. Plugin folders the registry does not list are added as
/// needs-consent (or broken) entries. The file is rewritten only when it is safe to: never when it
/// could not be read, and never when it could not be moved aside first; the flag returned says
/// whether later saves are safe.
fn load(app_data: &Path, now: i64) -> (Registry, Problems, bool) {
    let mut may_save = true;
    let mut must_save = false;
    let mut parsed = false;
    let mut loaded = match registry::read_file(app_data) {
        FileRead::Missing => Registry::default(),
        FileRead::Parsed(loaded) => {
            parsed = true;
            loaded
        }
        FileRead::Unreadable(why) => {
            eprintln!("plugins: the registry is not usable ({why}); moving it aside");
            match registry::quarantine(app_data) {
                Ok(()) => must_save = true,
                Err(e) => {
                    eprintln!("plugins: cannot move the registry aside, leaving it ({e})");
                    may_save = false;
                }
            }
            Registry::default()
        }
        FileRead::Failed(why) => {
            eprintln!("plugins: cannot read the registry, leaving it for the next launch ({why})");
            may_save = false;
            Registry::default()
        }
    };
    let as_read = loaded.clone();
    loaded.normalize();
    // Only a registry actually read can say a plugin is gone; without one, every swap is undone.
    let registered: Option<HashSet<String>> =
        parsed.then(|| loaded.entries.iter().map(|e| e.id.clone()).collect());
    recover_swaps(app_data, registered.as_ref());
    let mut problems = revalidate(app_data, &mut loaded);
    let known: HashSet<String> = loaded.entries.iter().map(|e| e.id.clone()).collect();
    let (adopted, adopted_problems) = adopt_folders(app_data, now, &known);
    loaded.entries.extend(adopted);
    problems.extend(adopted_problems);
    loaded.normalize();
    if may_save && (must_save || loaded != as_read) {
        if let Err(e) = registry::save(app_data, &loaded) {
            eprintln!("plugins: cannot save the registry: {e}");
        }
    }
    (loaded, problems, may_save)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::manifest::Tier;
    use crate::plugins::paths::{
        plugin_dir, registry_bad_file, registry_file, safe_mode_file, state_dir,
    };
    use crate::plugins::registry::EntryState;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

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
        let unclean = d.boot();
        assert_eq!(unclean.boot_view(), view(Runtime::Safe, true, true));
        assert!(!unclean.is_enabled(ID));
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
        assert_eq!(state.resolve_boot(false), view(Runtime::Running, true, false));
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
}
