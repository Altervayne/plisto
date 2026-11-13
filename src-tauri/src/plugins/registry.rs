/*
 * The on-disk plugin registry: which plugins are installed, what the user granted each, and whether it
 * is on. It lives beside the library, never inside it. A save writes a temp file in the same folder
 * and renames it over `registry.json`, so a crash leaves the old file or the new one, never half of
 * either. A file that is not a registry is moved aside to `registry.json.bad` (never over an earlier one)
 * rather than treated as an empty registry, and the caller rebuilds every plugin as needing consent. A
 * single bad entry costs only that entry. A file that cannot be read at all is left where it is.
 */

// -- Library Imports --
use std::collections::HashSet;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Deserializer, Serialize};

// -- Local Imports --
use super::manifest::{Capability, Tier};
use super::paths::{registry_bad_file, registry_file, state_dir, validate_id};

/// The registry format written today. A file stamped higher was written by a newer Plisto and is
/// not read.
pub const REGISTRY_VERSION: u32 = 1;

/// Files above this size are unreadable rather than loaded into memory.
pub const MAX_REGISTRY_BYTES: u64 = 1024 * 1024;

const TEMP_NAME: &str = "registry.json.tmp";

/// How many quarantined files are kept: `registry.json.bad`, then `.bad.1` and so on.
const MAX_BAD_FILES: usize = 5;

// A read that fails for a reason other than "not there" is retried briefly: an antivirus scan or a
// backup tool can hold the file for a moment.
const READ_ATTEMPTS: u32 = 4;
const READ_RETRY_DELAY: Duration = Duration::from_millis(100);

/// Where a plugin stands. Only `Ready` entries can be enabled.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryState {
    /// Installed but not consented to, or its manifest changed since consent.
    NeedsConsent,
    Ready,
    /// The folder or manifest no longer validates.
    Broken,
    /// The manifest needs a newer Plisto than the one running.
    Incompatible,
}

/// One installed plugin. These field names are the file format.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    pub id: String,
    #[serde(default)]
    pub version: String,
    pub tier: Tier,
    #[serde(default)]
    pub enabled: bool,
    /// The capabilities the user granted. Names this Plisto does not know are dropped on read.
    #[serde(default, deserialize_with = "known_capabilities")]
    pub granted: Vec<Capability>,
    /// Unix seconds.
    #[serde(default)]
    pub installed_at: i64,
    /// blake3 of the `plugin.json` bytes consent was given on. Empty means not recorded yet: the
    /// next boot records the current one.
    #[serde(default)]
    pub manifest_hash: String,
    #[serde(default = "needs_consent")]
    pub state: EntryState,
    /// The folder the plugin was installed from, for the developer-mode reload.
    #[serde(default)]
    pub source_path: Option<String>,
    #[serde(default)]
    pub sidebar_collapsed: bool,
    /// Set while an entry that was ready sits as broken or incompatible: whether it was enabled, so
    /// recovery can restore it. Anything else recovers to needs-consent. Absent otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ready_enabled: Option<bool>,
}

fn needs_consent() -> EntryState {
    EntryState::NeedsConsent
}

fn current_version() -> u32 {
    REGISTRY_VERSION
}

fn known_capabilities<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<Capability>, D::Error> {
    let names = Vec::<String>::deserialize(d)?;
    Ok(names.iter().filter_map(|n| Capability::parse(n)).collect())
}

impl Entry {
    /// Restores the invariants a hand edit or an older file may break.
    fn normalize(&mut self) {
        let mut seen = HashSet::new();
        self.granted.retain(|c| seen.insert(*c));
        if self.state != EntryState::Ready {
            self.enabled = false;
        }
        if self.state == EntryState::NeedsConsent {
            self.granted.clear();
        }
        if matches!(self.state, EntryState::NeedsConsent | EntryState::Ready) {
            self.ready_enabled = None;
        }
    }

    /// Whether the frame host may serve this plugin.
    pub fn is_serving(&self) -> bool {
        self.state == EntryState::Ready && self.enabled
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Registry {
    #[serde(default = "current_version")]
    pub version: u32,
    #[serde(default)]
    pub dev_mode: bool,
    #[serde(default)]
    pub entries: Vec<Entry>,
}

impl Default for Registry {
    fn default() -> Self {
        Registry {
            version: REGISTRY_VERSION,
            dev_mode: false,
            entries: Vec::new(),
        }
    }
}

impl Registry {
    /// Drops rows whose id is not a valid id or repeats an earlier row, then restores each entry's
    /// invariants. Runs before any id is turned into a path.
    pub fn normalize(&mut self) {
        self.version = REGISTRY_VERSION;
        let mut seen = HashSet::new();
        self.entries
            .retain(|e| validate_id(&e.id).is_ok() && seen.insert(e.id.clone()));
        for entry in &mut self.entries {
            entry.normalize();
        }
    }

    pub fn entry(&self, id: &str) -> Option<&Entry> {
        self.entries.iter().find(|e| e.id == id)
    }

    /// The ids the frame host may serve.
    pub fn serving_ids(&self) -> HashSet<String> {
        self.entries
            .iter()
            .filter(|e| e.is_serving())
            .map(|e| e.id.clone())
            .collect()
    }
}

/// Why registry bytes were refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RegistryError {
    Empty,
    TooLarge,
    Malformed(String),
    UnsupportedVersion(u32),
}

impl std::fmt::Display for RegistryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RegistryError::Empty => write!(f, "the file is empty"),
            RegistryError::TooLarge => write!(f, "the file is over {MAX_REGISTRY_BYTES} bytes"),
            RegistryError::Malformed(m) => write!(f, "the file is not a valid registry: {m}"),
            RegistryError::UnsupportedVersion(v) => {
                write!(f, "the file is version {v}, newer than {REGISTRY_VERSION}")
            }
        }
    }
}

/// The registry's own fields, apart from the entries.
#[derive(Deserialize)]
struct Head {
    #[serde(default = "current_version")]
    version: u32,
    #[serde(default)]
    dev_mode: bool,
}

/// Parses registry bytes. Does not normalize. A file that is not a registry (not an object, a wrong
/// top-level type, a version this Plisto does not read) is an error. An entry that does not parse
/// is dropped on its own and the rest load.
pub fn parse(bytes: &[u8]) -> Result<Registry, RegistryError> {
    if bytes.len() as u64 > MAX_REGISTRY_BYTES {
        return Err(RegistryError::TooLarge);
    }
    // Editors on Windows often save a UTF-8 BOM, which serde_json rejects.
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Err(RegistryError::Empty);
    }
    let malformed = |e: serde_json::Error| RegistryError::Malformed(e.to_string());
    let serde_json::Value::Object(mut fields) = serde_json::from_slice(bytes).map_err(malformed)?
    else {
        return Err(RegistryError::Malformed("expected an object".into()));
    };
    let entries = fields.remove("entries");
    let head: Head =
        serde_json::from_value(serde_json::Value::Object(fields)).map_err(malformed)?;
    if head.version == 0 || head.version > REGISTRY_VERSION {
        return Err(RegistryError::UnsupportedVersion(head.version));
    }
    let entries = match entries {
        None | Some(serde_json::Value::Null) => Vec::new(),
        Some(serde_json::Value::Array(items)) => {
            let total = items.len();
            let kept: Vec<Entry> = items
                .into_iter()
                .filter_map(|item| serde_json::from_value(item).ok())
                .collect();
            if kept.len() < total {
                eprintln!(
                    "plugins: dropped {} unreadable registry entries",
                    total - kept.len()
                );
            }
            kept
        }
        Some(_) => return Err(RegistryError::Malformed("'entries' is not a list".into())),
    };
    Ok(Registry {
        version: head.version,
        dev_mode: head.dev_mode,
        entries,
    })
}

/// What reading `registry.json` found.
#[derive(Debug)]
pub enum FileRead {
    /// No file: a first run, or nothing installed yet.
    Missing,
    Parsed(Registry),
    /// The file was read and is not a registry; the text says why.
    Unreadable(String),
    /// The file could not be read, even after retries. Its contents are unknown, so it is left alone.
    Failed(String),
}

pub fn read_file(app_data: &Path) -> FileRead {
    read_file_with(app_data, READ_ATTEMPTS, READ_RETRY_DELAY)
}

fn read_file_with(app_data: &Path, attempts: u32, delay: Duration) -> FileRead {
    let mut last = String::new();
    for attempt in 0..attempts.max(1) {
        if attempt > 0 {
            thread::sleep(delay);
        }
        match read_bytes(app_data) {
            Ok(None) => return FileRead::Missing,
            Ok(Some(bytes)) => {
                return match parse(&bytes) {
                    Ok(registry) => FileRead::Parsed(registry),
                    Err(e) => FileRead::Unreadable(e.to_string()),
                }
            }
            Err(e) => last = e.to_string(),
        }
    }
    FileRead::Failed(last)
}

/// The file's bytes, or None when it does not exist.
fn read_bytes(app_data: &Path) -> io::Result<Option<Vec<u8>>> {
    let file = match fs::File::open(registry_file(app_data)) {
        Ok(file) => file,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let mut bytes = Vec::new();
    file.take(MAX_REGISTRY_BYTES + 1).read_to_end(&mut bytes)?;
    Ok(Some(bytes))
}

/// The path of the nth quarantine slot.
fn bad_slot(app_data: &Path, n: usize) -> PathBuf {
    let mut name = registry_bad_file(app_data).into_os_string();
    if n > 0 {
        name.push(format!(".{n}"));
    }
    name.into()
}

/// Moves the registry aside to the first free `registry.json.bad[.n]` slot. When every slot is taken
/// the oldest is replaced. Plugin folders are not touched.
pub fn quarantine(app_data: &Path) -> io::Result<()> {
    let slots: Vec<PathBuf> = (0..MAX_BAD_FILES).map(|n| bad_slot(app_data, n)).collect();
    let target = match slots.iter().find(|p| fs::symlink_metadata(p).is_err()) {
        Some(free) => free,
        None => slots
            .iter()
            .min_by_key(|p| fs::metadata(p).and_then(|m| m.modified()).ok())
            .unwrap_or(&slots[0]),
    };
    fs::rename(registry_file(app_data), target)
}

/// Writes the temp file and syncs it to disk.
fn write_synced(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

/// Saves the registry atomically: a temp file in the same folder (a leftover from a dead save is
/// overwritten), then a rename over the target. The temp name is fixed, so callers must hold the
/// `PluginsState` lock while saving; two concurrent saves would write the same temp file.
pub fn save(app_data: &Path, registry: &Registry) -> io::Result<()> {
    let dir = state_dir(app_data);
    fs::create_dir_all(&dir)?;
    let temp = dir.join(TEMP_NAME);
    let bytes = serde_json::to_vec_pretty(registry).map_err(io::Error::other)?;
    let saved =
        write_synced(&temp, &bytes).and_then(|()| fs::rename(&temp, registry_file(app_data)));
    if saved.is_err() {
        let _ = fs::remove_file(&temp);
    }
    saved
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::paths::plugins_dir;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A throwaway app data dir.
    struct AppData(PathBuf);

    impl AppData {
        fn new() -> AppData {
            static N: AtomicUsize = AtomicUsize::new(0);
            AppData(std::env::temp_dir().join(format!(
                "plisto-registry-test-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            )))
        }

        fn write_registry(&self, bytes: &[u8]) {
            fs::create_dir_all(state_dir(&self.0)).unwrap();
            fs::write(registry_file(&self.0), bytes).unwrap();
        }
    }

    impl Drop for AppData {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn entry(id: &str) -> Entry {
        Entry {
            id: id.to_string(),
            version: "1.0.0".into(),
            tier: Tier::Ui,
            enabled: true,
            granted: vec![Capability::Storage, Capability::UiToast],
            installed_at: 1_700_000_000,
            manifest_hash: "abc".into(),
            state: EntryState::Ready,
            source_path: Some("C:/dev/plugin".into()),
            sidebar_collapsed: true,
            ready_enabled: None,
        }
    }

    #[test]
    fn a_saved_registry_reads_back_identical() {
        let d = AppData::new();
        let registry = Registry {
            version: REGISTRY_VERSION,
            dev_mode: true,
            entries: vec![entry("com.example.one"), entry("com.example.two")],
        };
        save(&d.0, &registry).unwrap();
        match read_file(&d.0) {
            FileRead::Parsed(read) => assert_eq!(read, registry),
            other => panic!("{other:?}"),
        }
        // The names on disk are the format.
        let text = fs::read_to_string(registry_file(&d.0)).unwrap();
        for key in [
            "\"version\"",
            "\"dev_mode\"",
            "\"entries\"",
            "\"id\"",
            "\"tier\": \"ui\"",
            "\"enabled\"",
            "\"granted\"",
            "\"ui.toast\"",
            "\"installed_at\"",
            "\"manifest_hash\"",
            "\"state\": \"ready\"",
            "\"source_path\"",
            "\"sidebar_collapsed\"",
        ] {
            assert!(text.contains(key), "{key} missing from {text}");
        }
    }

    #[test]
    fn a_missing_file_is_missing_not_unreadable() {
        let d = AppData::new();
        assert!(matches!(read_file(&d.0), FileRead::Missing));
    }

    #[test]
    fn older_and_sparse_files_load_with_defaults() {
        let sparse = br#"{"entries":[{"id":"com.example.one","tier":"ui"}]}"#;
        let mut registry = parse(sparse).unwrap();
        assert_eq!(registry.version, REGISTRY_VERSION);
        assert!(!registry.dev_mode);
        let e = &registry.entries[0];
        assert_eq!(e.state, EntryState::NeedsConsent);
        assert!(!e.enabled && e.granted.is_empty());
        registry.normalize();
        // Unknown fields are ignored.
        assert!(parse(br#"{"version":1,"future":{"a":1},"entries":[]}"#).is_ok());
    }

    #[test]
    fn a_retired_sidebar_layout_key_reads_and_is_gone_after_a_save() {
        let d = AppData::new();
        d.write_registry(
            br#"{"entries":[{"id":"com.example.one","tier":"ui","sidebar_layout":"section"}]}"#,
        );
        let FileRead::Parsed(registry) = read_file(&d.0) else {
            panic!("registry did not load");
        };
        assert_eq!(registry.entries[0].id, "com.example.one");
        save(&d.0, &registry).unwrap();
        let text = fs::read_to_string(registry_file(&d.0)).unwrap();
        assert!(!text.contains("sidebar_layout"), "{text}");
    }

    #[test]
    fn unknown_capabilities_are_dropped_not_fatal() {
        let json = br#"{"entries":[{"id":"com.example.one","tier":"ui","state":"ready",
            "granted":["storage","time.travel","storage","ui.toast"]}]}"#;
        let mut registry = parse(json).unwrap();
        registry.normalize();
        assert_eq!(
            registry.entries[0].granted,
            vec![Capability::Storage, Capability::UiToast]
        );
    }

    #[test]
    fn normalize_restores_the_invariants() {
        let mut registry = Registry {
            version: 7,
            dev_mode: false,
            entries: vec![
                entry("com.example.one"),
                entry("com.example.one"),
                entry("Not A Valid Id"),
                entry("../escape"),
                Entry {
                    state: EntryState::Broken,
                    ..entry("com.example.broken")
                },
                Entry {
                    state: EntryState::NeedsConsent,
                    ..entry("com.example.fresh")
                },
                Entry {
                    granted: vec![Capability::Storage, Capability::Storage],
                    ..entry("com.example.dup")
                },
            ],
        };
        registry.normalize();
        assert_eq!(registry.version, REGISTRY_VERSION);
        let ids: Vec<_> = registry.entries.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "com.example.one",
                "com.example.broken",
                "com.example.fresh",
                "com.example.dup"
            ]
        );
        let broken = registry.entry("com.example.broken").unwrap();
        assert!(!broken.enabled && !broken.is_serving());
        let fresh = registry.entry("com.example.fresh").unwrap();
        assert!(!fresh.enabled && fresh.granted.is_empty());
        let dup = registry.entry("com.example.dup").unwrap();
        assert_eq!(dup.granted, vec![Capability::Storage]);
        let serving = registry.serving_ids();
        assert_eq!(serving.len(), 2);
        assert!(serving.contains("com.example.one") && serving.contains("com.example.dup"));
    }

    #[test]
    fn unusable_bytes_are_refused() {
        let wrong_types: [&[u8]; 10] = [
            b"",
            b"  \r\n\t ",
            b"{\"entries\": [",
            b"not json",
            b"[]",
            b"\"text\"",
            br#"{"entries":"none"}"#,
            br#"{"entries":{"id":"com.example.one"}}"#,
            br#"{"version":"one","entries":[]}"#,
            br#"{"dev_mode":"yes","entries":[]}"#,
        ];
        for bytes in wrong_types {
            assert!(
                parse(bytes).is_err(),
                "{:?}",
                String::from_utf8_lossy(bytes)
            );
        }
        assert_eq!(parse(b""), Err(RegistryError::Empty));
        assert_eq!(
            parse(br#"{"version":2,"entries":[]}"#),
            Err(RegistryError::UnsupportedVersion(2))
        );
        assert_eq!(
            parse(br#"{"version":0,"entries":[]}"#),
            Err(RegistryError::UnsupportedVersion(0))
        );
        let big = vec![b' '; MAX_REGISTRY_BYTES as usize + 1];
        assert_eq!(parse(&big), Err(RegistryError::TooLarge));
        // A BOM from a Windows editor is fine.
        let mut bom = vec![0xEF, 0xBB, 0xBF];
        bom.extend_from_slice(br#"{"entries":[]}"#);
        assert!(parse(&bom).is_ok());
    }

    #[test]
    fn one_bad_entry_costs_only_that_entry() {
        let json = br#"{"entries":[
            {"id":"com.example.one","tier":"ui","state":"ready","enabled":true},
            {"id":"com.example.badtier","tier":"warp"},
            {"id":"com.example.badstate","tier":"ui","state":"haunted"},
            {"tier":"ui"},
            {"id":7,"tier":"ui"},
            {"id":"com.example.badflag","tier":"ui","enabled":"yes"},
            "not an entry",
            null,
            {"id":"com.example.two","tier":"native"}]}"#;
        let registry = parse(json).unwrap();
        let ids: Vec<_> = registry.entries.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, ["com.example.one", "com.example.two"]);
        assert!(registry.entries[0].enabled);
    }

    #[test]
    fn an_unreadable_file_is_reported_and_quarantined_with_its_bytes() {
        let d = AppData::new();
        let garbage = b"\x00\xff{ not a registry";
        d.write_registry(garbage);
        assert!(matches!(read_file(&d.0), FileRead::Unreadable(_)));
        quarantine(&d.0).unwrap();
        assert!(!registry_file(&d.0).exists());
        assert_eq!(fs::read(registry_bad_file(&d.0)).unwrap(), garbage);
    }

    #[test]
    fn quarantine_never_overwrites_an_earlier_file_and_replaces_the_oldest_at_the_cap() {
        let d = AppData::new();
        for n in 0..MAX_BAD_FILES {
            d.write_registry(format!("bytes {n}").as_bytes());
            quarantine(&d.0).unwrap();
        }
        for n in 0..MAX_BAD_FILES {
            assert_eq!(
                fs::read(bad_slot(&d.0, n)).unwrap(),
                format!("bytes {n}").as_bytes(),
                "slot {n}"
            );
        }
        assert!(bad_slot(&d.0, 1).ends_with("registry.json.bad.1"));
        assert!(!bad_slot(&d.0, MAX_BAD_FILES).exists());

        // Every slot taken: the oldest by modified time is replaced.
        let old = std::time::SystemTime::now() - Duration::from_secs(3600);
        for n in 0..MAX_BAD_FILES {
            let at = if n == 2 {
                old
            } else {
                old + Duration::from_secs(60 * (n as u64 + 1))
            };
            fs::File::options()
                .write(true)
                .open(bad_slot(&d.0, n))
                .unwrap()
                .set_modified(at)
                .unwrap();
        }
        d.write_registry(b"newest");
        quarantine(&d.0).unwrap();
        assert_eq!(fs::read(bad_slot(&d.0, 2)).unwrap(), b"newest");
        for n in [0, 1, 3, 4] {
            assert_eq!(
                fs::read(bad_slot(&d.0, n)).unwrap(),
                format!("bytes {n}").as_bytes()
            );
        }
    }

    #[test]
    fn a_failed_quarantine_leaves_the_file_in_place() {
        let d = AppData::new();
        // No registry to move: the rename fails and nothing else changes.
        fs::create_dir_all(state_dir(&d.0)).unwrap();
        assert!(quarantine(&d.0).is_err());
        assert!(!bad_slot(&d.0, 0).exists());
    }

    #[test]
    fn a_read_error_is_retried_then_reported_as_failed_not_unreadable() {
        let d = AppData::new();
        // A directory where the file belongs cannot be read, whatever the retries.
        fs::create_dir_all(registry_file(&d.0)).unwrap();
        let started = std::time::Instant::now();
        assert!(matches!(
            read_file_with(&d.0, 3, Duration::from_millis(20)),
            FileRead::Failed(_)
        ));
        assert!(started.elapsed() >= Duration::from_millis(40), "it retried");
        // The shipped retry budget stays under half a second.
        assert!(READ_RETRY_DELAY * (READ_ATTEMPTS - 1) < Duration::from_millis(500));
        assert!(registry_file(&d.0).is_dir());
    }

    #[test]
    fn a_save_leaves_no_temp_file_and_replaces_the_old_one() {
        let d = AppData::new();
        save(&d.0, &Registry::default()).unwrap();
        let mut second = Registry::default();
        second.entries.push(entry("com.example.one"));
        save(&d.0, &second).unwrap();
        let names: Vec<_> = fs::read_dir(state_dir(&d.0))
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, ["registry.json"]);
        match read_file(&d.0) {
            FileRead::Parsed(read) => assert_eq!(read, second),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_save_that_died_before_the_rename_leaves_the_old_file_intact() {
        let d = AppData::new();
        let mut first = Registry::default();
        first.entries.push(entry("com.example.one"));
        save(&d.0, &first).unwrap();

        // The process dies after the temp file is written and before the rename.
        let temp = state_dir(&d.0).join(TEMP_NAME);
        write_synced(&temp, b"{\"entries\": [half a regis").unwrap();
        match read_file(&d.0) {
            FileRead::Parsed(read) => assert_eq!(read, first),
            other => panic!("{other:?}"),
        }

        // The next save overwrites the leftover temp file.
        let mut second = Registry::default();
        second.entries.push(entry("com.example.two"));
        save(&d.0, &second).unwrap();
        assert!(!temp.exists());
        match read_file(&d.0) {
            FileRead::Parsed(read) => assert_eq!(read, second),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_failed_rename_cleans_up_the_temp_file_and_keeps_the_old_file() {
        let d = AppData::new();
        let mut first = Registry::default();
        first.entries.push(entry("com.example.one"));
        save(&d.0, &first).unwrap();
        // A directory at the target makes the rename fail.
        fs::remove_file(registry_file(&d.0)).unwrap();
        fs::create_dir(registry_file(&d.0)).unwrap();
        assert!(save(&d.0, &first).is_err());
        assert!(!state_dir(&d.0).join(TEMP_NAME).exists());
        // A directory where the file belongs cannot be read, which is not the same as missing.
        assert!(matches!(
            read_file_with(&d.0, 1, Duration::ZERO),
            FileRead::Failed(_)
        ));
    }

    #[test]
    fn the_registry_never_lives_inside_the_plugins_folder() {
        let d = AppData::new();
        save(&d.0, &Registry::default()).unwrap();
        assert!(!plugins_dir(&d.0).exists());
    }
}
