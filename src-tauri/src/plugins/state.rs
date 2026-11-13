/*
 * The plugin system's managed state: the registry as loaded at boot, the per-plugin problems found
 * then, and the set of ids the frame host may serve. The frame host answers on a COM callback for every
 * request, so its set is a separate lock-guarded copy that never waits on the registry or the disk.
 * Boot reads the registry once and never fails: every bad file, folder or manifest ends as a marked
 * entry or an empty list, not an error.
 */

// -- Library Imports --
use std::collections::{HashSet, VecDeque};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, RwLock};

use serde::Serialize;

// -- Local Imports --
use super::install::sweep_staging;
use super::registry::{self, Entry, FileRead, Registry};
use super::revalidate::{adopt_folders, revalidate, Problems};
use super::session::{self, BootState};

/// How many inspected, not yet installed plugins are kept staged; one more evicts the oldest.
pub const MAX_STAGED: usize = 8;

/// The ids of enabled, ready plugins. Cheap to clone; every clone sees the same set.
#[derive(Clone, Default)]
pub struct EnabledSet(Arc<RwLock<HashSet<String>>>);

impl EnabledSet {
    /// Whether the id may be served. A poisoned lock answers no.
    pub fn contains(&self, id: &str) -> bool {
        self.0.read().is_ok_and(|set| set.contains(id))
    }

    fn replace(&self, ids: HashSet<String>) {
        *self.0.write().unwrap_or_else(PoisonError::into_inner) = ids;
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
}

impl PluginsState {
    pub fn new(registry: Registry, problems: Problems, boot: BootState) -> PluginsState {
        let enabled = EnabledSet::default();
        enabled.replace(registry.serving_ids());
        PluginsState {
            inner: Mutex::new(Inner {
                registry,
                problems,
                staged: VecDeque::new(),
            }),
            enabled,
            boot,
            registry_writable: true,
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

    fn inner(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn boot_state(&self) -> BootState {
        self.boot
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
        self.enabled.replace(registry.serving_ids());
        inner.registry = registry;
        inner.problems = problems;
    }

    /// Adds a newly installed, disabled entry and saves the registry, all under the lock. `place` runs
    /// first against the registry as it stands and returns the entry once its files are in place.
    /// When the save fails, `undo` runs and memory is left as it was. The serving set is unchanged.
    pub fn add_entry<E>(
        &self,
        app_data: &Path,
        place: impl FnOnce(&Registry) -> Result<(Entry, Option<String>), E>,
        undo: impl FnOnce(io::Error) -> E,
    ) -> Result<PluginRow, E> {
        let mut inner = self.inner();
        let (entry, problem) = place(&inner.registry)?;
        let mut next = inner.registry.clone();
        next.entries.push(entry.clone());
        registry::save(app_data, &next).map_err(undo)?;
        inner.registry = next;
        if let Some(problem) = &problem {
            inner.problems.insert(entry.id.clone(), problem.clone());
        }
        Ok(PluginRow { entry, problem })
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
    let mut loaded = match registry::read_file(app_data) {
        FileRead::Missing => Registry::default(),
        FileRead::Parsed(loaded) => loaded,
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
    use crate::plugins::paths::{plugin_dir, registry_bad_file, registry_file, state_dir};
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
            sidebar_layout: None,
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
                assert!(read.entries[0].sidebar_layout.is_some());
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
