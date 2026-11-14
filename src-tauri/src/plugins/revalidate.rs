/*
 * Checks of a plugin folder against its manifest, shared by boot and install. At boot each registry
 * entry's manifest is read and parsed again, so a folder that vanished, a manifest that no longer
 * validates, or one edited since consent shows up here instead of at first use. Nothing is ever
 * deleted: a plugin that fails a check is marked and disabled, and its folder stays where it is.
 * Nothing here panics or waits on anything but the disk.
 */

// -- Library Imports --
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::fs;
use std::io::Read;
use std::path::Path;

// -- Local Imports --
use super::frame_host::is_reparse_point;
use super::icon::{check_icon, IconError};
use super::manifest::{self, Compat, Manifest, ManifestError, Tier, MAX_MANIFEST_BYTES};
use super::paths::{plugin_dir, plugins_dir, validate_id};
use super::registry::{Entry, EntryState, Registry};

pub const MANIFEST_FILE: &str = "plugin.json";

/// One line per plugin that failed a check, keyed by id. Held in memory only; the next boot recomputes it.
pub type Problems = HashMap<String, String>;

/// Why a plugin folder failed `check_folder`. `Display` is the one line shown for a broken plugin.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckError {
    FolderMissing,
    FolderNotPlain,
    ManifestMissing,
    ManifestNotPlain,
    ManifestUnreadable(String),
    Manifest(ManifestError),
    WrongId,
    Icon(IconError),
    /// A file the manifest names is missing or not a plain file. Holds the manifest field.
    MissingFile(&'static str),
}

impl fmt::Display for CheckError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CheckError::FolderMissing => write!(f, "the plugin folder is missing"),
            CheckError::FolderNotPlain => write!(f, "the plugin folder is not a plain folder"),
            CheckError::ManifestMissing => write!(f, "plugin.json is missing"),
            CheckError::ManifestNotPlain => write!(f, "plugin.json is not a plain file"),
            CheckError::ManifestUnreadable(e) => write!(f, "plugin.json cannot be read: {e}"),
            CheckError::Manifest(e) => write!(f, "{e}"),
            CheckError::WrongId => write!(f, "plugin.json names a different id than its folder"),
            CheckError::Icon(e) => write!(f, "{e}"),
            CheckError::MissingFile(field) => {
                write!(f, "the file named by '{field}' is missing")
            }
        }
    }
}

/// The problem line for a plugin that needs a newer Plisto.
pub fn needs_newer(min: &str) -> String {
    format!("needs Plisto {min} or newer")
}

/// The hash a registry entry records for a manifest.
pub fn manifest_hash(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

/// Whether `rel` (already accepted by the manifest parser) is a plain file inside `dir`, reached
/// through plain folders only.
fn plain_file(dir: &Path, rel: &str) -> bool {
    let mut path = dir.to_path_buf();
    let mut parts = rel.split('/').peekable();
    while let Some(part) = parts.next() {
        path.push(part);
        let last = parts.peek().is_none();
        let plain = fs::symlink_metadata(&path).is_ok_and(|meta| {
            !is_reparse_point(&meta) && if last { meta.is_file() } else { meta.is_dir() }
        });
        if !plain {
            return false;
        }
    }
    true
}

/// Reads, parses and checks the manifest in `dir`: the folder and manifest are plain (never a link),
/// the manifest validates against the running Plisto, its id is `id` when one is given, its icon passes
/// the disk checks and its entry and page files exist. Returns the manifest and the hash of its bytes.
pub fn check_folder(dir: &Path, id: Option<&str>) -> Result<(Manifest, String), CheckError> {
    let meta = fs::symlink_metadata(dir).map_err(|_| CheckError::FolderMissing)?;
    if !meta.is_dir() || is_reparse_point(&meta) {
        return Err(CheckError::FolderNotPlain);
    }
    let path = dir.join(MANIFEST_FILE);
    let meta = fs::symlink_metadata(&path).map_err(|_| CheckError::ManifestMissing)?;
    if !meta.is_file() || is_reparse_point(&meta) {
        return Err(CheckError::ManifestNotPlain);
    }
    let mut bytes = Vec::new();
    fs::File::open(&path)
        .and_then(|f| {
            f.take(MAX_MANIFEST_BYTES as u64 + 1)
                .read_to_end(&mut bytes)
        })
        .map_err(|e| CheckError::ManifestUnreadable(e.to_string()))?;
    let parsed = manifest::parse(&bytes).map_err(CheckError::Manifest)?;
    if id.is_some_and(|id| parsed.id != id) {
        return Err(CheckError::WrongId);
    }
    if let Some(icon) = &parsed.icon {
        check_icon(dir, icon).map_err(CheckError::Icon)?;
    }
    if !plain_file(dir, &parsed.entry) {
        return Err(CheckError::MissingFile("entry"));
    }
    if parsed.page.as_ref().is_some_and(|page| !plain_file(dir, page)) {
        return Err(CheckError::MissingFile("page"));
    }
    Ok((parsed, manifest_hash(&bytes)))
}

/// `check_folder` on an installed plugin, with the error as its one line.
fn check(app_data: &Path, id: &str) -> Result<(Manifest, String), String> {
    check_folder(&plugin_dir(app_data, id), Some(id)).map_err(|e| e.to_string())
}

/// Checks every entry against its folder and updates its state:
///
/// - folder or manifest unusable: `Broken`, disabled
/// - manifest edited since consent (hash differs): `NeedsConsent`, disabled, grants cleared
/// - needs a newer Plisto: `Incompatible`, disabled
/// - a `Broken` or `Incompatible` entry that passes again returns to `Ready`, with the enabled flag
///   it had, only if it was `Ready` before it was demoted; any other goes to `NeedsConsent`
///
/// Ids must already be validated by `Registry::normalize`. Returns the reason for each problem.
pub fn revalidate(app_data: &Path, registry: &mut Registry) -> Problems {
    let mut problems = Problems::new();
    for entry in &mut registry.entries {
        let (parsed, hash) = match check(app_data, &entry.id) {
            Ok(found) => found,
            Err(reason) => {
                demote(entry, EntryState::Broken);
                problems.insert(entry.id.clone(), reason);
                continue;
            }
        };
        entry.tier = parsed.tier;
        entry.version = parsed.version.clone();

        let edited = !entry.manifest_hash.is_empty() && entry.manifest_hash != hash;
        entry.manifest_hash = hash;
        if edited {
            entry.state = EntryState::NeedsConsent;
            entry.enabled = false;
            entry.granted.clear();
            entry.ready_enabled = None;
            continue;
        }
        entry.granted.retain(|c| parsed.capabilities.contains(c));
        if let Compat::NeedsNewer(min) = &parsed.compat {
            demote(entry, EntryState::Incompatible);
            problems.insert(entry.id.clone(), needs_newer(min));
        } else if matches!(entry.state, EntryState::Broken | EntryState::Incompatible) {
            match entry.ready_enabled.take() {
                Some(enabled) => {
                    entry.state = EntryState::Ready;
                    entry.enabled = enabled;
                }
                None => {
                    entry.state = EntryState::NeedsConsent;
                    entry.enabled = false;
                    entry.granted.clear();
                }
            }
        }
    }
    problems
}

/// Moves an entry to `Broken` or `Incompatible`, disabled. A ready entry remembers whether it was
/// enabled, so recovery can restore exactly that and nothing a user never consented to.
pub(super) fn demote(entry: &mut Entry, to: EntryState) {
    if entry.state == EntryState::Ready {
        entry.ready_enabled = Some(entry.enabled);
    }
    entry.state = to;
    entry.enabled = false;
}

/// One entry for every plugin folder whose name is a valid id and which `known` does not list, for
/// folders the registry lost or never had. A folder with a valid manifest is needs-consent. One
/// that fails the checks is `Broken` with the reason, so it can be shown and removed; its tier and
/// version are unknown and left at placeholders. Nothing is granted or enabled, and nothing in a
/// folder is touched. Names that are not valid ids, and plain files, are ignored.
pub fn adopt_folders(app_data: &Path, now: i64, known: &HashSet<String>) -> (Vec<Entry>, Problems) {
    let Ok(read) = fs::read_dir(plugins_dir(app_data)) else {
        return (Vec::new(), Problems::new());
    };
    let mut ids: Vec<String> = read
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_ok_and(|t| !t.is_file()))
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|name| validate_id(name).is_ok() && !known.contains(name))
        .collect();
    ids.sort();
    let mut entries = Vec::new();
    let mut problems = Problems::new();
    for id in ids {
        let entry = match check(app_data, &id) {
            Ok((parsed, hash)) => {
                Entry {
                    id,
                    version: parsed.version,
                    tier: parsed.tier,
                    enabled: false,
                    granted: Vec::new(),
                    installed_at: now,
                    manifest_hash: hash,
                    state: EntryState::NeedsConsent,
                    source_path: None,
                    sidebar_collapsed: false,
                    ready_enabled: None,
                }
            }
            Err(reason) => {
                problems.insert(id.clone(), reason);
                Entry {
                    id,
                    version: String::new(),
                    tier: Tier::Ui,
                    enabled: false,
                    granted: Vec::new(),
                    installed_at: now,
                    manifest_hash: String::new(),
                    state: EntryState::Broken,
                    source_path: None,
                    sidebar_collapsed: false,
                    ready_enabled: None,
                }
            }
        };
        entries.push(entry);
    }
    (entries, problems)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::manifest::{Capability, Tier};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const ID: &str = "com.example.demo";

    struct AppData(PathBuf);

    impl AppData {
        fn new() -> AppData {
            static N: AtomicUsize = AtomicUsize::new(0);
            AppData(std::env::temp_dir().join(format!(
                "plisto-revalidate-test-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            )))
        }

        fn install(&self, id: &str, manifest: &str) {
            let dir = plugin_dir(&self.0, id);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("plugin.json"), manifest).unwrap();
            fs::write(dir.join("index.html"), "<p></p>").unwrap();
        }
    }

    impl Drop for AppData {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn manifest_json(id: &str, extra: &str) -> String {
        format!(
            r#"{{"manifest_version":1,"id":"{id}","name":"Demo","version":"1.0.0","tier":"ui",
            "entry":"index.html","capabilities":["storage"],"min_plisto":"1.0.0","author":"A"{extra}}}"#
        )
    }

    fn ready(id: &str, hash: &str) -> Entry {
        Entry {
            id: id.to_string(),
            version: "1.0.0".into(),
            tier: Tier::Ui,
            enabled: true,
            granted: vec![Capability::Storage],
            installed_at: 5,
            manifest_hash: hash.to_string(),
            state: EntryState::Ready,
            source_path: None,
            sidebar_collapsed: false,
            ready_enabled: None,
        }
    }

    fn registry(entries: Vec<Entry>) -> Registry {
        Registry {
            entries,
            ..Registry::default()
        }
    }

    fn hash_of(json: &str) -> String {
        manifest_hash(json.as_bytes())
    }

    #[test]
    fn an_unchanged_plugin_stays_ready_and_enabled() {
        let d = AppData::new();
        let json = manifest_json(ID, "");
        d.install(ID, &json);
        let mut reg = registry(vec![ready(ID, &hash_of(&json))]);
        let problems = revalidate(&d.0, &mut reg);
        assert!(problems.is_empty());
        let e = reg.entry(ID).unwrap();
        assert!(e.enabled && e.state == EntryState::Ready);
        assert_eq!(e.granted, vec![Capability::Storage]);
    }

    #[test]
    fn a_missing_folder_marks_the_entry_broken_and_creates_nothing() {
        let d = AppData::new();
        let mut reg = registry(vec![ready(ID, "x")]);
        let problems = revalidate(&d.0, &mut reg);
        let e = reg.entry(ID).unwrap();
        assert_eq!(e.state, EntryState::Broken);
        assert!(!e.enabled);
        assert!(problems[ID].contains("missing"));
        assert!(!plugins_dir(&d.0).exists());
    }

    #[test]
    fn a_manifest_that_no_longer_validates_breaks_the_entry_and_keeps_the_folder() {
        let d = AppData::new();
        let json = manifest_json(ID, "");
        d.install(ID, &json);
        let mut reg = registry(vec![ready(ID, &hash_of(&json))]);
        for bad in [
            "",
            "{",
            "not json",
            r#"{"manifest_version":1}"#,
            manifest_json(ID, r#","tier":"warp""#).as_str(),
        ] {
            fs::write(plugin_dir(&d.0, ID).join("plugin.json"), bad).unwrap();
            reg.entries[0] = ready(ID, &hash_of(&json));
            let problems = revalidate(&d.0, &mut reg);
            let e = reg.entry(ID).unwrap();
            assert_eq!(e.state, EntryState::Broken, "{bad:?}");
            assert!(!e.enabled);
            assert!(problems.contains_key(ID));
            assert!(plugin_dir(&d.0, ID).join("plugin.json").is_file());
        }
        // A manifest that names another id is broken too.
        let other = manifest_json("com.example.other", "");
        fs::write(plugin_dir(&d.0, ID).join("plugin.json"), &other).unwrap();
        reg.entries[0] = ready(ID, &hash_of(&other));
        revalidate(&d.0, &mut reg);
        assert_eq!(reg.entries[0].state, EntryState::Broken);
    }

    #[test]
    fn a_missing_entry_file_or_a_bad_icon_breaks_the_entry() {
        let d = AppData::new();
        let json = manifest_json(ID, "");
        d.install(ID, &json);
        fs::remove_file(plugin_dir(&d.0, ID).join("index.html")).unwrap();
        let mut reg = registry(vec![ready(ID, &hash_of(&json))]);
        let problems = revalidate(&d.0, &mut reg);
        assert_eq!(reg.entries[0].state, EntryState::Broken);
        assert!(problems[ID].contains("'entry'"));

        let iconic = manifest_json(ID, r#","icon":"icon.png""#);
        d.install(ID, &iconic);
        fs::write(plugin_dir(&d.0, ID).join("icon.png"), b"not a png").unwrap();
        let mut reg = registry(vec![ready(ID, &hash_of(&iconic))]);
        let problems = revalidate(&d.0, &mut reg);
        assert_eq!(reg.entries[0].state, EntryState::Broken);
        assert!(problems[ID].contains("icon"));
    }

    #[test]
    fn a_missing_page_file_breaks_the_entry_and_a_present_one_passes() {
        let d = AppData::new();
        let json = manifest_json(
            ID,
            r#","page":"ui/panel.html""#,
        )
        .replace(r#""tier":"ui""#, r#""tier":"native","native_reason":"r""#)
        .replace("index.html", "tool.exe");
        d.install(ID, &json);
        let dir = plugin_dir(&d.0, ID);
        fs::rename(dir.join("index.html"), dir.join("tool.exe")).unwrap();
        let mut reg = registry(vec![ready(ID, &hash_of(&json))]);
        let problems = revalidate(&d.0, &mut reg);
        assert_eq!(reg.entries[0].state, EntryState::Broken);
        assert!(!reg.entries[0].enabled);
        assert!(problems[ID].contains("'page'"), "{}", problems[ID]);

        fs::create_dir_all(dir.join("ui")).unwrap();
        fs::write(dir.join("ui").join("panel.html"), "<p></p>").unwrap();
        let problems = revalidate(&d.0, &mut reg);
        assert!(problems.is_empty(), "{problems:?}");
        assert_eq!(reg.entries[0].state, EntryState::Ready);
    }

    #[test]
    fn a_folder_without_a_manifest_is_broken() {
        let d = AppData::new();
        fs::create_dir_all(plugin_dir(&d.0, ID)).unwrap();
        let mut reg = registry(vec![ready(ID, "x")]);
        revalidate(&d.0, &mut reg);
        assert_eq!(reg.entries[0].state, EntryState::Broken);
        // A file where the folder belongs is not a plugin folder.
        let d2 = AppData::new();
        fs::create_dir_all(plugins_dir(&d2.0)).unwrap();
        fs::write(plugin_dir(&d2.0, ID), b"x").unwrap();
        let mut reg = registry(vec![ready(ID, "x")]);
        revalidate(&d2.0, &mut reg);
        assert_eq!(reg.entries[0].state, EntryState::Broken);
    }

    #[test]
    fn an_edited_manifest_needs_consent_again() {
        let d = AppData::new();
        let json = manifest_json(ID, "");
        let edited = json.replace("\"Demo\"", "\"Demo, edited\"");
        d.install(ID, &edited);
        let mut reg = registry(vec![ready(ID, &hash_of(&json))]);
        let problems = revalidate(&d.0, &mut reg);
        let e = reg.entry(ID).unwrap();
        assert_eq!(e.state, EntryState::NeedsConsent);
        assert!(!e.enabled && e.granted.is_empty());
        assert_eq!(e.manifest_hash, hash_of(&edited));
        assert!(problems.is_empty());
    }

    #[test]
    fn an_unrecorded_hash_is_recorded_and_the_entry_keeps_its_state() {
        let d = AppData::new();
        let json = manifest_json(ID, "");
        d.install(ID, &json);
        let mut reg = registry(vec![ready(ID, "")]);
        revalidate(&d.0, &mut reg);
        let e = reg.entry(ID).unwrap();
        assert!(e.enabled && e.state == EntryState::Ready);
        assert_eq!(e.manifest_hash, hash_of(&json));
    }

    #[test]
    fn grants_outside_the_manifest_are_dropped() {
        let d = AppData::new();
        let json = manifest_json(ID, "");
        d.install(ID, &json);
        let mut entry = ready(ID, &hash_of(&json));
        entry.granted = vec![Capability::Storage, Capability::Network];
        let mut reg = registry(vec![entry]);
        revalidate(&d.0, &mut reg);
        assert_eq!(reg.entries[0].granted, vec![Capability::Storage]);
    }

    #[test]
    fn a_ready_plugin_needing_a_newer_plisto_recovers_exactly_as_it_was() {
        let d = AppData::new();
        let json = manifest_json(ID, "").replace("\"1.0.0\",\"author\"", "\"999.0.0\",\"author\"");
        d.install(ID, &json);
        let mut reg = registry(vec![ready(ID, &hash_of(&json))]);
        let problems = revalidate(&d.0, &mut reg);
        assert_eq!(reg.entries[0].state, EntryState::Incompatible);
        assert!(!reg.entries[0].enabled);
        assert!(problems[ID].contains("999.0.0"));

        let ok = manifest_json(ID, "");
        d.install(ID, &ok);
        reg.entries[0].manifest_hash = hash_of(&ok);
        let problems = revalidate(&d.0, &mut reg);
        assert!(problems.is_empty());
        assert_eq!(reg.entries[0].state, EntryState::Ready);
        assert!(reg.entries[0].enabled, "its enabled flag comes back");
        assert_eq!(reg.entries[0].granted, vec![Capability::Storage]);
        assert_eq!(reg.entries[0].ready_enabled, None);
    }

    #[test]
    fn a_disabled_ready_plugin_recovers_disabled() {
        let d = AppData::new();
        let json = manifest_json(ID, "");
        let mut reg = registry(vec![Entry {
            enabled: false,
            ..ready(ID, &hash_of(&json))
        }]);
        revalidate(&d.0, &mut reg);
        assert_eq!(reg.entries[0].state, EntryState::Broken);
        d.install(ID, &json);
        revalidate(&d.0, &mut reg);
        assert_eq!(reg.entries[0].state, EntryState::Ready);
        assert!(!reg.entries[0].enabled);
        assert_eq!(reg.entries[0].granted, vec![Capability::Storage]);
    }

    #[test]
    fn a_needs_consent_plugin_never_recovers_to_ready() {
        let d = AppData::new();
        let json = manifest_json(ID, "").replace("\"1.0.0\",\"author\"", "\"999.0.0\",\"author\"");
        d.install(ID, &json);
        let mut entry = ready(ID, &hash_of(&json));
        entry.state = EntryState::NeedsConsent;
        entry.enabled = false;
        entry.granted.clear();
        let mut reg = registry(vec![entry]);
        revalidate(&d.0, &mut reg);
        assert_eq!(reg.entries[0].state, EntryState::Incompatible);

        let ok = manifest_json(ID, "");
        d.install(ID, &ok);
        reg.entries[0].manifest_hash = hash_of(&ok);
        revalidate(&d.0, &mut reg);
        let e = &reg.entries[0];
        assert_eq!(e.state, EntryState::NeedsConsent);
        assert!(!e.enabled && e.granted.is_empty());
    }

    #[test]
    fn a_ready_plugin_that_broke_recovers_ready_unless_its_manifest_changed() {
        let d = AppData::new();
        let json = manifest_json(ID, "");
        let mut reg = registry(vec![ready(ID, &hash_of(&json))]);
        // The folder vanishes, then comes back unchanged.
        revalidate(&d.0, &mut reg);
        assert_eq!(reg.entries[0].state, EntryState::Broken);
        assert!(!reg.entries[0].enabled);
        assert_eq!(reg.entries[0].ready_enabled, Some(true));
        // A second boot while still broken keeps what it remembers.
        revalidate(&d.0, &mut reg);
        assert_eq!(reg.entries[0].ready_enabled, Some(true));
        d.install(ID, &json);
        revalidate(&d.0, &mut reg);
        let e = &reg.entries[0];
        assert_eq!(e.state, EntryState::Ready);
        assert!(e.enabled);
        assert_eq!(e.granted, vec![Capability::Storage]);
        assert_eq!(e.ready_enabled, None);

        // Broken again, and this time it returns with a different manifest.
        fs::remove_dir_all(plugin_dir(&d.0, ID)).unwrap();
        revalidate(&d.0, &mut reg);
        assert_eq!(reg.entries[0].state, EntryState::Broken);
        d.install(ID, &json.replace("\"Demo\"", "\"Demo, edited\""));
        revalidate(&d.0, &mut reg);
        let e = &reg.entries[0];
        assert_eq!(e.state, EntryState::NeedsConsent);
        assert!(!e.enabled && e.granted.is_empty());
        assert_eq!(e.ready_enabled, None);
    }

    #[test]
    fn a_broken_plugin_with_no_ready_history_recovers_to_needs_consent() {
        let d = AppData::new();
        let json = manifest_json(ID, "");
        d.install(ID, &json);
        // A file written before the history field existed, or by hand.
        let mut entry = ready(ID, &hash_of(&json));
        entry.state = EntryState::Broken;
        entry.enabled = false;
        let mut reg = registry(vec![entry]);
        revalidate(&d.0, &mut reg);
        let e = &reg.entries[0];
        assert_eq!(e.state, EntryState::NeedsConsent);
        assert!(!e.enabled && e.granted.is_empty());
    }

    #[test]
    fn adopt_lists_unregistered_folders_and_marks_a_bad_manifest_broken() {
        let d = AppData::new();
        let json = manifest_json(ID, "");
        d.install(ID, &json);
        d.install("com.example.bad", "{ nope");
        d.install("Not.Valid", &manifest_json("not.valid", ""));
        fs::create_dir_all(plugins_dir(&d.0).join("inbox")).unwrap();
        fs::create_dir_all(plugins_dir(&d.0).join(".staging")).unwrap();
        fs::write(plugins_dir(&d.0).join("registry.json"), b"x").unwrap();

        let (entries, problems) = adopt_folders(&d.0, 99, &HashSet::new());
        let ids: Vec<_> = entries.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, ["com.example.bad", ID]);
        let bad = &entries[0];
        assert_eq!(bad.state, EntryState::Broken);
        assert!(!bad.enabled && bad.granted.is_empty());
        assert!(problems["com.example.bad"].contains("plugin.json"));
        let e = &entries[1];
        assert_eq!(e.id, ID);
        assert_eq!(e.state, EntryState::NeedsConsent);
        assert!(!e.enabled && e.granted.is_empty());
        assert_eq!(e.installed_at, 99);
        assert_eq!(e.manifest_hash, hash_of(&json));
        assert!(
            plugin_dir(&d.0, "com.example.bad").is_dir(),
            "nothing is deleted"
        );
        assert!(adopt_folders(&d.0.join("nowhere"), 0, &HashSet::new())
            .0
            .is_empty());
        // Ids the registry already lists are left to it.
        let known = HashSet::from([ID.to_string()]);
        let (entries, _) = adopt_folders(&d.0, 99, &known);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, "com.example.bad");
    }
}
