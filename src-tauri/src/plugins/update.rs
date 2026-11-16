/*
 * Updating an installed plugin from a staged inspection. The new folder replaces the old one by two
 * renames through `plugins/<id>.old`, made and saved under the state lock with the plugin out of the
 * serving set, and undone on any failure. Consent survives only for a UI plugin whose new manifest
 * asks for exactly what the user already agreed to, from the same author; a native update always asks
 * again, since it brings new code that runs outside the sandbox. When consent goes, the reset is saved
 * before any file moves, and comes back only when the undo put the approved files back. A crash
 * mid-swap is repaired at the next boot.
 */

// -- Library Imports --
use std::cell::Cell;
use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

use serde::Serialize;

// -- Local Imports --
use super::install::{claim, is_held, remove_tree, rename_with_retry, require_writable, restage};
use super::api::stream::Gone;
use super::install_error::{ErrorCode, InstallError};
use super::lifecycle::{busy, park, remove_folder, reset_consent, save_failed};
use super::manifest::{Capability, Compat, Manifest, Tier};
use super::paths::{plugin_dir, plugins_dir, validate_id};
use super::registry::{Entry, EntryState};
use super::revalidate::{check_folder, needs_newer};
use super::state::{PluginRow, PluginsState, StagedPlugin, Withdraw};

const OLD_SUFFIX: &str = ".old";

// The undo runs under the state lock, so its one extra wait for a held file stays short.
const ROLLBACK_RETRY_DELAY: Duration = Duration::from_millis(200);

#[derive(Clone, Debug, Serialize)]
pub struct Updated {
    pub row: PluginRow,
    pub previous_version: String,
    /// The author of the replaced manifest; empty when that manifest no longer validates.
    pub previous_author: String,
}

/// Everything the review sheet presents as a permission, and who asks for it. A change to any of it
/// asks for consent again.
#[derive(PartialEq, Eq)]
struct ConsentSurface<'a> {
    author: &'a str,
    capabilities: HashSet<Capability>,
    network: HashSet<&'a str>,
    native_reason: Option<&'a str>,
}

impl<'a> ConsentSurface<'a> {
    fn of(manifest: &'a Manifest) -> ConsentSurface<'a> {
        ConsentSurface {
            author: &manifest.author,
            capabilities: manifest.capabilities.iter().copied().collect(),
            network: manifest.network.iter().map(String::as_str).collect(),
            native_reason: manifest.native_reason.as_deref(),
        }
    }
}

/// Where an update keeps the installed folder while the new one moves in.
pub(super) fn old_dir(app_data: &Path, id: &str) -> PathBuf {
    plugins_dir(app_data).join(format!("{id}{OLD_SUFFIX}"))
}

pub(super) fn not_installed(id: &str) -> InstallError {
    InstallError::new(
        ErrorCode::NotInstalled,
        format!("{id} is not installed; install it instead"),
    )
}

fn needs_reinstall() -> InstallError {
    InstallError::new(
        ErrorCode::NeedsReinstall,
        "the update could not be undone; uninstall this plugin, then install it again",
    )
}

fn check_tier(entry: &Entry, manifest: &Manifest) -> Result<(), InstallError> {
    if entry.tier == manifest.tier {
        return Ok(());
    }
    Err(InstallError::new(
        ErrorCode::TierChanged,
        "the update changes the plugin's tier; uninstall it first",
    ))
}

/// Whether a ready UI entry keeps its consent across the update: `installed` (the validated installed
/// manifest and its hash) is the one consented to, and the new one asks for exactly what was granted,
/// with the same surface. A native entry never keeps it, whatever its version or surface.
fn consent_kept(entry: &Entry, installed: Option<&(Manifest, String)>, new: &Manifest) -> bool {
    if entry.state != EntryState::Ready || entry.tier == Tier::Native {
        return false;
    }
    let Some((old, hash)) = installed else {
        return false;
    };
    let granted: HashSet<Capability> = entry.granted.iter().copied().collect();
    let surface = ConsentSurface::of(new);
    *hash == entry.manifest_hash
        && ConsentSurface::of(old) == surface
        && granted == surface.capabilities
}

/// Whether the entry is still the one the update read: a change made meanwhile is refused.
fn same_entry(entry: &Entry, seen: &Entry) -> bool {
    entry.state == seen.state
        && entry.manifest_hash == seen.manifest_hash
        && entry.granted == seen.granted
        && entry.tier == seen.tier
}

/// Saves the entry as needs-consent before any file moves, so no crash or failed undo can leave new
/// files live under the consent given to the old ones. Returns the entry as saved. A failed save
/// fails the update with nothing moved.
fn reset_before_swap(
    app_data: &Path,
    plugins: &PluginsState,
    installed: &Entry,
) -> Result<Entry, InstallError> {
    let id = installed.id.as_str();
    plugins.mutate(
        app_data,
        Withdraw::While(id),
        |registry, _| {
            let entry = registry
                .entries
                .iter_mut()
                .find(|e| e.id == id)
                .ok_or_else(|| not_installed(id))?;
            if !same_entry(entry, installed) {
                return Err(busy(id));
            }
            reset_consent(entry);
            Ok(entry.clone())
        },
        save_failed,
    )
}

/// Puts back the entry `reset_before_swap` replaced, once the approved files are known to be in
/// place again. Called only inside the update's own turn, so the reset entry is this update's.
/// Skipped when the entry changed since; a failed save leaves it needs-consent.
fn restore_consent(app_data: &Path, plugins: &PluginsState, original: &Entry, reset: &Entry) {
    let _ = plugins.mutate(
        app_data,
        Withdraw::No,
        |registry, _| {
            if let Some(entry) = registry.entries.iter_mut().find(|e| e.id == original.id) {
                if entry == reset {
                    *entry = original.clone();
                }
            }
            Ok(())
        },
        save_failed,
    );
}

/// Runs `again` only when `first` failed on a held file.
fn once_more(first: io::Result<()>, again: impl FnOnce() -> io::Result<()>) -> io::Result<()> {
    match first {
        Err(e) if is_held(&e) => again(),
        other => other,
    }
}

/// Renames with the usual retries, then once more after a short wait when a file is still held.
fn rename_patiently(from: &Path, to: &Path) -> io::Result<()> {
    once_more(rename_with_retry(from, to), || {
        thread::sleep(ROLLBACK_RETRY_DELAY);
        fs::rename(from, to)
    })
}

/// Moves the installed folder to `<id>.old` and the new one into place. Returns whether there was an
/// installed folder. A failure after the first rename puts it back.
fn swap_in(new: &Path, live: &Path, old: &Path) -> Result<bool, InstallError> {
    let had_old = fs::symlink_metadata(live).is_ok();
    if had_old {
        rename_with_retry(live, old)
            .map_err(|e| InstallError::io("cannot move the installed plugin aside", e))?;
    }
    if let Err(e) = rename_with_retry(new, live) {
        if had_old && rename_patiently(old, live).is_err() {
            return Err(needs_reinstall());
        }
        return Err(InstallError::io("cannot move the update into place", e));
    }
    Ok(had_old)
}

/// Undoes a finished swap: the new folder back to staging, the old one back into place.
fn roll_back(new: &Path, live: &Path, old: &Path, had_old: bool) -> Result<(), InstallError> {
    rename_patiently(live, new).map_err(|_| needs_reinstall())?;
    if had_old {
        rename_patiently(old, live).map_err(|_| needs_reinstall())?;
    }
    Ok(())
}

/// Replaces an installed plugin with a staged one. Refused, with the installed version untouched,
/// when the id is not installed, the tier changes, or the update needs a newer Plisto. A downgrade
/// is allowed. On failure the staged plugin stays under its token. The data folder is never touched.
pub fn update(
    app_data: &Path,
    plugins: &PluginsState,
    token: &str,
) -> Result<Updated, InstallError> {
    require_writable(plugins)?;
    let staged = claim(plugins, token)?;
    let result = update_claimed(app_data, plugins, &staged, &|| {}, &|| {});
    // The update stopped the plugin and its turn has ended, so the start can take the turn itself;
    // whatever the outcome, the plugin runs again if it is still serving.
    plugins.start(&staged.id);
    if result.is_err() {
        restage(plugins, staged);
    }
    result
}

/// Runs in the plugin's lifecycle turn, from before its stop until after the final save and any
/// restore, so no other operation or start of the id interleaves; refused as busy when the turn is
/// taken. The plugin stays out of the serving set from its stop until the folder work is done, so
/// nothing can start the old binary halfway. `after_swap` runs between the swap and the save,
/// `before_restore` before a failed update puts consent back.
fn update_claimed(
    app_data: &Path,
    plugins: &PluginsState,
    staged: &StagedPlugin,
    after_swap: &dyn Fn(),
    before_restore: &dyn Fn(),
) -> Result<Updated, InstallError> {
    let _turn = plugins.turn(&staged.id)?;
    let (manifest, hash) = check_folder(&staged.dir, Some(&staged.id))?;
    if hash != staged.manifest_hash {
        return Err(InstallError::new(
            ErrorCode::InvalidManifest,
            "plugin.json changed since it was inspected",
        ));
    }
    if let Compat::NeedsNewer(min) = &manifest.compat {
        return Err(InstallError::new(ErrorCode::Incompatible, needs_newer(min)));
    }
    let id = staged.id.as_str();
    let installed = plugins
        .snapshot()
        .entry(id)
        .cloned()
        .ok_or_else(|| not_installed(id))?;
    check_tier(&installed, &manifest)?;
    let live = plugin_dir(app_data, id);
    let old = old_dir(app_data, id);
    // Read before taking the lock; the entry is checked again under it.
    let replaced = check_folder(&live, Some(id)).ok();
    let keep = consent_kept(&installed, replaced.as_ref(), &manifest);
    let previous_author = replaced.map(|(old, _)| old.author).unwrap_or_default();
    let _withdrawn = plugins.withdraw(id);
    plugins.stop_because(id, if keep { Gone::Update } else { Gone::Consent });
    let reset = if keep {
        None
    } else {
        Some(reset_before_swap(app_data, plugins, &installed)?)
    };
    let seen = reset.as_ref().unwrap_or(&installed);

    let had_old = Cell::new(false);
    let leftover = Cell::new(None);
    let updated = plugins.mutate(
        app_data,
        Withdraw::While(id),
        |registry, problems| {
            let entry = registry
                .entries
                .iter_mut()
                .find(|e| e.id == id)
                .ok_or_else(|| not_installed(id))?;
            if !same_entry(entry, seen) {
                return Err(busy(id));
            }
            if fs::symlink_metadata(&old).is_ok() {
                // With the installed folder gone, `.old` may be the only copy; boot restores it.
                if fs::symlink_metadata(&live).is_err() {
                    return Err(InstallError::new(
                        ErrorCode::Io,
                        "an interrupted update is not repaired yet; restart Plisto",
                    ));
                }
                leftover.set(Some(park(app_data, &old, "old")?));
            }
            had_old.set(swap_in(&staged.dir, &live, &old)?);
            after_swap();
            let previous_version = std::mem::replace(&mut entry.version, manifest.version.clone());
            entry.manifest_hash = hash.clone();
            entry.source_path = Some(staged.source.clone());
            entry.ready_enabled = None;
            if keep {
                entry.bind_network(&manifest.network);
            } else {
                reset_consent(entry);
            }
            problems.remove(id);
            Ok(Updated {
                row: PluginRow::new(entry.clone(), None),
                previous_version,
                previous_author: previous_author.clone(),
            })
        },
        |e| match roll_back(&staged.dir, &live, &old, had_old.get()) {
            Ok(()) => save_failed(e),
            Err(lost) => lost,
        },
    );
    if let Some(holder) = leftover.take() {
        let _ = remove_tree(&holder);
    }
    // Any failure but a failed undo leaves the approved files in place, so their consent comes back.
    if let (Err(e), Some(reset)) = (&updated, &reset) {
        if e.code != ErrorCode::NeedsReinstall {
            before_restore();
            restore_consent(app_data, plugins, &installed, reset);
        }
    }
    // After a failed undo, `.old` may be the only copy of the plugin, so it stays.
    if updated.is_ok() && had_old.get() {
        let _ = remove_folder(app_data, &old, "old");
    }
    updated
}

/// Finishes or undoes any swap a crash interrupted. `<id>.old` goes back when `<id>` is missing and
/// the registry still lists the plugin, or when there is no registry to ask; otherwise it is
/// deleted, so an uninstalled plugin never comes back. Never fails. Returns the listed ids whose
/// `.old` sat beside an installed folder and was deleted: their swap finished but its save may not
/// have.
pub fn recover_swaps(app_data: &Path, registered: Option<&HashSet<String>>) -> Vec<String> {
    let mut interrupted = Vec::new();
    let Ok(read) = fs::read_dir(plugins_dir(app_data)) else {
        return interrupted;
    };
    for item in read.filter_map(Result::ok) {
        let Ok(name) = item.file_name().into_string() else {
            continue;
        };
        let Some(id) = name.strip_suffix(OLD_SUFFIX) else {
            continue;
        };
        if validate_id(id).is_err() {
            continue;
        }
        let live = plugin_dir(app_data, id);
        let listed = registered.is_none_or(|ids| ids.contains(id));
        let has_live = fs::symlink_metadata(&live).is_ok();
        let recovered = if listed && !has_live {
            fs::rename(item.path(), &live)
        } else {
            remove_tree(&item.path())
        };
        match recovered {
            // Only once the leftover is gone, so a `.old` that cannot be deleted is not reported again
            // at every boot.
            Ok(()) if listed && has_live => interrupted.push(id.to_string()),
            Ok(()) => {}
            Err(e) => eprintln!("plugins: cannot recover the update swap of {id}: {e}"),
        }
    }
    interrupted
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::lifecycle::{disable, enable, uninstall};
    use crate::plugins::paths::{data_dir, registry_file, staging_dir, state_dir};
    use crate::plugins::stage::Limits;
    use crate::plugins::revalidate::{adopt_folders, manifest_hash};
    use crate::plugins::test_kit::{native, ui, Kit, ID};
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    fn staging_count(k: &Kit) -> usize {
        fs::read_dir(staging_dir(&k.data)).map_or(0, |r| r.count())
    }

    /// Installed at 1.0.0 with `caps`, consented and enabled.
    fn running(caps: &[&str]) -> Kit {
        let k = Kit::new();
        k.install(&ui("1.0.0", caps));
        k.enable(caps);
        k
    }

    #[test]
    fn the_same_origin_set_carries_the_new_list_and_a_changed_set_empties_it() {
        let k = Kit::new();
        let mut first = ui("1.0.0", &["network"]);
        first["network"] = json!(["https://a.example.com", "https://b.example.com"]);
        k.install(&first);
        k.enable(&["network"]);

        let reordered = ["https://b.example.com", "https://a.example.com"];
        let mut next = ui("1.1.0", &["network"]);
        next["network"] = json!(reordered);
        let done = update(&k.data, &k.plugins, &k.inspect(&next)).unwrap();
        assert_eq!(done.row.granted_origins, reordered);
        let serving = k.plugins.enabled_set().serving(ID).unwrap();
        assert_eq!(&*serving.origins, reordered);

        let mut changed = ui("1.2.0", &["network"]);
        changed["network"] = json!(["https://c.example.com"]);
        let done = update(&k.data, &k.plugins, &k.inspect(&changed)).unwrap();
        assert_eq!(done.row.entry.state, EntryState::NeedsConsent);
        assert!(done.row.granted_origins.is_empty());
        assert!(k.plugins.enabled_set().serving(ID).is_none());
        assert!(k.plugins.snapshot().entries[0].consented_network.is_empty());
    }

    #[test]
    fn an_unchanged_surface_keeps_the_plugin_ready_and_enabled() {
        let k = running(&["storage"]);
        // The user's own choices and data.
        k.set_entry(|e| e.sidebar_collapsed = true);
        let installed_at = k.plugins.snapshot().entries[0].installed_at;
        let data = data_dir(&k.data, ID);
        fs::create_dir_all(&data).unwrap();
        fs::write(data.join("kv.json"), b"{\"a\":1}").unwrap();

        let next = ui("1.1.0", &["storage"]);
        let token = k.inspect(&next);
        let generation = k.plugins.generation();
        let done = update(&k.data, &k.plugins, &token).unwrap();
        assert_eq!(done.previous_version, "1.0.0");
        let e = &done.row.entry;
        assert_eq!(e.version, "1.1.0");
        assert_eq!(e.state, EntryState::Ready);
        assert!(e.enabled);
        assert_eq!(e.granted, vec![Capability::Storage]);
        assert_eq!(e.installed_at, installed_at);
        assert!(e.sidebar_collapsed);
        assert_eq!(e.manifest_hash, manifest_hash(next.to_string().as_bytes()));
        assert!(e.source_path.as_deref().unwrap().contains("src-"));
        assert_eq!(k.saved_entry(), *e);
        assert!(k.plugins.is_enabled(ID));
        assert_eq!(k.plugins.generation(), generation + 1);
        assert_eq!(k.stops(), [ID]);

        let on_disk = fs::read_to_string(plugin_dir(&k.data, ID).join("plugin.json")).unwrap();
        assert!(on_disk.contains("1.1.0"));
        assert!(!old_dir(&k.data, ID).exists());
        assert_eq!(staging_count(&k), 0);
        assert!(k.plugins.staged(&token).is_none());
        assert_eq!(fs::read(data.join("kv.json")).unwrap(), b"{\"a\":1}");
    }

    #[test]
    fn a_new_capability_asks_for_consent_again() {
        let k = running(&["storage"]);
        let token = k.inspect(&ui("1.1.0", &["storage", "ui.toast"]));
        let e = update(&k.data, &k.plugins, &token).unwrap().row.entry;
        assert_eq!(e.state, EntryState::NeedsConsent);
        assert!(!e.enabled && e.granted.is_empty());
        assert!(!k.plugins.is_enabled(ID));
        assert_eq!(k.saved_entry(), e);
    }

    #[test]
    fn a_dropped_capability_also_asks_again() {
        let k = running(&["storage", "ui.toast"]);
        let token = k.inspect(&ui("1.1.0", &["storage"]));
        let e = update(&k.data, &k.plugins, &token).unwrap().row.entry;
        assert_eq!(e.state, EntryState::NeedsConsent);
    }

    #[test]
    fn a_change_of_network_origins_asks_again() {
        let mut first = ui("1.0.0", &["network"]);
        first["network"] = json!(["https://a.example.com"]);
        let k = Kit::new();
        k.install(&first);
        k.enable(&["network"]);
        let mut next = first.clone();
        next["version"] = json!("1.1.0");
        next["network"] = json!(["https://a.example.com", "https://b.example.com"]);
        let token = k.inspect(&next);
        let e = update(&k.data, &k.plugins, &token).unwrap().row.entry;
        assert_eq!(e.state, EntryState::NeedsConsent);
        assert!(!k.plugins.is_enabled(ID));
    }

    #[test]
    fn a_changed_native_reason_asks_again() {
        let k = Kit::new();
        k.install(&native("1.0.0", &["audio.tap"]));
        k.enable(&["audio.tap"]);
        let mut next = native("1.1.0", &["audio.tap"]);
        next["native_reason"] = json!("A different reason.");
        let token = k.inspect(&next);
        let e = update(&k.data, &k.plugins, &token).unwrap().row.entry;
        assert_eq!(e.state, EntryState::NeedsConsent);
    }

    /// Installed native at 1.0.0 with `audio.tap`, consented and enabled.
    fn running_native() -> Kit {
        let k = Kit::new();
        k.install(&native("1.0.0", &["audio.tap"]));
        k.enable(&["audio.tap"]);
        k
    }

    /// Stages the installed native manifest, byte for byte, with a different exe beside it.
    fn same_manifest_new_exe(k: &Kit) -> String {
        let src = k.source(&native("1.0.0", &["audio.tap"]), &[("bin/tool.exe", b"MZ new")]);
        let found = k.inspect_path(&src);
        let installed = k.plugins.snapshot().entries[0].manifest_hash.clone();
        assert_eq!(k.plugins.staged(&found.token).unwrap().manifest_hash, installed);
        found.token
    }

    fn live_exe(k: &Kit) -> Vec<u8> {
        fs::read(plugin_dir(&k.data, ID).join("bin/tool.exe")).unwrap()
    }

    /// A folder where the registry's temp file goes: every save fails and the saved file stays.
    fn jam_saves(k: &Kit) {
        fs::create_dir_all(state_dir(&k.data).join("registry.json.tmp")).unwrap();
    }

    fn unjam_saves(k: &Kit) {
        fs::remove_dir(state_dir(&k.data).join("registry.json.tmp")).unwrap();
    }

    fn assert_needs_consent(plugins: &PluginsState) {
        let e = plugins.snapshot().entry(ID).unwrap().clone();
        assert_eq!(e.state, EntryState::NeedsConsent);
        assert!(!e.enabled && e.granted.is_empty() && e.ready_enabled.is_none());
        assert!(!plugins.is_enabled(ID));
        // What a boot or an update's end would start.
        assert!(plugins.snapshot().serving().is_empty());
    }

    /// Every start after the enable's found the plugin out of the serving set, so none launched.
    fn assert_nothing_started(k: &Kit) {
        let starts = k.starts();
        assert_eq!(starts[0], ID, "the enable's start");
        let refused = format!("{ID} (not serving)");
        assert!(starts[1..].iter().all(|s| *s == refused), "{starts:?}");
    }

    const NO_HOOK: &dyn Fn() = &|| {};

    #[test]
    fn a_crash_between_the_swap_and_its_save_leaves_new_native_files_needing_consent() {
        let k = running_native();
        let token = same_manifest_new_exe(&k);
        let staged = claim(&k.plugins, &token).unwrap();
        let crashed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            update_claimed(&k.data, &k.plugins, &staged, &|| panic!("crash"), NO_HOOK)
        }));
        assert!(crashed.is_err());
        assert_eq!(live_exe(&k), b"MZ new");
        assert!(old_dir(&k.data, ID).exists());
        assert_nothing_started(&k);

        let plugins = k.relaunch();
        assert!(!old_dir(&k.data, ID).exists());
        assert_eq!(live_exe(&k), b"MZ new");
        assert_needs_consent(&plugins);
    }

    #[test]
    fn boot_takes_consent_from_a_native_plugin_with_an_old_folder_beside_it() {
        let k = running_native();
        fs::create_dir_all(old_dir(&k.data, ID)).unwrap();
        let plugins = k.relaunch();
        assert!(!old_dir(&k.data, ID).exists());
        assert_needs_consent(&plugins);
        assert_nothing_started(&k);
    }

    #[cfg(windows)]
    #[test]
    fn an_old_folder_that_cannot_be_deleted_takes_no_consent_at_any_boot() {
        let k = running_native();
        let old = old_dir(&k.data, ID);
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("stuck.bin"), b"x").unwrap();
        let held = crate::plugins::test_kit::hold(&old.join("stuck.bin"));
        for _ in 0..2 {
            let plugins = k.relaunch();
            assert!(old.exists());
            assert!(plugins.is_enabled(ID));
            assert_eq!(plugins.snapshot().entry(ID).unwrap().state, EntryState::Ready);
        }
        drop(held);
    }

    #[test]
    fn a_native_update_whose_reset_cannot_be_saved_moves_nothing() {
        let k = running_native();
        let before = k.plugins.snapshot();
        let token = same_manifest_new_exe(&k);
        jam_saves(&k);
        let err = update(&k.data, &k.plugins, &token).unwrap_err();
        assert_eq!(err.code, ErrorCode::Io);
        assert_eq!(k.plugins.snapshot(), before);
        assert!(k.plugins.is_enabled(ID));
        assert_eq!(live_exe(&k), b"MZ");
        assert!(k.plugins.staged(&token).is_some());
        // The approved plugin runs again; nothing of the update was ever live.
        assert_eq!(k.starts(), [ID, ID]);
    }

    #[test]
    fn a_failed_save_with_a_clean_undo_keeps_the_reset_it_could_not_undo() {
        let k = running_native();
        let token = same_manifest_new_exe(&k);
        let staged = claim(&k.plugins, &token).unwrap();
        let err = update_claimed(&k.data, &k.plugins, &staged, &|| jam_saves(&k), NO_HOOK)
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::Io);
        assert_eq!(live_exe(&k), b"MZ");
        assert!(!old_dir(&k.data, ID).exists());
        // The restore could not be saved either, so the reset holds in memory and on disk.
        assert_needs_consent(&k.plugins);
        assert_eq!(k.saved_entry().state, EntryState::NeedsConsent);
        k.plugins.start(ID);
        assert_nothing_started(&k);
        unjam_saves(&k);
        assert_needs_consent(&k.relaunch());
    }

    #[test]
    fn a_failed_save_a_clean_undo_and_a_saved_restore_bring_back_the_approved_plugin() {
        let k = running_native();
        let before = k.plugins.snapshot();
        let token = same_manifest_new_exe(&k);
        let staged = claim(&k.plugins, &token).unwrap();
        let err = update_claimed(
            &k.data,
            &k.plugins,
            &staged,
            &|| jam_saves(&k),
            &|| unjam_saves(&k),
        )
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::Io);
        assert_eq!(k.plugins.snapshot(), before);
        assert_eq!(k.saved_entry(), before.entries[0]);
        assert_eq!(live_exe(&k), b"MZ");
        // The start `update` makes at its end runs the original exe.
        k.plugins.start(ID);
        assert_eq!(k.starts(), [ID, ID]);
        assert_eq!(live_exe(&k), b"MZ");
    }

    #[cfg(windows)]
    #[test]
    fn a_failed_save_and_undo_then_a_boot_leave_new_native_files_needing_consent() {
        let k = running_native();
        let live = plugin_dir(&k.data, ID);
        let token = same_manifest_new_exe(&k);
        let staged = claim(&k.plugins, &token).unwrap();
        let held = std::cell::RefCell::new(None);
        let fail = || {
            jam_saves(&k);
            *held.borrow_mut() = Some(crate::plugins::test_kit::hold(&live.join("bin/tool.exe")));
        };
        let err = update_claimed(&k.data, &k.plugins, &staged, &fail, NO_HOOK).unwrap_err();
        drop(held.take());
        assert_eq!(err.code, ErrorCode::NeedsReinstall);
        let e = k.plugins.snapshot().entry(ID).unwrap().clone();
        assert_eq!(e.state, EntryState::Broken);
        assert!(!e.enabled && e.granted.is_empty() && e.ready_enabled.is_none());
        assert_eq!(live_exe(&k), b"MZ new");
        k.plugins.start(ID);
        assert_nothing_started(&k);

        unjam_saves(&k);
        let plugins = k.relaunch();
        assert_eq!(live_exe(&k), b"MZ new");
        assert_needs_consent(&plugins);
    }

    #[cfg(windows)]
    #[test]
    fn a_failed_native_swap_with_a_clean_undo_restores_the_plugin_as_it_was() {
        let k = running_native();
        let before = k.plugins.snapshot();
        let token = same_manifest_new_exe(&k);
        let staged = k.plugins.staged(&token).unwrap();
        let held = crate::plugins::test_kit::hold(&staged.dir.join("index.html"));
        let err = update(&k.data, &k.plugins, &token).unwrap_err();
        drop(held);
        assert_eq!(err.code, ErrorCode::Io);
        assert_eq!(k.plugins.snapshot(), before);
        assert_eq!(k.saved_entry(), before.entries[0]);
        assert!(k.plugins.is_enabled(ID));
        assert_eq!(live_exe(&k), b"MZ");
        assert!(!old_dir(&k.data, ID).exists());
        assert_eq!(k.starts(), [ID, ID], "the original exe, as approved");
    }

    #[test]
    fn a_second_update_of_the_same_id_is_busy_while_the_first_runs() {
        let k = running_native();
        let plugins = Arc::new(k.relaunch());
        k.record(&plugins);
        let before = plugins.snapshot();
        // Two reloads of one source: the installed plugin.json byte for byte, another exe.
        let src = k.source(&native("1.0.0", &["audio.tap"]), &[("bin/tool.exe", b"MZ new")]);
        let inspect = || {
            let source = src.to_str().unwrap();
            crate::plugins::install::inspect(&k.data, &plugins, source, Limits::DEFAULT)
                .unwrap()
                .token
        };
        let a = inspect();
        let b = inspect();
        let refused = Arc::new(Mutex::new(Vec::new()));
        let weak = Arc::downgrade(&plugins);
        let (data, log, b_token) = (k.data.clone(), refused.clone(), b.clone());
        // A's stop is inside its turn: B, an uninstall, an enable and a disable all meet the turn.
        plugins.set_stopper(Arc::new(move |id: &str| {
            let p = weak.upgrade().unwrap();
            let mut log = log.lock().unwrap();
            log.push(update(&data, &p, &b_token).unwrap_err().code);
            log.push(uninstall(&data, &p, id, false).unwrap_err().code);
            log.push(enable(&data, &p, id, None, false, None).unwrap_err().code);
            log.push(disable(&data, &p, id).unwrap_err().code);
        }));
        let a_staged = claim(&plugins, &a).unwrap();
        let in_turn = |f: &dyn Fn()| {
            assert!(plugins.try_turn(ID).is_none(), "the turn is held through the swap");
            f()
        };
        let err = update_claimed(
            &k.data,
            &plugins,
            &a_staged,
            &|| in_turn(&|| jam_saves(&k)),
            &|| in_turn(&|| unjam_saves(&k)),
        )
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::Io);
        assert_eq!(*refused.lock().unwrap(), [ErrorCode::Busy; 4]);

        // A failed with a clean undo: the approved plugin is back, and none of the source's files
        // are live.
        assert_eq!(plugins.snapshot(), before);
        assert_eq!(k.saved_entry(), before.entries[0]);
        assert_eq!(live_exe(&k), b"MZ");
        assert!(!old_dir(&k.data, ID).exists());
        assert!(plugins.staged(&b).is_some(), "B waits under its token");

        // B, run after A, can only end needing consent over the source's files.
        plugins.set_stopper(Arc::new(|_: &str| {}));
        let done = update(&k.data, &plugins, &b).unwrap();
        assert_eq!(done.row.entry.state, EntryState::NeedsConsent);
        assert_eq!(live_exe(&k), b"MZ new");
        assert!(!plugins.is_enabled(ID));
        assert_eq!(k.starts().last().unwrap(), &format!("{ID} (not serving)"));
    }

    #[test]
    fn an_update_while_the_turn_is_held_is_busy_and_stops_nothing() {
        let k = running_native();
        let token = same_manifest_new_exe(&k);
        let held = k.plugins.try_turn(ID).unwrap();
        let err = update(&k.data, &k.plugins, &token).unwrap_err();
        assert_eq!(err.code, ErrorCode::Busy);
        assert!(k.stops().is_empty());
        assert!(k.plugins.is_enabled(ID));
        assert_eq!(live_exe(&k), b"MZ");
        assert!(k.plugins.staged(&token).is_some());
        drop(held);
        assert_eq!(
            update(&k.data, &k.plugins, &token).unwrap().row.entry.state,
            EntryState::NeedsConsent
        );
    }

    #[test]
    fn an_update_during_an_uninstall_is_busy() {
        let k = running_native();
        let plugins = Arc::new(k.relaunch());
        k.record(&plugins);
        let token = k.inspect_into(&plugins, &native("1.1.0", &["audio.tap"]));
        let weak = Arc::downgrade(&plugins);
        let data = k.data.clone();
        let seen = Arc::new(Mutex::new(None));
        let log = seen.clone();
        plugins.set_stopper(Arc::new(move |_: &str| {
            let p = weak.upgrade().unwrap();
            *log.lock().unwrap() = Some(update(&data, &p, &token).unwrap_err().code);
        }));
        uninstall(&k.data, &plugins, ID, false).unwrap();
        assert_eq!(*seen.lock().unwrap(), Some(ErrorCode::Busy));
        assert!(!plugin_dir(&k.data, ID).exists());
        assert!(plugins.rows().is_empty());
    }

    #[test]
    fn a_native_update_with_an_unchanged_surface_asks_again() {
        let k = running_native();
        let token = k.inspect(&native("1.1.0", &["audio.tap"]));
        let done = update(&k.data, &k.plugins, &token).unwrap();
        let e = &done.row.entry;
        assert_eq!(e.state, EntryState::NeedsConsent);
        assert!(!e.enabled && e.granted.is_empty());
        assert!(!k.plugins.is_enabled(ID));
        assert_eq!(k.saved_entry(), *e);
        assert_eq!(done.previous_author, "A");
    }

    #[test]
    fn a_native_update_with_another_author_and_exe_asks_again() {
        let k = running_native();
        let mut next = native("9.9.9", &["audio.tap"]);
        next["author"] = json!("Someone else");
        next["entry"] = json!("bin/other.exe");
        let src = k.source(&next, &[("bin/other.exe", b"MZ")]);
        let token = k.inspect_path(&src).token;
        let done = update(&k.data, &k.plugins, &token).unwrap();
        assert_eq!(done.row.entry.state, EntryState::NeedsConsent);
        assert!(!k.plugins.is_enabled(ID));
        assert!(k.plugins.enabled_set().serving(ID).is_none());
        assert_eq!(done.previous_author, "A");
        assert_eq!(k.starts(), [ID.to_string(), format!("{ID} (not serving)")]);
    }

    #[test]
    fn a_native_downgrade_or_same_version_replacement_asks_again() {
        for version in ["0.9.0", "1.0.0"] {
            let k = running_native();
            let mut next = native(version, &["audio.tap"]);
            // The same version with other bytes: the exe is not part of plugin.json.
            next["name"] = json!("Demo again");
            let token = k.inspect(&next);
            let done = update(&k.data, &k.plugins, &token).unwrap();
            assert_eq!(done.row.entry.version, version);
            assert_eq!(done.row.entry.state, EntryState::NeedsConsent, "{version}");
            assert!(!k.plugins.is_enabled(ID), "{version}");
        }
    }

    #[test]
    fn a_changed_author_asks_again_for_a_ui_update_downgrade_or_replacement() {
        for version in ["1.1.0", "0.9.0", "1.0.0"] {
            let k = running(&["storage"]);
            let mut next = ui(version, &["storage"]);
            next["author"] = json!("Someone else");
            let done = update(&k.data, &k.plugins, &k.inspect(&next)).unwrap();
            let e = &done.row.entry;
            assert_eq!(e.state, EntryState::NeedsConsent, "{version}");
            assert!(!e.enabled && e.granted.is_empty(), "{version}");
            assert!(!k.plugins.is_enabled(ID), "{version}");
            assert_eq!(done.previous_author, "A");
            assert_eq!(done.previous_version, "1.0.0");
        }
    }

    #[test]
    fn a_ui_same_version_replacement_with_an_unchanged_surface_stays_ready() {
        let k = running(&["storage"]);
        let mut next = ui("1.0.0", &["storage"]);
        next["name"] = json!("Demo again");
        let done = update(&k.data, &k.plugins, &k.inspect(&next)).unwrap();
        assert_eq!(done.row.entry.state, EntryState::Ready);
        assert!(k.plugins.is_enabled(ID));
    }

    #[test]
    fn an_installed_folder_edited_after_consent_does_not_carry_consent_over() {
        let k = running(&["storage"]);
        // Edited on disk to match the update; the recorded hash still names the reviewed one.
        let next = ui("1.1.0", &["storage"]);
        fs::write(
            plugin_dir(&k.data, ID).join("plugin.json"),
            next.to_string(),
        )
        .unwrap();
        let token = k.inspect(&next);
        let e = update(&k.data, &k.plugins, &token).unwrap().row.entry;
        assert_eq!(e.state, EntryState::NeedsConsent);
        assert!(!k.plugins.is_enabled(ID));
    }

    #[test]
    fn a_needs_consent_plugin_stays_needs_consent() {
        let k = Kit::new();
        k.install(&ui("1.0.0", &["storage"]));
        let token = k.inspect(&ui("1.1.0", &["storage"]));
        let e = update(&k.data, &k.plugins, &token).unwrap().row.entry;
        assert_eq!(e.state, EntryState::NeedsConsent);
        assert!(!e.enabled && e.granted.is_empty());
    }

    #[test]
    fn a_disabled_ready_plugin_stays_disabled_and_a_downgrade_is_allowed() {
        let k = running(&["storage"]);
        disable(&k.data, &k.plugins, ID).unwrap();
        let token = k.inspect(&ui("0.9.0", &["storage"]));
        let done = update(&k.data, &k.plugins, &token).unwrap();
        assert_eq!(done.previous_version, "1.0.0");
        assert_eq!(done.row.entry.version, "0.9.0");
        assert_eq!(done.row.entry.state, EntryState::Ready);
        assert!(!done.row.entry.enabled);
        assert!(!k.plugins.is_enabled(ID));
    }

    #[test]
    fn refusals_leave_the_installed_plugin_and_the_token_alone() {
        let k = running(&["storage"]);
        let before = k.plugins.snapshot();
        let installed = fs::read(plugin_dir(&k.data, ID).join("plugin.json")).unwrap();

        let other_tier = native("2.0.0", &["storage"]);
        let mut too_new = ui("2.0.0", &["storage"]);
        too_new["min_plisto"] = json!("999.0.0");
        let mut stranger = ui("1.0.0", &["storage"]);
        stranger["id"] = json!("com.example.stranger");
        for (manifest, code) in [
            (other_tier, ErrorCode::TierChanged),
            (too_new, ErrorCode::Incompatible),
            (stranger, ErrorCode::NotInstalled),
        ] {
            let token = k.inspect(&manifest);
            let err = update(&k.data, &k.plugins, &token).unwrap_err();
            assert_eq!(err.code, code);
            assert!(k.plugins.staged(&token).is_some(), "{code:?}");
        }
        assert_eq!(k.plugins.snapshot(), before);
        assert!(k.plugins.is_enabled(ID));
        assert_eq!(
            fs::read(plugin_dir(&k.data, ID).join("plugin.json")).unwrap(),
            installed
        );
        assert!(k.stops().is_empty(), "nothing was stopped for a refusal");
        assert_eq!(
            update(&k.data, &k.plugins, "nope").unwrap_err().code,
            ErrorCode::UnknownToken
        );
    }

    #[test]
    fn a_tampered_staged_manifest_is_refused() {
        let k = running(&["storage"]);
        let before = k.plugins.snapshot();
        let token = k.inspect(&ui("1.1.0", &["storage"]));
        let staged = k.plugins.staged(&token).unwrap();
        fs::write(
            staged.dir.join("plugin.json"),
            ui("1.1.0", &["storage", "ui.toast"]).to_string(),
        )
        .unwrap();
        let err = update(&k.data, &k.plugins, &token).unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidManifest);
        assert_eq!(k.plugins.snapshot(), before);
        assert!(k.plugins.staged(&token).is_some());
        assert!(k.stops().is_empty());
    }

    #[test]
    fn a_leftover_old_folder_is_moved_aside_and_the_update_goes_on() {
        let k = running(&["storage"]);
        let old = old_dir(&k.data, ID);
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("stale.txt"), b"x").unwrap();
        let token = k.inspect(&ui("1.1.0", &["storage"]));
        update(&k.data, &k.plugins, &token).unwrap();
        assert!(!old.exists());
        assert_eq!(staging_count(&k), 0);
        assert!(k.plugins.is_enabled(ID));
    }

    #[test]
    fn a_failed_save_rolls_the_swap_back() {
        let k = running(&["storage"]);
        let before = k.plugins.snapshot();
        let installed = fs::read(plugin_dir(&k.data, ID).join("plugin.json")).unwrap();
        let token = k.inspect(&ui("1.1.0", &["storage", "ui.toast"]));
        k.break_saves();
        let generation = k.plugins.generation();
        let err = update(&k.data, &k.plugins, &token).unwrap_err();
        assert_eq!(err.code, ErrorCode::Io);
        assert_eq!(k.plugins.snapshot(), before);
        assert_eq!(k.plugins.generation(), generation);
        assert!(k.plugins.is_enabled(ID), "back in the serving set");
        assert_eq!(
            fs::read(plugin_dir(&k.data, ID).join("plugin.json")).unwrap(),
            installed
        );
        assert!(!old_dir(&k.data, ID).exists());
        let kept = k.plugins.staged(&token).unwrap();
        assert!(kept.dir.join("plugin.json").is_file());
    }

    #[test]
    fn an_update_starts_the_stopped_plugin_again() {
        let k = running(&["storage"]);
        let token = k.inspect(&ui("1.1.0", &["storage"]));
        update(&k.data, &k.plugins, &token).unwrap();
        assert_eq!(k.stops(), [ID]);
        assert_eq!(k.starts(), [ID, ID], "after the enable, then after the update");
    }

    #[test]
    fn a_rolled_back_update_starts_the_stopped_plugin_again() {
        let k = running(&["storage"]);
        let token = k.inspect(&ui("1.1.0", &["storage"]));
        k.break_saves();
        update(&k.data, &k.plugins, &token).unwrap_err();
        assert_eq!(k.stops(), [ID]);
        assert_eq!(k.starts(), [ID, ID]);
        assert!(k.plugins.is_enabled(ID));
    }

    #[test]
    fn the_extra_retry_is_only_for_a_held_file() {
        let held = || Err(io::Error::from_raw_os_error(32));
        let mut tried = false;
        assert!(once_more(held(), || {
            tried = true;
            Ok(())
        })
        .is_ok());
        assert!(tried);
        for first in [Ok(()), Err(io::Error::from_raw_os_error(2))] {
            let mut tried = false;
            let _ = once_more(first, || {
                tried = true;
                Ok(())
            });
            assert!(!tried);
        }
        assert!(ROLLBACK_RETRY_DELAY <= Duration::from_millis(200));
    }

    #[cfg(windows)]
    #[test]
    fn a_held_file_in_the_update_rolls_the_swap_back() {
        let k = running(&["storage"]);
        let before = k.plugins.snapshot();
        let token = k.inspect(&ui("1.1.0", &["storage"]));
        let staged = k.plugins.staged(&token).unwrap();
        let held = crate::plugins::test_kit::hold(&staged.dir.join("index.html"));
        let err = update(&k.data, &k.plugins, &token).unwrap_err();
        drop(held);
        assert_eq!(err.code, ErrorCode::Io);
        assert_eq!(k.plugins.snapshot(), before);
        assert!(k.plugins.is_enabled(ID));
        let on_disk = fs::read_to_string(plugin_dir(&k.data, ID).join("plugin.json")).unwrap();
        assert!(on_disk.contains("1.0.0"));
        assert!(!old_dir(&k.data, ID).exists());
        // Once the file is free, the same token updates.
        update(&k.data, &k.plugins, &token).unwrap();
        assert!(k.plugins.is_enabled(ID));
    }

    #[cfg(windows)]
    #[test]
    fn an_undo_that_fails_marks_the_plugin_broken_and_reinstall_works() {
        let k = running(&["storage"]);
        let live = plugin_dir(&k.data, ID);
        let token = k.inspect(&ui("1.1.0", &["storage"]));
        let staged = claim(&k.plugins, &token).unwrap();
        k.break_saves();
        let held = std::cell::RefCell::new(None);
        let hold_new = || {
            *held.borrow_mut() = Some(crate::plugins::test_kit::hold(&live.join("index.html")));
        };
        let err = update_claimed(&k.data, &k.plugins, &staged, &hold_new, NO_HOOK).unwrap_err();
        drop(held.take());
        assert_eq!(err.code, ErrorCode::NeedsReinstall);
        assert!(err
            .detail
            .contains("uninstall this plugin, then install it again"));
        let rows = k.plugins.rows();
        assert_eq!(rows[0].entry.state, EntryState::Broken);
        assert_eq!(rows[0].problem.as_deref(), Some(err.detail.as_str()));
        assert!(!k.plugins.is_enabled(ID));
        assert!(old_dir(&k.data, ID).exists(), "the only copy is kept");

        k.unbreak_saves();
        uninstall(&k.data, &k.plugins, ID, false).unwrap();
        assert!(!live.exists() && !old_dir(&k.data, ID).exists());
        k.install(&ui("1.0.0", &["storage"]));
        k.enable(&["storage"]);
        assert!(k.plugins.is_enabled(ID));
    }

    #[test]
    fn the_stopper_runs_unlocked_after_the_plugin_left_the_serving_set() {
        let k = running(&["storage"]);
        let plugins = Arc::new(k.relaunch());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let weak = Arc::downgrade(&plugins);
        let log = seen.clone();
        plugins.set_stopper(Arc::new(move |id: &str| {
            let p = weak.upgrade().unwrap();
            log.lock().unwrap().push((p.is_enabled(id), p.rows().len()));
        }));
        let token = k.inspect_into(&plugins, &ui("1.1.0", &["storage"]));
        update(&k.data, &plugins, &token).unwrap();
        assert!(plugins.is_enabled(ID));
        disable(&k.data, &plugins, ID).unwrap();
        enable(&k.data, &plugins, ID, None, false, None).unwrap();
        uninstall(&k.data, &plugins, ID, false).unwrap();
        assert_eq!(*seen.lock().unwrap(), [(false, 1), (false, 1), (false, 1)]);
    }

    #[test]
    fn an_enable_between_the_stop_and_the_swap_starts_nothing() {
        let k = running(&["storage"]);
        let plugins = Arc::new(k.relaunch());
        k.record(&plugins);
        let weak = Arc::downgrade(&plugins);
        let data = k.data.clone();
        // The stop is the moment the old binary is down and the swap has not happened yet.
        plugins.set_stopper(Arc::new(move |id: &str| {
            let p = weak.upgrade().unwrap();
            let refused = enable(&data, &p, id, None, false, None).unwrap_err();
            assert_eq!(refused.code, ErrorCode::Busy);
            assert!(!p.is_enabled(id));
        }));
        let token = k.inspect_into(&plugins, &ui("1.1.0", &["storage"]));
        update(&k.data, &plugins, &token).unwrap();
        // The kit's enable, then only the update's own start, after its turn.
        assert_eq!(k.starts(), [ID, ID]);
        assert!(plugins.is_enabled(ID));
    }

    #[test]
    fn nothing_is_updated_after_a_failed_boot_read() {
        let k = Kit::new();
        k.install(&ui("1.0.0", &["storage"]));
        let registry = registry_file(&k.data);
        fs::remove_file(&registry).unwrap();
        fs::create_dir_all(&registry).unwrap();
        let plugins = k.reboot();
        assert_eq!(
            update(&k.data, &plugins, "any").unwrap_err().code,
            ErrorCode::RegistryUnavailable
        );
        assert!(registry.is_dir());
    }

    #[test]
    fn boot_puts_back_an_old_folder_whose_swap_was_cut_short() {
        let k = running(&["storage"]);
        let live = plugin_dir(&k.data, ID);
        fs::rename(&live, old_dir(&k.data, ID)).unwrap();
        let plugins = k.relaunch();
        assert!(live.join("plugin.json").is_file());
        assert!(!old_dir(&k.data, ID).exists());
        assert!(plugins.is_enabled(ID));
    }

    #[test]
    fn boot_deletes_an_old_folder_left_beside_the_new_one() {
        let k = running(&["storage"]);
        let old = old_dir(&k.data, ID);
        fs::create_dir_all(old.join("ui")).unwrap();
        fs::write(old.join("plugin.json"), b"{}").unwrap();
        let plugins = k.relaunch();
        assert!(!old.exists());
        assert!(plugin_dir(&k.data, ID).join("plugin.json").is_file());
        assert!(plugins.is_enabled(ID));
    }

    #[test]
    fn boot_deletes_the_old_folder_of_a_plugin_the_registry_no_longer_lists() {
        let k = running(&["storage"]);
        let live = plugin_dir(&k.data, ID);
        let aside = k.data.join("aside");
        fs::rename(&live, &aside).unwrap();
        uninstall(&k.data, &k.plugins, ID, false).unwrap();
        fs::rename(&aside, old_dir(&k.data, ID)).unwrap();
        let plugins = k.reboot();
        assert!(!old_dir(&k.data, ID).exists());
        assert!(!live.exists());
        assert!(plugins.rows().is_empty());
    }

    #[test]
    fn without_a_readable_registry_boot_puts_an_old_folder_back() {
        let k = running(&["storage"]);
        let live = plugin_dir(&k.data, ID);
        fs::rename(&live, old_dir(&k.data, ID)).unwrap();
        fs::write(registry_file(&k.data), b"not a registry").unwrap();
        let plugins = k.reboot();
        assert!(live.join("plugin.json").is_file());
        assert!(!old_dir(&k.data, ID).exists());
        assert_eq!(plugins.rows()[0].entry.state, EntryState::NeedsConsent);
    }

    #[test]
    fn swap_folders_are_never_adopted() {
        let k = Kit::new();
        for name in [format!("{ID}.old"), format!("{ID}.new")] {
            assert!(validate_id(&name).is_err(), "{name}");
            let dir = plugins_dir(&k.data).join(&name);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("plugin.json"), ui("1.0.0", &[]).to_string()).unwrap();
        }
        let (adopted, _) = adopt_folders(&k.data, 0, &HashSet::new());
        assert!(adopted.is_empty());
    }
}
