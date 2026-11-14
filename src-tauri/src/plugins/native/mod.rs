/*
 * The native plugin host: starts an enabled native plugin as a child process and stops it. Each child
 * runs in its own kill-on-close job, so no plugin process outlives Plisto, however Plisto ends. A
 * start returns once the process runs; the handshake finishes on a thread of its own, so no command
 * waits on a plugin. Start and stop both read the serving set themselves, because a disable can race
 * an enable: a child that lands after its plugin was disabled is stopped again at once.
 */

mod child;
mod job;
mod launch;
mod protocol;
#[cfg(test)]
mod test_child;
#[cfg(test)]
mod tests;

// -- Library Imports --
use std::collections::HashMap;
use std::io;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::Duration;

// -- Local Imports --
use super::manifest::Tier;
use super::paths::{data_dir, plugin_dir};
use super::revalidate::check_folder;
use super::session::BootState;
use super::state::{PluginsState, Starter, Stopper};
use child::{Child, Stopped};
use launch::{entry_path, LaunchSpec};
use protocol::{HostMessage, API_VERSION, PROTOCOL_VERSION};

/// A first launch can sit behind an antivirus scan, so `ready` gets this long.
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a child has to exit after `shutdown` before it is killed.
pub const STOP_GRACE: Duration = Duration::from_secs(2);

#[derive(Debug)]
pub enum StartError {
    /// Not enabled and ready.
    NotServing,
    NotNative,
    /// The folder no longer validates.
    Invalid(String),
    /// `plugin.json` is not the one consent was given on.
    Changed,
    Launch(io::Error),
}

impl std::fmt::Display for StartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StartError::NotServing => f.write_str("not enabled"),
            StartError::NotNative => f.write_str("not a native plugin"),
            StartError::Invalid(why) => write!(f, "folder does not validate: {why}"),
            StartError::Changed => f.write_str("plugin.json changed since consent"),
            StartError::Launch(e) => write!(f, "cannot launch: {e}"),
        }
    }
}

type Children = Arc<Mutex<HashMap<String, Arc<Child>>>>;

pub struct NativeHost {
    app_data: PathBuf,
    children: Children,
}

fn lock(children: &Children) -> MutexGuard<'_, HashMap<String, Arc<Child>>> {
    children.lock().unwrap_or_else(PoisonError::into_inner)
}

impl NativeHost {
    pub fn new(app_data: PathBuf) -> NativeHost {
        NativeHost {
            app_data,
            children: Arc::default(),
        }
    }

    pub fn is_running(&self, id: &str) -> bool {
        lock(&self.children).contains_key(id)
    }

    /// Starts the plugin when it is a serving native plugin whose manifest is the consented one. A
    /// plugin already running is left as it is.
    pub fn start(&self, plugins: &PluginsState, id: &str) -> Result<(), StartError> {
        let serving = plugins
            .enabled_set()
            .serving(id)
            .ok_or(StartError::NotServing)?;
        if serving.tier != Tier::Native {
            return Err(StartError::NotNative);
        }
        if self.is_running(id) {
            return Ok(());
        }
        let entry = plugins
            .snapshot()
            .entry(id)
            .cloned()
            .ok_or(StartError::NotServing)?;
        let dir = plugin_dir(&self.app_data, id);
        let (manifest, hash) =
            check_folder(&dir, Some(id)).map_err(|e| StartError::Invalid(e.to_string()))?;
        if hash != entry.manifest_hash {
            return Err(StartError::Changed);
        }
        let spec = LaunchSpec {
            exe: entry_path(&dir, &manifest.entry),
            plugin_dir: dir,
            data_dir: data_dir(&self.app_data, id),
            tap: None,
        };
        let child = Arc::new(Child::spawn(id, &spec).map_err(StartError::Launch)?);
        if !self.adopt(id, child.clone()) {
            child.kill();
            return Ok(());
        }
        if !plugins.is_enabled(id) {
            self.stop_plugin(id);
            return Err(StartError::NotServing);
        }
        let hello = HostMessage::Hello {
            protocol: PROTOCOL_VERSION,
            api_version: API_VERSION,
            plisto_version: env!("CARGO_PKG_VERSION").to_string(),
            id: id.to_string(),
            granted: serving
                .granted
                .iter()
                .map(|c| c.as_str().to_string())
                .collect(),
        };
        let children = self.children.clone();
        let settle = move || settle(&children, child, &hello);
        if let Err(e) = thread::Builder::new()
            .name(format!("plugin-start-{id}"))
            .spawn(settle)
        {
            self.stop_plugin(id);
            return Err(StartError::Launch(e));
        }
        Ok(())
    }

    /// Starts every serving native plugin when the boot allows it. Returns whether it did. Reads each
    /// plugin folder, so it belongs off the setup thread.
    pub fn start_at_boot(&self, plugins: &PluginsState) -> bool {
        let allowed = boot_allows_start(plugins.boot_state());
        if allowed {
            self.start_serving(plugins);
        }
        allowed
    }

    /// Starts every serving native plugin. Failures are logged per plugin.
    pub fn start_serving(&self, plugins: &PluginsState) {
        for (id, serving) in plugins.snapshot().serving() {
            if serving.tier == Tier::Native {
                if let Err(e) = self.start(plugins, &id) {
                    eprintln!("plugins: {id}: not started: {e}");
                }
            }
        }
    }

    /// Stops the plugin's child, if one runs: `shutdown`, the grace period, then a kill.
    pub fn stop_plugin(&self, id: &str) {
        let child = lock(&self.children).remove(id);
        if let Some(child) = child {
            if child.stop(STOP_GRACE) == Stopped::Killed {
                eprintln!("plugins: {id}: killed after the shutdown grace");
            }
        }
    }

    /// Stops every child at once, all within one grace period, and returns when every process is
    /// gone. For app exit and for anything that replaces the running binary.
    pub fn shutdown_all(&self) {
        let all: Vec<Arc<Child>> = lock(&self.children).drain().map(|(_, c)| c).collect();
        thread::scope(|scope| {
            for child in &all {
                scope.spawn(move || child.stop(STOP_GRACE));
            }
        });
    }

    /// Records a launched child. False when another start of the same id got there first.
    fn adopt(&self, id: &str, child: Arc<Child>) -> bool {
        let mut children = lock(&self.children);
        if children.contains_key(id) {
            return false;
        }
        children.insert(id.to_string(), child);
        true
    }
}

/// Whether native plugins start with the app: never in safe mode, and not after an unclean exit,
/// which holds every start until the user chooses how to boot.
pub fn boot_allows_start(boot: BootState) -> bool {
    !boot.safe_mode && !boot.unclean
}

/// Runs the handshake. A child that fails it is removed and killed, unless a stop already took it.
/// After `ready`, incoming messages are drained and dropped until something consumes them, so a
/// child that talks never stalls on a full inbox.
fn settle(children: &Children, child: Arc<Child>, hello: &HostMessage) {
    match child.handshake(hello, HANDSHAKE_TIMEOUT) {
        Ok(()) => {
            let inbox = child.inbox();
            drop(child);
            inbox.discard();
        }
        Err(e) => {
            eprintln!("plugins: {}: handshake failed: {e}", child.id());
            let mut map = lock(children);
            let ours = map
                .get(child.id())
                .is_some_and(|held| Arc::ptr_eq(held, &child));
            if ours {
                map.remove(child.id());
            }
            drop(map);
            child.kill();
        }
    }
}

impl Stopper for NativeHost {
    fn stop(&self, id: &str) {
        self.stop_plugin(id);
    }
}

impl Starter for NativeHost {
    fn start(&self, plugins: &PluginsState, id: &str) {
        match NativeHost::start(self, plugins, id) {
            Ok(()) | Err(StartError::NotNative) => {}
            Err(e) => eprintln!("plugins: {id}: not started: {e}"),
        }
    }
}
