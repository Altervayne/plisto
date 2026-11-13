/*
 * Updating an installed plugin from a staged inspection. The new folder replaces the old one by two
 * renames through `plugins/<id>.old`, made and saved under the state lock with the plugin out of the
 * serving set, and undone on any failure. Consent survives only when the new manifest asks for exactly
 * what the user already agreed to. A crash mid-swap is repaired at the next boot.
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
use super::install_error::{ErrorCode, InstallError};
use super::lifecycle::{busy, park, remove_folder, reset_consent, save_failed};
use super::manifest::{Capability, Compat, Manifest};
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
}

/// Everything the review sheet presents as a permission. A change to any of it asks for consent again.
#[derive(PartialEq, Eq)]
struct ConsentSurface<'a> {
    capabilities: HashSet<Capability>,
    network: HashSet<&'a str>,
    native_reason: Option<&'a str>,
}

impl<'a> ConsentSurface<'a> {
    fn of(manifest: &'a Manifest) -> ConsentSurface<'a> {
        ConsentSurface {
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

fn not_installed(id: &str) -> InstallError {
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

/// Whether a ready entry keeps its consent across the update: the installed manifest is the one
/// consented to, and the new one asks for exactly what was granted, with the same surface.
fn consent_kept(entry: &Entry, live: &Path, new: &Manifest) -> bool {
    if entry.state != EntryState::Ready {
        return false;
    }
    let Ok((old, hash)) = check_folder(live, Some(&entry.id)) else {
        return false;
    };
    let granted: HashSet<Capability> = entry.granted.iter().copied().collect();
    let surface = ConsentSurface::of(new);
    hash == entry.manifest_hash
        && ConsentSurface::of(&old) == surface
        && granted == surface.capabilities
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
    let result = update_claimed(app_data, plugins, &staged, &|| {});
    if result.is_err() {
        restage(plugins, staged);
    }
    result
}

/// `after_swap` runs between the swap and the save.
fn update_claimed(
    app_data: &Path,
    plugins: &PluginsState,
    staged: &StagedPlugin,
    after_swap: &dyn Fn(),
) -> Result<Updated, InstallError> {
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
    let keep = consent_kept(&installed, &live, &manifest);
    plugins.withdraw(id);
    plugins.stop(id);

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
            let same = entry.state == installed.state
                && entry.manifest_hash == installed.manifest_hash
                && entry.granted == installed.granted
                && entry.tier == installed.tier;
            if !same {
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
            if !keep {
                reset_consent(entry);
            }
            problems.remove(id);
            Ok(Updated {
                row: PluginRow {
                    entry: entry.clone(),
                    problem: None,
                },
                previous_version,
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
    // After a failed undo, `.old` may be the only copy of the plugin, so it stays.
    if updated.is_ok() && had_old.get() {
        let _ = remove_folder(app_data, &old, "old");
    }
    updated
}

/// Finishes or undoes any swap a crash interrupted. `<id>.old` goes back when `<id>` is missing and
/// the registry still lists the plugin, or when there is no registry to ask; otherwise it is
/// deleted, so an uninstalled plugin never comes back. Never fails.
pub fn recover_swaps(app_data: &Path, registered: Option<&HashSet<String>>) {
    let Ok(read) = fs::read_dir(plugins_dir(app_data)) else {
        return;
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
        let recovered = if listed && fs::symlink_metadata(&live).is_err() {
            fs::rename(item.path(), &live)
        } else {
            remove_tree(&item.path())
        };
        if let Err(e) = recovered {
            eprintln!("plugins: cannot recover the update swap of {id}: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::lifecycle::{disable, enable, uninstall};
    use crate::plugins::paths::{data_dir, registry_file, staging_dir};
    use crate::plugins::revalidate::{adopt_folders, manifest_hash};
    use crate::plugins::sidebar_decl::Layout;
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
    fn an_unchanged_surface_keeps_the_plugin_ready_and_enabled() {
        let k = running(&["storage"]);
        // The user's own choices and data.
        k.set_entry(|e| {
            e.sidebar_layout = Some(Layout::Section);
            e.sidebar_collapsed = true;
        });
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
        assert_eq!(e.sidebar_layout, Some(Layout::Section));
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
        let err = update_claimed(&k.data, &k.plugins, &staged, &hold_new).unwrap_err();
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
        let plugins = Arc::new(k.reboot());
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
        let plugins = k.reboot();
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
        let plugins = k.reboot();
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
