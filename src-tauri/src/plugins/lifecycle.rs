/*
 * What happens to an installed plugin after install: consent and enable, disable, and uninstall. Each
 * runs in the plugin's lifecycle turn, so two calls on one id never interleave and a second one is
 * refused as busy; a start it triggers runs after the turn ends. Every change is made and saved
 * through `PluginsState::mutate`, under the state lock, so the frame host's set follows the saved
 * registry. Files are read before the
 * lock is taken and the entry is checked again under it, so a slow disk never holds the lock. Consent
 * is granted only here, and only for the manifest the user reviewed, as it is on disk at that moment.
 */

// -- Library Imports --
use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;

// -- Local Imports --
use super::install::{
    new_staging_dir, remove_tree, rename_with_retry, require_writable, staging_root,
};
use super::api::stream::Gone;
use super::install_error::{ErrorCode, InstallError};
use super::manifest::{Capability, Compat, Manifest, Tier};
use super::paths::{data_dir, plugin_dir};
use super::registry::{Entry, EntryState, Registry};
use super::revalidate::{check_folder, demote, needs_newer, CheckError, Problems};
use super::state::{PluginRow, PluginsState, Withdraw};
use super::update::{not_installed, old_dir};
use super::vis_store;

/// What uninstall did beyond removing the plugin.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Uninstalled {
    pub id: String,
    /// Set when the data folder was to be deleted and could not be.
    pub data_warning: Option<String>,
}

// An enable outcome: an outer error changes nothing; an inner one is saved, then refused.
type Outcome = Result<Result<PluginRow, InstallError>, InstallError>;

fn not_found(id: &str) -> InstallError {
    InstallError::new(ErrorCode::NotFound, format!("{id} is not installed"))
}

pub(super) fn busy(id: &str) -> InstallError {
    InstallError::new(
        ErrorCode::Busy,
        format!("{id} changed during this call; try again"),
    )
}

pub(super) fn save_failed(e: io::Error) -> InstallError {
    InstallError::io("cannot save the plugin registry", e)
}

fn entry_mut<'a>(registry: &'a mut Registry, id: &str) -> Result<&'a mut Entry, InstallError> {
    registry
        .entries
        .iter_mut()
        .find(|e| e.id == id)
        .ok_or_else(|| not_found(id))
}

fn row(entry: &Entry, problems: &Problems) -> PluginRow {
    PluginRow::new(entry.clone(), problems.get(&entry.id).cloned())
}

fn refused(code: ErrorCode, detail: impl Into<String>) -> Outcome {
    Ok(Err(InstallError::new(code, detail)))
}

/// Back to needs-consent: disabled, nothing granted.
pub(super) fn reset_consent(entry: &mut Entry) {
    entry.state = EntryState::NeedsConsent;
    entry.enabled = false;
    entry.granted.clear();
    entry.ready_enabled = None;
    entry.consented_network.clear();
}

/// Whether `grants` names exactly the declared capabilities: the same set, no repeats, no unknown name.
fn grants_match(grants: &[String], declared: &[Capability]) -> bool {
    let mut seen = HashSet::new();
    grants.len() == declared.len()
        && grants.iter().all(|name| {
            Capability::parse(name).is_some_and(|c| declared.contains(&c) && seen.insert(c))
        })
}

/// Enables a plugin, granting consent first when it needs it. Consent needs `grants`, exactly the
/// declared capabilities, and `reviewed`, the manifest hash the review sheet showed; for a ready
/// plugin both are optional but must match when given. The folder is checked first: a folder that
/// no longer validates marks the entry broken, and a manifest that changed since it was recorded
/// sends the entry back to needs-consent. Both are saved, then refused.
pub fn enable(
    app_data: &Path,
    plugins: &PluginsState,
    id: &str,
    grants: Option<&[String]>,
    native_ack: bool,
    reviewed: Option<&str>,
) -> Result<PluginRow, InstallError> {
    enable_or_approve(app_data, plugins, id, grants, native_ack, reviewed, true)
}

/// Records consent exactly as `enable` does, but leaves the plugin off. A plugin that is already
/// ready is returned as it is: this never turns one on or off.
pub fn approve(
    app_data: &Path,
    plugins: &PluginsState,
    id: &str,
    grants: Option<&[String]>,
    native_ack: bool,
    reviewed: Option<&str>,
) -> Result<PluginRow, InstallError> {
    enable_or_approve(app_data, plugins, id, grants, native_ack, reviewed, false)
}

/// The shared path of `enable` and `approve`; `turn_on` says whether a passing check also enables.
fn enable_or_approve(
    app_data: &Path,
    plugins: &PluginsState,
    id: &str,
    grants: Option<&[String]>,
    native_ack: bool,
    reviewed: Option<&str>,
    turn_on: bool,
) -> Result<PluginRow, InstallError> {
    require_writable(plugins)?;
    let turn = plugins.turn(id)?;
    let seen = plugins
        .snapshot()
        .entry(id)
        .cloned()
        .ok_or_else(|| not_found(id))?;
    match seen.state {
        EntryState::Broken => {
            return Err(InstallError::new(
                ErrorCode::Broken,
                format!("{id} is broken"),
            ))
        }
        EntryState::Incompatible => {
            return Err(InstallError::new(
                ErrorCode::Incompatible,
                format!("{id} needs a newer Plisto"),
            ))
        }
        EntryState::NeedsConsent | EntryState::Ready => {}
    }
    // The id came from the registry, which only holds valid ids.
    let checked = check_folder(&plugin_dir(app_data, id), Some(id));
    let demotes = match &checked {
        Ok((manifest, hash)) => {
            *hash != seen.manifest_hash || manifest.compat != Compat::Compatible
        }
        Err(_) => true,
    };
    let withdraw = if demotes {
        Withdraw::Demoting(id)
    } else {
        Withdraw::No
    };
    let row = plugins
        .mutate(
            app_data,
            withdraw,
            |registry, problems| {
                let entry = entry_mut(registry, id)?;
                if entry.state != seen.state || entry.manifest_hash != seen.manifest_hash {
                    return Err(busy(id));
                }
                apply_enable(
                    entry, problems, checked, grants, native_ack, reviewed, turn_on,
                )
            },
            save_failed,
        )
        .and_then(|done| done);
    // A demoted plugin left the serving set, so its running code stops too.
    if demotes && seen.is_serving() && !plugins.is_enabled(id) {
        plugins.stop_because(id, Gone::Consent);
    }
    let row = row?;
    // The start takes the turn itself.
    drop(turn);
    if turn_on {
        plugins.start(id);
    }
    Ok(row)
}

/// Applies an enable (or, without `turn_on`, only the consent) to an entry, from the folder check
/// made before the lock.
fn apply_enable(
    entry: &mut Entry,
    problems: &mut Problems,
    checked: Result<(Manifest, String), CheckError>,
    grants: Option<&[String]>,
    native_ack: bool,
    reviewed: Option<&str>,
    turn_on: bool,
) -> Outcome {
    let id = entry.id.clone();
    let (manifest, hash) = match checked {
        Ok(found) => found,
        Err(e) => {
            demote(entry, EntryState::Broken);
            problems.insert(id, e.to_string());
            return refused(ErrorCode::Broken, e.to_string());
        }
    };
    if let Compat::NeedsNewer(min) = &manifest.compat {
        demote(entry, EntryState::Incompatible);
        problems.insert(id, needs_newer(min));
        return refused(ErrorCode::Incompatible, needs_newer(min));
    }
    if entry.manifest_hash != hash {
        reset_consent(entry);
        entry.manifest_hash = hash;
        entry.version = manifest.version;
        entry.tier = manifest.tier;
        return refused(
            ErrorCode::ManifestChanged,
            "plugin.json changed since it was recorded",
        );
    }
    let reviewed_ok = match reviewed {
        Some(seen) => seen == hash,
        None => entry.state == EntryState::Ready,
    };
    if !reviewed_ok {
        return Err(InstallError::new(
            ErrorCode::ManifestChanged,
            "the reviewed plugin.json is not the installed one",
        ));
    }
    let mismatch = || {
        InstallError::new(
            ErrorCode::ConsentMismatch,
            "the grants must be exactly the declared capabilities",
        )
    };
    if grants.is_some_and(|g| !grants_match(g, &manifest.capabilities)) {
        return Err(mismatch());
    }
    if entry.state == EntryState::NeedsConsent {
        if grants.is_none() {
            return Err(mismatch());
        }
        if manifest.tier == Tier::Native && !native_ack {
            return Err(InstallError::new(
                ErrorCode::NativeAckRequired,
                "a native plugin needs the explicit acknowledgement",
            ));
        }
        entry.state = EntryState::Ready;
        entry.granted = manifest.capabilities;
    }
    entry.bind_network(&manifest.network);
    if turn_on {
        entry.enabled = true;
    }
    Ok(Ok(row(entry, problems)))
}

/// Saves whether a plugin's sidebar group is collapsed. Allowed in any state; the serving set is untouched.
pub fn set_sidebar_collapsed(
    app_data: &Path,
    plugins: &PluginsState,
    id: &str,
    collapsed: bool,
) -> Result<PluginRow, InstallError> {
    require_writable(plugins)?;
    plugins.mutate(
        app_data,
        Withdraw::No,
        |registry, problems| {
            let entry = registry
                .entries
                .iter_mut()
                .find(|e| e.id == id)
                .ok_or_else(|| not_installed(id))?;
            entry.sidebar_collapsed = collapsed;
            Ok(row(entry, problems))
        },
        save_failed,
    )
}

/// Disables a plugin and stops it. Consent and grants are kept, so enabling again asks nothing. A
/// broken or incompatible plugin that was enabled is remembered as disabled, so its recovery does
/// not turn it back on. Anything else is left as it is.
pub fn disable(
    app_data: &Path,
    plugins: &PluginsState,
    id: &str,
) -> Result<PluginRow, InstallError> {
    require_writable(plugins)?;
    let _turn = plugins.turn(id)?;
    let (row, was_on) = plugins.mutate(
        app_data,
        Withdraw::No,
        |registry, problems| {
            let entry = entry_mut(registry, id)?;
            let was_on = entry.is_serving();
            entry.enabled = false;
            if entry.ready_enabled == Some(true) {
                entry.ready_enabled = Some(false);
            }
            Ok((row(entry, problems), was_on))
        },
        save_failed,
    )?;
    if was_on {
        plugins.stop(id);
    }
    Ok(row)
}

/// Moves `path` into a fresh folder under staging and returns that folder. A delete from there that
/// stops halfway leaves nothing boot would adopt, and the boot sweep finishes it.
pub(super) fn park(app_data: &Path, path: &Path, name: &str) -> Result<PathBuf, InstallError> {
    let (_, holder) = new_staging_dir(&staging_root(app_data)?)?;
    match rename_with_retry(path, &holder.join(name)) {
        Ok(()) => Ok(holder),
        Err(e) => {
            let _ = fs::remove_dir(&holder);
            Err(InstallError::io("cannot move the folder aside", e))
        }
    }
}

/// Parks a folder, then deletes it. A delete that fails is left to the boot sweep.
pub(super) fn remove_folder(app_data: &Path, path: &Path, name: &str) -> Result<(), InstallError> {
    let holder = park(app_data, path, name)?;
    let _ = remove_tree(&holder);
    Ok(())
}

/// Deletes the plugin's saved-data folder, when there is one. The path comes from the id alone.
pub(super) fn remove_data(app_data: &Path, id: &str) -> Result<(), InstallError> {
    let data = data_dir(app_data, id);
    if fs::symlink_metadata(&data).is_err() {
        return Ok(());
    }
    remove_folder(app_data, &data, id)
}

/// Moves `from` to `to` when `from` exists.
fn move_if_present(from: &Path, to: &Path) -> io::Result<()> {
    if fs::symlink_metadata(from).is_err() {
        return Ok(());
    }
    rename_with_retry(from, to)
}

/// Stops the plugin, moves its folder (and any `<id>.old` an update left) out of `plugins/` and
/// removes its entry, then deletes what was moved. The move comes first because a delete that stops
/// halfway in place would leave a folder that boot adopts or restores again. An entry whose folder is
/// already gone is simply removed. With `delete_data`, the data folder goes too; a failure there is a
/// warning, not a failed uninstall.
pub fn uninstall(
    app_data: &Path,
    plugins: &PluginsState,
    id: &str,
    delete_data: bool,
) -> Result<Uninstalled, InstallError> {
    require_writable(plugins)?;
    let turn = plugins.turn(id)?;
    if plugins.snapshot().entry(id).is_none() {
        return Err(not_found(id));
    }
    let target = plugin_dir(app_data, id);
    let old = old_dir(app_data, id);
    let (_, holder) = new_staging_dir(&staging_root(app_data)?)?;
    let parked = holder.join(id);
    let parked_old = holder.join("old");
    let put_back = || {
        for (from, to) in [(&parked, &target), (&parked_old, &old)] {
            if let Err(e) = move_if_present(from, to) {
                eprintln!("plugins: cannot move {id} back after a failed uninstall: {e}");
            }
        }
    };
    // Held until the folders are dealt with, so an enable meanwhile cannot start the plugin.
    let withdrawn = plugins.withdraw(id);
    plugins.stop(id);
    let removed = plugins.mutate(
        app_data,
        Withdraw::While(id),
        |registry, problems| {
            let at = registry
                .entries
                .iter()
                .position(|e| e.id == id)
                .ok_or_else(|| not_found(id))?;
            let moved =
                move_if_present(&target, &parked).and_then(|()| move_if_present(&old, &parked_old));
            if let Err(e) = moved {
                put_back();
                return Err(InstallError::io("cannot move the plugin folder aside", e));
            }
            registry.entries.remove(at);
            problems.remove(id);
            Ok(())
        },
        |e| {
            put_back();
            save_failed(e)
        },
    );
    if let Err(e) = removed {
        // Only removes the holder when nothing was left in it.
        let _ = fs::remove_dir(&holder);
        // The plugin is still installed and was stopped above; it runs again if still serving.
        drop(withdrawn);
        drop(turn);
        plugins.start(id);
        return Err(e);
    }
    let _ = remove_tree(&holder);
    vis_store::remove(app_data, id);
    let data_warning = delete_data
        .then(|| remove_data(app_data, id).err())
        .flatten()
        .map(|e| e.detail);
    Ok(Uninstalled {
        id: id.to_string(),
        data_warning,
    })
}

#[cfg(test)]
mod tests;
