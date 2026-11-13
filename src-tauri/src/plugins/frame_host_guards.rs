/*
 * Repository-level guards for the plugin frame host: the window CSPs, the capability files, the app
 * builder and the locked Tauri stack. Each fails when a config change would quietly undo a property
 * the frame sandbox relies on.
 */

// -- Library Imports --
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

// The versions the sandbox probe ran against. A bump re-runs the probe before these move.
const PROBED: &[(&str, &str)] = &[
    ("tauri", "2.12.5"),
    ("tauri-runtime-wry", "2.12.3"),
    ("wry", "0.57.1"),
];

fn crate_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn read_json(path: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(path).unwrap())
        .unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

#[test]
fn both_policies_frame_only_the_plugin_host() {
    let conf = read_json(&crate_root().join("tauri.conf.json"));
    let security = &conf["app"]["security"];
    for key in ["csp", "devCsp"] {
        let csp = security[key].as_str().unwrap();
        let frame_src: Vec<&str> = csp
            .split(';')
            .map(str::trim)
            .filter(|d| d.starts_with("frame-src"))
            .collect();
        assert_eq!(frame_src, ["frame-src https://*.invalid"], "{key}");
        assert!(!csp.contains("plistoplugin"), "{key}");
    }
}

#[test]
fn the_app_origins_match_the_config() {
    let conf = read_json(&crate_root().join("tauri.conf.json"));
    // The frame host trusts `http://tauri.localhost` as the main window's origin, which holds only
    // while the window keeps the default http scheme.
    for window in conf["app"]["windows"].as_array().unwrap() {
        assert!(window.get("useHttpsScheme").is_none());
    }
    assert_eq!(conf["build"]["devUrl"], "http://localhost:1420");
}

#[test]
fn no_plugin_scheme_is_registered() {
    let lib = fs::read_to_string(crate_root().join("src/lib.rs")).unwrap();
    for call in [
        "register_asynchronous_uri_scheme_protocol",
        "register_uri_scheme_protocol",
    ] {
        assert!(!lib.contains(call), "lib.rs registers a URI scheme: {call}");
    }
    assert!(!lib.contains("plistoplugin"));
}

/// The capability objects in one parsed capability source: a single capability, an array of them,
/// or an object holding a `capabilities` list. Bare identifiers referencing a file are skipped.
fn capability_objects(value: &Value) -> Vec<&Value> {
    let list = match value {
        Value::Array(items) => items.iter().collect(),
        Value::Object(map) => match map.get("capabilities") {
            Some(Value::Array(items)) => items.iter().collect(),
            _ => vec![value],
        },
        _ => Vec::new(),
    };
    list.into_iter().filter(|c| c.is_object()).collect()
}

fn assert_no_remote(source: &str, value: &Value) {
    for cap in capability_objects(value) {
        assert!(
            cap.get("remote").is_none(),
            "{source}: capability {} declares `remote`. Plisto grants no remote URL any command: \
             plugin frames load from remote-classed https hosts, and a `remote` entry (even a \
             wildcard that never names them) could hand those frames Tauri commands.",
            cap["identifier"]
        );
    }
}

// Remote content reaches Tauri commands only through a capability's `remote` URLs. The capability
// files are strict JSON with no room for a comment, so the rule lives here: no capability, in a
// file or inline in the config, may declare `remote` at all.
#[test]
fn no_capability_declares_remote_access() {
    let dir = crate_root().join("capabilities");
    let mut seen = 0;
    for entry in fs::read_dir(&dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            continue;
        }
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        assert_eq!(
            ext,
            "json",
            "{}: only JSON capability files are checked by this guard",
            path.display()
        );
        seen += 1;
        assert_no_remote(&path.display().to_string(), &read_json(&path));
    }
    assert!(seen > 0);

    let conf = read_json(&crate_root().join("tauri.conf.json"));
    assert_no_remote(
        "tauri.conf.json app.security.capabilities",
        &conf["app"]["security"]["capabilities"],
    );
}

#[test]
fn the_remote_guard_reads_every_capability_shape() {
    let remote = serde_json::json!({ "identifier": "x", "remote": { "urls": ["*"] } });
    let plain = serde_json::json!({ "identifier": "y", "permissions": [] });
    for (value, count) in [
        (remote.clone(), 1),
        (serde_json::json!([plain.clone(), remote.clone()]), 2),
        (
            serde_json::json!({ "capabilities": [remote.clone(), "default"] }),
            1,
        ),
        (serde_json::json!(["default"]), 0),
        (Value::Null, 0),
    ] {
        assert_eq!(capability_objects(&value).len(), count, "{value}");
    }
    let caught = std::panic::catch_unwind(|| assert_no_remote("test", &remote));
    assert!(caught.is_err());
    assert_no_remote("test", &plain);
}

/// Every version of `name` the lockfile holds.
fn locked_versions(lock: &str, name: &str) -> Vec<String> {
    let header = format!("[[package]]\nname = \"{name}\"\nversion = \"");
    lock.match_indices(&header)
        .map(|(at, _)| {
            let rest = &lock[at + header.len()..];
            rest[..rest.find('"').unwrap()].to_string()
        })
        .collect()
}

#[test]
fn the_tauri_stack_is_the_probed_one() {
    let lock = fs::read_to_string(crate_root().join("Cargo.lock"))
        .unwrap()
        .replace("\r\n", "\n");
    for (name, want) in PROBED {
        assert_eq!(
            locked_versions(&lock, name),
            [want.to_string()],
            "{name} is not the version the plugin sandbox probe ran against ({want}). Re-run \
             examples/plugins/sandbox-probe against the new version before updating PROBED."
        );
    }
}
