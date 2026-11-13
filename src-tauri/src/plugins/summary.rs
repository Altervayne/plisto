/*
 * What a plugin row shows beyond its registry entry: a display summary read from the installed
 * `plugin.json`. The summary is never consulted for a decision; consent stays bound to the manifest
 * hash. Reading touches the disk, so callers take their rows first and build the views after the
 * state lock is released.
 */

// -- Library Imports --
use std::fs;
use std::io::Read;
use std::path::Path;

use serde::Serialize;

// -- Local Imports --
use super::frame_host::is_reparse_point;
use super::manifest::{self, Capability, Compat, Manifest, ModeOpt, MAX_MANIFEST_BYTES};
use super::paths::plugin_dir;
use super::revalidate::MANIFEST_FILE;
use super::sidebar_decl::SidebarDecl;
use super::state::PluginRow;
use super::update::Updated;

/// The manifest fields a row shows.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ManifestSummary {
    pub name: String,
    pub author: String,
    pub homepage: Option<String>,
    pub capabilities: Vec<Capability>,
    pub origins: Vec<String>,
    pub native_reason: Option<String>,
    pub sidebar_items: usize,
    pub sidebar: Option<SidebarDecl>,
    pub modes: Vec<ModeOpt>,
    pub compat: Compat,
}

impl ManifestSummary {
    pub fn of(manifest: &Manifest) -> ManifestSummary {
        ManifestSummary {
            name: manifest.name.clone(),
            author: manifest.author.clone(),
            homepage: manifest.homepage.clone(),
            capabilities: manifest.capabilities.clone(),
            origins: manifest.network.clone(),
            native_reason: manifest.native_reason.clone(),
            sidebar_items: sidebar_item_count(manifest),
            sidebar: manifest.sidebar.clone(),
            modes: manifest.modes.clone(),
            compat: manifest.compat.clone(),
        }
    }
}

/// How many sidebar items the manifest declares; 0 without a sidebar block.
pub fn sidebar_item_count(manifest: &Manifest) -> usize {
    manifest.sidebar.as_ref().map_or(0, |s| s.items.len())
}

/// A registry row with the summary of its installed manifest, `None` when that cannot be read.
#[derive(Clone, Debug, Serialize)]
pub struct RowView {
    #[serde(flatten)]
    pub row: PluginRow,
    pub manifest: Option<ManifestSummary>,
}

/// The result of an update, with its row as a `RowView`.
#[derive(Clone, Debug, Serialize)]
pub struct UpdatedView {
    pub row: RowView,
    pub previous_version: String,
}

/// Reads and parses the `plugin.json` in `dir`. A folder or manifest that is a link, is missing, is
/// unreadable or does not parse is `None`. Only the manifest is checked, not the files it names.
pub fn read_manifest(dir: &Path) -> Option<Manifest> {
    let folder = fs::symlink_metadata(dir).ok()?;
    if !folder.is_dir() || is_reparse_point(&folder) {
        return None;
    }
    let path = dir.join(MANIFEST_FILE);
    let meta = fs::symlink_metadata(&path).ok()?;
    if !meta.is_file() || is_reparse_point(&meta) {
        return None;
    }
    let mut bytes = Vec::new();
    fs::File::open(&path)
        .and_then(|f| {
            f.take(MAX_MANIFEST_BYTES as u64 + 1)
                .read_to_end(&mut bytes)
        })
        .ok()?;
    manifest::parse(&bytes).ok()
}

/// The row with its summary, read from the installed folder.
pub fn view(app_data: &Path, row: PluginRow) -> RowView {
    let manifest = read_manifest(&plugin_dir(app_data, &row.entry.id))
        .as_ref()
        .map(ManifestSummary::of);
    RowView { row, manifest }
}

pub fn views(app_data: &Path, rows: Vec<PluginRow>) -> Vec<RowView> {
    rows.into_iter().map(|row| view(app_data, row)).collect()
}

pub fn updated_view(app_data: &Path, updated: Updated) -> UpdatedView {
    UpdatedView {
        row: view(app_data, updated.row),
        previous_version: updated.previous_version,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::paths::plugin_dir;
    use crate::plugins::test_kit::{ui, Kit, ID};
    use serde_json::{json, Value};

    fn row_json(k: &Kit) -> Value {
        let rows = views(&k.data, k.plugins.rows());
        serde_json::to_value(&rows[0]).unwrap()
    }

    #[test]
    fn a_full_manifest_is_summarized() {
        let k = Kit::new();
        let mut manifest = ui("1.0.0", &["storage", "network", "ui.sidebar"]);
        manifest["homepage"] = json!("https://example.com/demo");
        manifest["network"] = json!(["https://a.example.com", "https://b.example.com"]);
        manifest["sidebar"] = json!({
            "layout": "section",
            "items": [
                {"id": "home", "type": "nav", "label": "Home", "route": "/", "icon": "music"},
                {"id": "stats", "type": "nav", "label": "Stats", "route": "/stats"}
            ]
        });
        k.install(&manifest);
        let json = row_json(&k);
        assert_eq!(json["id"], ID);
        assert_eq!(json["state"], "needs_consent");
        assert!(json["problem"].is_null());
        let m = &json["manifest"];
        assert_eq!(m["name"], "Demo");
        assert_eq!(m["author"], "A");
        assert_eq!(m["homepage"], "https://example.com/demo");
        assert_eq!(
            m["capabilities"],
            json!(["storage", "network", "ui.sidebar"])
        );
        assert_eq!(
            m["origins"],
            json!(["https://a.example.com", "https://b.example.com"])
        );
        assert!(m["native_reason"].is_null());
        assert_eq!(m["sidebar_items"], 2);
        assert_eq!(m["compat"], json!({"state": "compatible"}));
    }

    #[test]
    fn the_sidebar_declaration_and_modes_are_summarized() {
        let k = Kit::new();
        let mut manifest = ui("1.0.0", &["ui.sidebar", "background"]);
        manifest["modes"] = json!(["player", "organizer"]);
        manifest["sidebar"] = json!({
            "layout": "section",
            "items": [
                {"id": "home", "type": "nav", "label": "Home", "route": "/", "icon": "music"},
                {"id": "plain", "type": "nav", "label": "Plain"},
                {"id": "state", "type": "status", "label": "State"},
                {"id": "sync", "type": "progress", "label": "Sync"},
                {"id": "auto", "type": "toggle", "label": "Auto"},
                {"id": "go", "type": "action", "label": "Go"}
            ]
        });
        k.install(&manifest);
        let m = &row_json(&k)["manifest"];
        assert_eq!(m["sidebar_items"], 6);
        assert_eq!(m["modes"], json!(["player", "organizer"]));
        assert_eq!(
            m["sidebar"],
            json!({
                "layout": "section",
                "items": [
                    {"id": "home", "type": "nav", "label": "Home", "route": "/", "icon": "music"},
                    {"id": "plain", "type": "nav", "label": "Plain", "route": null, "icon": null},
                    {"id": "state", "type": "status", "label": "State", "route": null, "icon": null},
                    {"id": "sync", "type": "progress", "label": "Sync", "route": null, "icon": null},
                    {"id": "auto", "type": "toggle", "label": "Auto", "route": null, "icon": null},
                    {"id": "go", "type": "action", "label": "Go", "route": null, "icon": null}
                ]
            })
        );
    }

    #[test]
    fn a_manifest_without_sidebar_or_modes_serializes_null_and_the_default_mode() {
        let k = Kit::new();
        k.install(&ui("1.0.0", &[]));
        let m = &row_json(&k)["manifest"];
        assert!(m["sidebar"].is_null());
        assert_eq!(m["sidebar_items"], 0);
        assert_eq!(m["modes"], json!(["player"]));
    }

    #[test]
    fn a_manifest_without_sidebar_or_network_has_empty_counts() {
        let k = Kit::new();
        k.install(&ui("1.0.0", &[]));
        let json = row_json(&k);
        assert_eq!(json["manifest"]["sidebar_items"], 0);
        assert_eq!(json["manifest"]["origins"], json!([]));
        assert!(json["manifest"]["homepage"].is_null());
    }

    #[test]
    fn a_newer_requirement_serializes_with_its_version() {
        let k = Kit::new();
        let mut manifest = ui("1.0.0", &[]);
        manifest["min_plisto"] = json!("999.0.0");
        k.install(&manifest);
        let json = row_json(&k);
        assert_eq!(
            json["manifest"]["compat"],
            json!({"state": "needs_newer", "min_plisto": "999.0.0"})
        );
    }

    #[test]
    fn an_unreadable_manifest_gives_none() {
        let k = Kit::new();
        k.install(&ui("1.0.0", &[]));
        let manifest = plugin_dir(&k.data, ID).join("plugin.json");
        fs::write(&manifest, "{ nope").unwrap();
        assert!(row_json(&k)["manifest"].is_null());
        fs::remove_file(&manifest).unwrap();
        assert!(row_json(&k)["manifest"].is_null());
        fs::remove_dir_all(plugin_dir(&k.data, ID)).unwrap();
        let json = row_json(&k);
        assert!(json["manifest"].is_null());
        assert_eq!(json["id"], ID);
    }

    #[test]
    fn an_updated_result_carries_the_summary_in_its_row() {
        let k = Kit::new();
        k.install(&ui("1.0.0", &[]));
        let token = k.inspect(&ui("1.1.0", &[]));
        let done = crate::plugins::update::update(&k.data, &k.plugins, &token).unwrap();
        let json = serde_json::to_value(updated_view(&k.data, done)).unwrap();
        assert_eq!(json["previous_version"], "1.0.0");
        assert_eq!(json["row"]["version"], "1.1.0");
        assert_eq!(json["row"]["manifest"]["name"], "Demo");
    }
}
