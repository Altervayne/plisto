/*
 * Fixtures for the lifecycle and update tests: a throwaway app data folder booted into a plugin state
 * with a recording stopper, and manifest builders. Plugins are installed through the real inspect and
 * install path, never written into the registry by hand.
 */

// -- Library Imports --
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

// -- Local Imports --
use super::install::{inspect, install};
use super::lifecycle::{enable, save_failed};
use super::paths::state_dir;
use super::registry::{self, Entry, FileRead};
use super::stage::{Limits, Temp};
use super::state::{PluginRow, PluginsState, Withdraw};

pub const ID: &str = "com.example.demo";
const VERSION: &str = "2.7.0";

pub fn ui(version: &str, caps: &[&str]) -> Value {
    json!({
        "manifest_version": 1, "id": ID, "name": "Demo", "version": version, "tier": "ui",
        "entry": "index.html", "capabilities": caps, "min_plisto": "1.0.0", "author": "A"
    })
}

pub fn native(version: &str, caps: &[&str]) -> Value {
    let mut v = ui(version, caps);
    v["tier"] = json!("native");
    v["entry"] = json!("bin/tool.exe");
    v["native_reason"] = json!("Reads the audio stream in real time.");
    v
}

pub fn grants(caps: &[&str]) -> Vec<String> {
    caps.iter().map(|c| c.to_string()).collect()
}

pub struct Kit {
    temp: Temp,
    pub data: PathBuf,
    pub plugins: PluginsState,
    stops: Arc<Mutex<Vec<String>>>,
}

impl Kit {
    pub fn new() -> Kit {
        let temp = Temp::new("lifecycle");
        let data = temp.0.join("appdata");
        fs::create_dir_all(&data).unwrap();
        let plugins = PluginsState::boot(&data, VERSION, 1, 50);
        let stops = Arc::new(Mutex::new(Vec::new()));
        let record = stops.clone();
        plugins.set_stopper(Arc::new(move |id: &str| {
            record.lock().unwrap().push(id.to_string())
        }));
        Kit {
            temp,
            data,
            plugins,
            stops,
        }
    }

    /// A second state booted from the same folder, as the next launch would see it.
    pub fn reboot(&self) -> PluginsState {
        PluginsState::boot(&self.data, VERSION, 1, 60)
    }

    /// Writes a source folder for `manifest` and inspects it. Returns the token.
    pub fn inspect(&self, manifest: &Value) -> String {
        self.inspect_into(&self.plugins, manifest)
    }

    /// `inspect` into another state booted from the same folder.
    pub fn inspect_into(&self, plugins: &PluginsState, manifest: &Value) -> String {
        static N: AtomicUsize = AtomicUsize::new(0);
        let src = self
            .temp
            .0
            .join(format!("src-{}", N.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir_all(src.join("bin")).unwrap();
        fs::write(src.join("plugin.json"), manifest.to_string()).unwrap();
        fs::write(src.join("index.html"), b"<p>").unwrap();
        fs::write(src.join("bin/tool.exe"), b"MZ").unwrap();
        inspect(&self.data, plugins, src.to_str().unwrap(), Limits::DEFAULT)
            .unwrap()
            .token
    }

    pub fn install(&self, manifest: &Value) -> PluginRow {
        let token = self.inspect(manifest);
        install(&self.data, &self.plugins, &token, 10).unwrap()
    }

    /// Consents to and enables the demo plugin, as reviewed at its recorded hash.
    pub fn enable(&self, caps: &[&str]) {
        let hash = self
            .plugins
            .snapshot()
            .entry(ID)
            .unwrap()
            .manifest_hash
            .clone();
        enable(
            &self.data,
            &self.plugins,
            ID,
            Some(&grants(caps)),
            true,
            Some(&hash),
        )
        .unwrap();
    }

    /// Edits the demo plugin's entry and saves it.
    pub fn set_entry(&self, edit: impl FnOnce(&mut Entry)) {
        self.plugins
            .mutate(
                &self.data,
                Withdraw::No,
                |registry, _| {
                    edit(registry.entries.iter_mut().find(|e| e.id == ID).unwrap());
                    Ok(())
                },
                save_failed,
            )
            .unwrap();
    }

    pub fn stops(&self) -> Vec<String> {
        self.stops.lock().unwrap().clone()
    }

    /// The demo plugin's entry as saved on disk.
    pub fn saved_entry(&self) -> Entry {
        match registry::read_file(&self.data) {
            FileRead::Parsed(read) => read.entry(ID).unwrap().clone(),
            other => panic!("{other:?}"),
        }
    }

    /// A file where the state folder belongs makes every later save fail.
    pub fn break_saves(&self) {
        fs::remove_dir_all(state_dir(&self.data)).unwrap();
        fs::write(state_dir(&self.data), b"").unwrap();
    }

    pub fn unbreak_saves(&self) {
        fs::remove_file(state_dir(&self.data)).unwrap();
    }
}

/// Opens `path` with no sharing, the way a scanner holding a file blocks renames of its folder.
#[cfg(windows)]
pub fn hold(path: &Path) -> fs::File {
    use std::os::windows::fs::OpenOptionsExt;
    fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(path)
        .unwrap()
}
