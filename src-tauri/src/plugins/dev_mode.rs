/*
 * Developer mode: the registry switch, and the reload of an installed plugin from the folder or archive
 * it was installed from. A reload is the install's own inspect followed by the update's own swap, so
 * every check, size cap and consent rule of a normal update applies unchanged and nothing ever runs from
 * the source location. A failed reload leaves the installed plugin exactly as it was.
 */

// -- Library Imports --
use std::path::Path;

// -- Local Imports --
use super::install::{discard, inspect, require_writable};
use super::install_error::{ErrorCode, InstallError};
use super::lifecycle::save_failed;
use super::stage::Limits;
use super::state::{PluginsState, Withdraw};
use super::update::{not_installed, update, Updated};

/// Whether developer mode is on. A registry written without the field reads as off.
pub fn is_on(plugins: &PluginsState) -> bool {
    plugins.snapshot().dev_mode
}

/// Turns developer mode on or off and saves it. Returns the saved value.
pub fn set(app_data: &Path, plugins: &PluginsState, on: bool) -> Result<bool, InstallError> {
    require_writable(plugins)?;
    plugins.mutate(
        app_data,
        Withdraw::No,
        |registry, _| {
            registry.dev_mode = on;
            Ok(on)
        },
        save_failed,
    )
}

/// Re-installs `id` from its remembered source: inspects the source as an install would, then applies
/// it as an update. A source that is gone or no longer valid, holds another plugin, or changes the tier
/// is refused with the staged copy removed and the installed plugin untouched. A changed capability set
/// or origin list returns the entry to needs-consent, as any update does.
pub fn reload(
    app_data: &Path,
    plugins: &PluginsState,
    id: &str,
    limits: Limits,
) -> Result<Updated, InstallError> {
    require_writable(plugins)?;
    let source = plugins
        .snapshot()
        .entry(id)
        .ok_or_else(|| not_installed(id))?
        .source_path
        .clone()
        .ok_or_else(|| {
            InstallError::new(
                ErrorCode::NotFound,
                format!("{id} has no remembered source"),
            )
        })?;
    let inspection = inspect(app_data, plugins, &source, limits)?;
    if inspection.id != id {
        discard(plugins, &inspection.token);
        return Err(InstallError::new(
            ErrorCode::InvalidManifest,
            format!("the source now holds {}, not {id}", inspection.id),
        ));
    }
    let done = update(app_data, plugins, &inspection.token);
    // A refused update puts the staged copy back under its token.
    if done.is_err() {
        discard(plugins, &inspection.token);
    }
    done
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::install::install;
    use crate::plugins::manifest::Tier;
    use crate::plugins::paths::{plugin_dir, staging_dir};
    use crate::plugins::registry::EntryState;
    use crate::plugins::session;
    use crate::plugins::test_kit::{native, ui, Kit, ID};
    use std::fs;
    use std::path::PathBuf;

    /// Installs the demo plugin from a fresh source folder and returns the folder.
    fn installed(k: &Kit, caps: &[&str]) -> PathBuf {
        let src = k.source(&ui("1.0.0", caps), &[]);
        let token = k.inspect_path(&src).token;
        install(&k.data, &k.plugins, &token, 10).unwrap();
        src
    }

    fn rewrite(src: &Path, manifest: &serde_json::Value, page: &[u8]) {
        fs::write(src.join("plugin.json"), manifest.to_string()).unwrap();
        fs::write(src.join("index.html"), page).unwrap();
    }

    fn staged(k: &Kit) -> usize {
        fs::read_dir(staging_dir(&k.data)).map_or(0, |r| r.count())
    }

    fn live_page(k: &Kit) -> Vec<u8> {
        fs::read(plugin_dir(&k.data, ID).join("index.html")).unwrap()
    }

    /// The installed plugin is as `installed` left it: version, state, page and nothing staged.
    fn assert_untouched(k: &Kit, version: &str) {
        let e = k.plugins.snapshot().entry(ID).unwrap().clone();
        assert_eq!(e.version, version);
        assert_eq!(live_page(k), b"<p>");
        assert_eq!(staged(k), 0);
        assert!(!plugin_dir(&k.data, &format!("{ID}.old")).exists());
    }

    #[test]
    fn the_switch_is_off_by_default_and_survives_a_relaunch() {
        let k = Kit::new();
        assert!(!is_on(&k.plugins));
        assert!(set(&k.data, &k.plugins, true).unwrap());
        assert!(is_on(&k.plugins));
        assert!(is_on(&k.relaunch()));
        assert!(!set(&k.data, &k.plugins, false).unwrap());
        assert!(!is_on(&k.relaunch()));
    }

    #[test]
    fn the_switch_reaches_the_serving_set() {
        let k = Kit::new();
        k.install(&ui("1.0.0", &["storage"]));
        k.enable(&["storage"]);
        assert!(!k.plugins.enabled_set().serving(ID).unwrap().dev_mode);
        set(&k.data, &k.plugins, true).unwrap();
        assert!(k.plugins.enabled_set().serving(ID).unwrap().dev_mode);
    }

    #[test]
    fn a_failed_save_leaves_the_switch_as_it_was() {
        let k = Kit::new();
        k.break_saves();
        assert!(set(&k.data, &k.plugins, true).is_err());
        assert!(!is_on(&k.plugins));
    }

    #[test]
    fn a_reload_applies_the_source_and_keeps_consent_for_an_unchanged_surface() {
        let k = Kit::new();
        let src = installed(&k, &["storage"]);
        k.enable(&["storage"]);
        rewrite(&src, &ui("1.1.0", &["storage"]), b"<p>edited");

        let done = reload(&k.data, &k.plugins, ID, Limits::DEFAULT).unwrap();
        assert_eq!(done.previous_version, "1.0.0");
        let e = &done.row.entry;
        assert_eq!(e.version, "1.1.0");
        assert_eq!(e.state, EntryState::Ready);
        assert!(e.enabled && k.plugins.is_enabled(ID));
        assert_eq!(live_page(&k), b"<p>edited");
        assert_eq!(staged(&k), 0);
        // The source is read, never run from or changed.
        assert_eq!(fs::read(src.join("index.html")).unwrap(), b"<p>edited");
    }

    #[test]
    fn a_reload_with_a_new_capability_asks_for_consent_again() {
        let k = Kit::new();
        let src = installed(&k, &["storage"]);
        k.enable(&["storage"]);
        rewrite(&src, &ui("1.1.0", &["storage", "ui.toast"]), b"<p>edited");

        let e = reload(&k.data, &k.plugins, ID, Limits::DEFAULT)
            .unwrap()
            .row
            .entry;
        assert_eq!(e.state, EntryState::NeedsConsent);
        assert!(!e.enabled && e.granted.is_empty());
        assert!(!k.plugins.is_enabled(ID));
    }

    #[test]
    fn a_reload_that_changes_the_tier_is_refused_and_leaves_the_plugin_alone() {
        let k = Kit::new();
        let src = installed(&k, &["storage"]);
        k.enable(&["storage"]);
        rewrite(&src, &native("1.1.0", &["storage"]), b"<p>edited");

        let refused = reload(&k.data, &k.plugins, ID, Limits::DEFAULT).unwrap_err();
        assert_eq!(refused.code, ErrorCode::TierChanged);
        assert_untouched(&k, "1.0.0");
        let e = k.plugins.snapshot().entry(ID).unwrap().clone();
        assert!(e.enabled && e.tier == Tier::Ui && k.plugins.is_enabled(ID));
    }

    #[test]
    fn a_reload_revalidates_the_manifest() {
        let k = Kit::new();
        let src = installed(&k, &["storage"]);
        fs::write(src.join("plugin.json"), b"{ not json").unwrap();
        let refused = reload(&k.data, &k.plugins, ID, Limits::DEFAULT).unwrap_err();
        assert_eq!(refused.code, ErrorCode::InvalidManifest);
        assert_untouched(&k, "1.0.0");

        let mut bad = ui("1.1.0", &["storage"]);
        bad["capabilities"] = serde_json::json!(["files.write"]);
        rewrite(&src, &bad, b"<p>edited");
        let refused = reload(&k.data, &k.plugins, ID, Limits::DEFAULT).unwrap_err();
        assert_eq!(refused.code, ErrorCode::InvalidManifest);
        assert_untouched(&k, "1.0.0");
    }

    #[test]
    fn a_reload_from_a_missing_source_leaves_the_plugin_intact() {
        let k = Kit::new();
        let src = installed(&k, &["storage"]);
        k.enable(&["storage"]);
        fs::remove_dir_all(&src).unwrap();

        let refused = reload(&k.data, &k.plugins, ID, Limits::DEFAULT).unwrap_err();
        assert_eq!(refused.code, ErrorCode::NotFound);
        assert_untouched(&k, "1.0.0");
        assert!(k.plugins.is_enabled(ID));
    }

    #[test]
    fn a_reload_when_the_source_holds_another_plugin_is_refused() {
        let k = Kit::new();
        let src = installed(&k, &["storage"]);
        let mut other = ui("1.1.0", &["storage"]);
        other["id"] = serde_json::json!("com.example.other");
        rewrite(&src, &other, b"<p>edited");

        let refused = reload(&k.data, &k.plugins, ID, Limits::DEFAULT).unwrap_err();
        assert_eq!(refused.code, ErrorCode::InvalidManifest);
        assert_untouched(&k, "1.0.0");
        assert_eq!(k.plugins.snapshot().entries.len(), 1);
    }

    #[test]
    fn a_reload_needs_a_remembered_source_and_an_installed_plugin() {
        let k = Kit::new();
        let refused = reload(&k.data, &k.plugins, ID, Limits::DEFAULT).unwrap_err();
        assert_eq!(refused.code, ErrorCode::NotInstalled);
        installed(&k, &["storage"]);
        k.set_entry(|e| e.source_path = None);
        let refused = reload(&k.data, &k.plugins, ID, Limits::DEFAULT).unwrap_err();
        assert_eq!(refused.code, ErrorCode::NotFound);
        assert_untouched(&k, "1.0.0");
    }

    #[test]
    fn a_reload_holds_the_same_size_caps_as_an_install() {
        let k = Kit::new();
        let src = installed(&k, &["storage"]);
        fs::write(src.join("big.bin"), vec![0u8; 4096]).unwrap();
        let tight = Limits {
            total_bytes: 1024,
            ..Limits::DEFAULT
        };
        let refused = reload(&k.data, &k.plugins, ID, tight).unwrap_err();
        assert_eq!(refused.code, ErrorCode::TooLarge);
        assert_untouched(&k, "1.0.0");
    }

    #[test]
    fn a_reload_in_safe_mode_starts_nothing() {
        let k = Kit::new();
        let src = installed(&k, &["storage"]);
        k.enable(&["storage"]);
        session::clear(&k.data);
        session::set_safe_mode(&k.data, true).unwrap();
        let safe = k.reboot();
        rewrite(&src, &ui("1.1.0", &["storage"]), b"<p>edited");

        let done = reload(&k.data, &safe, ID, Limits::DEFAULT).unwrap();
        assert_eq!(done.row.entry.version, "1.1.0");
        assert!(!safe.is_enabled(ID));
        assert!(safe.enabled_set().serving(ID).is_none());
    }
}
