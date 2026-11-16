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
use super::api::stream::Gone;
use super::install::sweep_staging;
use super::manifest::{Capability, Tier};
use super::install_error::{ErrorCode, InstallError};
use super::lifecycle::{busy, reset_consent};
use super::registry::{self, Entry, EntryState, FileRead, Registry};
use super::revalidate::{adopt_folders, revalidate, Problems};
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

/// Runs when the runtime turns safe, with the new view, to stop whatever still runs. Never called
/// with the state lock held.
pub type SafeHook = Arc<dyn Fn(BootView) + Send + Sync>;

/// What a serving plugin was granted, copied out of its registry entry so plugin calls never wait
/// on the registry lock.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Serving {
    pub tier: Tier,
    pub version: String,
    pub granted: Vec<Capability>,
    /// The origins the user consented to; empty without a `network` grant.
    pub origins: Arc<[String]>,
    /// Whether developer loopback origins are honored.
    pub dev_mode: bool,
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

/// One plugin's lifecycle turn: while it lives, no other operation that changes the plugin's files,
/// consent or enabled state, and no start of it, may run. Taken with `try_turn`, never waited for.
#[must_use = "the turn ends as soon as the guard drops"]
pub struct Turn<'a> {
    state: &'a PluginsState,
    id: String,
}

impl Drop for Turn<'_> {
    fn drop(&mut self) {
        self.state
            .turns
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&self.id);
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
    /// The origins held for the entry, which its own serialization leaves out.
    pub granted_origins: Vec<String>,
}

impl PluginRow {
    pub fn new(entry: Entry, problem: Option<String>) -> PluginRow {
        PluginRow {
            granted_origins: entry.consented_network.clone(),
            entry,
            problem,
        }
    }
}

pub struct PluginsState {
    inner: Mutex<Inner>,
    enabled: EnabledSet,
    boot: BootState,
    // False when the boot read could not get at the file, so saving would overwrite contents never read.
    registry_writable: bool,
    stopper: RwLock<Arc<dyn Stopper>>,
    starter: RwLock<Option<Arc<dyn Starter>>>,
    on_safe: RwLock<Option<SafeHook>>,
    // Bumped by every registry change kept in memory, so a caller can tell whether its call changed it.
    generation: AtomicU64,
    api: ApiState,
    // Ids whose lifecycle turn is taken; see `Turn`.
    turns: Mutex<HashSet<String>>,
    // Runs once, in the holder's thread, right after the next turn is taken.
    #[cfg(test)]
    on_next_turn: Mutex<Option<Box<dyn FnOnce() + Send>>>,
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
        let api = ApiState::default();
        api.streams().watch_serving(enabled.clone());
        PluginsState {
            inner: Mutex::new(inner),
            enabled,
            boot,
            registry_writable: true,
            stopper: RwLock::new(Arc::new(|_: &str| {})),
            starter: RwLock::new(None),
            on_safe: RwLock::new(None),
            generation: AtomicU64::new(0),
            api,
            turns: Mutex::new(HashSet::new()),
            #[cfg(test)]
            on_next_turn: Mutex::new(None),
        }
    }

    /// Takes `id`'s lifecycle turn, or None when another operation holds it.
    pub fn try_turn(&self, id: &str) -> Option<Turn<'_>> {
        let taken = self
            .turns
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(id.to_string());
        if !taken {
            return None;
        }
        let turn = Turn {
            state: self,
            id: id.to_string(),
        };
        #[cfg(test)]
        {
            let hook = self
                .on_next_turn
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .take();
            if let Some(hook) = hook {
                hook();
            }
        }
        Some(turn)
    }

    /// Runs `hook` inside the next operation that takes a turn, right after it takes it.
    #[cfg(test)]
    pub fn on_next_turn(&self, hook: impl FnOnce() + Send + 'static) {
        *self
            .on_next_turn
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(Box::new(hook));
    }

    /// `try_turn`, refused as busy.
    pub fn turn(&self, id: &str) -> Result<Turn<'_>, InstallError> {
        self.try_turn(id).ok_or_else(|| busy(id))
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
        let state = PluginsState {
            registry_writable,
            ..PluginsState::new(registry, problems, boot)
        };
        // The flag asked for this session only, and the runtime is decided: the next launch starts
        // plugins again.
        if boot.safe_mode {
            if let Err(e) = session::set_safe_mode(app_data, false) {
                eprintln!("plugins: cannot clear the safe-mode flag: {e}");
            }
        }
        state
    }

    /// A lock poisoned by a panic ends plugins for the session: the runtime turns safe and the serving
    /// set empties, so nothing runs on state the panic may have left half changed. The safe hook runs
    /// on a thread of its own, since the caller holds the lock.
    fn inner(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|poisoned| {
            let mut inner = poisoned.into_inner();
            let turned = inner.runtime != Runtime::Safe;
            inner.runtime = Runtime::Safe;
            self.enabled.replace(HashMap::new());
            if turned {
                if let Some(hook) = self.safe_hook() {
                    let view = self.view(Runtime::Safe);
                    let spawned = std::thread::Builder::new()
                        .name("plugin-safe".into())
                        .spawn(move || hook(view));
                    if let Err(e) = spawned {
                        eprintln!("plugins: cannot stop plugins after a failure: {e}");
                    }
                }
            }
            inner
        })
    }

    fn safe_hook(&self) -> Option<SafeHook> {
        self.on_safe
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    pub fn set_on_safe(&self, hook: SafeHook) {
        *self.on_safe.write().unwrap_or_else(PoisonError::into_inner) = Some(hook);
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

    /// `resolve_boot`, returning None when the runtime was not held and nothing changed. Turning safe
    /// runs the safe hook.
    pub fn resolve_held(&self, safe: bool) -> Option<BootView> {
        let mut inner = self.inner();
        if inner.runtime != Runtime::Held {
            return None;
        }
        inner.runtime = if safe { Runtime::Safe } else { Runtime::Running };
        self.enabled.replace(inner.serving());
        let view = self.view(inner.runtime);
        drop(inner);
        if safe {
            if let Some(hook) = self.safe_hook() {
                hook(view);
            }
        }
        Some(view)
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
            .map(|entry| PluginRow::new(entry.clone(), inner.problems.get(&entry.id).cloned()))
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
        self.stop_because(id, Gone::Off);
    }

    /// `stop`, with why the plugin stops serving.
    pub fn stop_because(&self, id: &str, gone: Gone) {
        self.api.forget_because(id, gone);
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
    /// the withdrawn plugin's files are in an unknown state: its entry is marked broken, with its
    /// consent dropped, in memory even when that cannot be saved.
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
        // The files may be the new ones or the old ones; nothing consented to carries over.
        reset_consent(entry);
        entry.state = EntryState::Broken;
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
    // A native plugin's consent binds only its manifest, so new files from a cut-short swap must
    // never run under it.
    for id in recover_swaps(app_data, registered.as_ref()) {
        if let Some(entry) = loaded.entries.iter_mut().find(|e| e.id == id) {
            if entry.tier == Tier::Native {
                reset_consent(entry);
            }
        }
    }
    let mut problems = revalidate(app_data, &mut loaded);
    let known: HashSet<String> = loaded.entries.iter().map(|e| e.id.clone()).collect();
    let (adopted, adopted_problems) = adopt_folders(app_data, now, &known);
    loaded.entries.extend(adopted);
    problems.extend(adopted_problems);
    loaded.normalize();
    if may_save && (must_save || !loaded.same_file(&as_read)) {
        if let Err(e) = registry::save(app_data, &loaded) {
            eprintln!("plugins: cannot save the registry: {e}");
        }
    }
    (loaded, problems, may_save)
}

#[cfg(test)]
mod tests;
