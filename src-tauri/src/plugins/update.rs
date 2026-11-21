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
use super::vis_store;

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
    // Recorded while the turn is held, so a quick second update or an uninstall cannot interleave.
    // A developer reload is an update, so it lands here too.
    if updated.is_ok() {
        let _ = vis_store::record_build(app_data, id);
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
mod tests;
