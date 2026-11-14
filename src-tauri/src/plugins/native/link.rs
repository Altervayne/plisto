/*
 * What the native host needs from the app around it: sending events to the main window, turning a
 * plugin off through the lifecycle, commands to the player, the playback feed, and the plugin state.
 * Behind a trait so the supervisor runs in tests without a Tauri app. Events go to the main window
 * only, never into a plugin frame.
 */

// -- Library Imports --
use std::io;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

// -- Local Imports --
use super::status::PluginStatus;
use crate::audio::{self, FeedConsumer, PlayerCmd};
use crate::plugins::lifecycle;
use crate::plugins::state::{BootView, PluginsState};
use crate::state::AppState;

const MAIN_LABEL: &str = "main";
pub const EVENT_STATUS: &str = "plugins:status";
pub const EVENT_NOTICE: &str = "plugins:notice";
pub const EVENT_RUNTIME: &str = "plugins:runtime";
const EVENT_CHANGED: &str = "plugins:changed";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NoticeKind {
    /// Turned off after repeated crashes.
    AutoDisabled,
}

/// Plisto's own notice about a plugin, shown as Plisto's toast, not the plugin's.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Notice {
    pub id: String,
    pub kind: NoticeKind,
}

pub trait HostLink: Send + Sync {
    fn emit_status(&self, status: &PluginStatus);
    fn emit_notice(&self, notice: &Notice);
    fn emit_runtime(&self, view: BootView);
    /// Disables the plugin as the user would: saved, and the main window told.
    fn disable(&self, id: &str);
    /// Queues a command for the player without waiting.
    fn player(&self, cmd: PlayerCmd);
    /// Attaches a playback feed consumer; with `tap`, one that reads the tap.
    fn attach_feed(&self, tap: bool) -> io::Result<FeedConsumer>;
    fn detach_feed(&self, consumer: u64);
    /// Runs `f` on the plugin state; not at all when the app has none.
    fn with_plugins(&self, f: &mut dyn FnMut(&PluginsState));
}

pub struct TauriLink {
    app: AppHandle,
}

impl TauriLink {
    pub fn new(app: AppHandle) -> TauriLink {
        TauriLink { app }
    }
}

impl HostLink for TauriLink {
    fn emit_status(&self, status: &PluginStatus) {
        let _ = self.app.emit_to(MAIN_LABEL, EVENT_STATUS, status);
    }

    fn emit_notice(&self, notice: &Notice) {
        let _ = self.app.emit_to(MAIN_LABEL, EVENT_NOTICE, notice);
    }

    fn emit_runtime(&self, view: BootView) {
        let _ = self.app.emit_to(MAIN_LABEL, EVENT_RUNTIME, view);
    }

    fn disable(&self, id: &str) {
        let Ok(app_data) = self.app.path().app_data_dir() else {
            return;
        };
        let Some(state) = self.app.try_state::<AppState>() else {
            return;
        };
        match lifecycle::disable(&app_data, &state.plugins, id) {
            Ok(_) => {
                let _ = self.app.emit_to(MAIN_LABEL, EVENT_CHANGED, ());
            }
            Err(e) => eprintln!("plugins: {id}: cannot turn off after repeated crashes: {e}"),
        }
    }

    fn player(&self, cmd: PlayerCmd) {
        if let Some(state) = self.app.try_state::<AppState>() {
            let _ = state.player.send(cmd);
        }
    }

    fn attach_feed(&self, tap: bool) -> io::Result<FeedConsumer> {
        audio::attach_feed_consumer(tap)
    }

    fn detach_feed(&self, consumer: u64) {
        audio::detach_feed_consumer(consumer);
    }

    fn with_plugins(&self, f: &mut dyn FnMut(&PluginsState)) {
        if let Some(state) = self.app.try_state::<AppState>() {
            f(&state.plugins);
        }
    }
}

/// A link for tests: records every event, disable, player command and feed attach and detach, and
/// reaches a plugin state when given one. Its feed hub is its own, so tests running side by side
/// never see each other's consumers.
#[cfg(test)]
#[derive(Default)]
pub(crate) struct RecordingLink {
    statuses: std::sync::Mutex<Vec<PluginStatus>>,
    notices: std::sync::Mutex<Vec<Notice>>,
    runtimes: std::sync::Mutex<Vec<BootView>>,
    disabled: std::sync::Mutex<Vec<String>>,
    plugins: std::sync::Mutex<Option<(std::sync::Weak<PluginsState>, std::path::PathBuf)>>,
    player: std::sync::Mutex<Vec<PlayerCmd>>,
    feed: audio::FeedHub,
    attached: std::sync::Mutex<Vec<u64>>,
    detached: std::sync::Mutex<Vec<u64>>,
}

#[cfg(test)]
impl RecordingLink {
    /// Reaches `plugins`, booted from `app_data`; a disable goes through the real lifecycle.
    pub fn attach(&self, plugins: &std::sync::Arc<PluginsState>, app_data: &std::path::Path) {
        *self.plugins.lock().unwrap() =
            Some((std::sync::Arc::downgrade(plugins), app_data.to_path_buf()));
    }

    pub fn statuses(&self) -> Vec<PluginStatus> {
        self.statuses.lock().unwrap().clone()
    }

    pub fn notices(&self) -> Vec<Notice> {
        self.notices.lock().unwrap().clone()
    }

    pub fn runtimes(&self) -> Vec<BootView> {
        self.runtimes.lock().unwrap().clone()
    }

    pub fn disabled(&self) -> Vec<String> {
        self.disabled.lock().unwrap().clone()
    }

    pub fn feed_hub(&self) -> &audio::FeedHub {
        &self.feed
    }

    pub fn snapshot_requests(&self) -> usize {
        let player = self.player.lock().unwrap();
        player
            .iter()
            .filter(|cmd| matches!(cmd, PlayerCmd::FeedSnapshot))
            .count()
    }

    /// Feed consumers attached, then detached, in order.
    pub fn feed_consumers(&self) -> (Vec<u64>, Vec<u64>) {
        (
            self.attached.lock().unwrap().clone(),
            self.detached.lock().unwrap().clone(),
        )
    }

    fn attached(&self) -> Option<(std::sync::Arc<PluginsState>, std::path::PathBuf)> {
        let held = self.plugins.lock().unwrap();
        let (weak, data) = held.as_ref()?;
        Some((weak.upgrade()?, data.clone()))
    }
}

#[cfg(test)]
impl HostLink for RecordingLink {
    fn emit_status(&self, status: &PluginStatus) {
        self.statuses.lock().unwrap().push(status.clone());
    }

    fn emit_notice(&self, notice: &Notice) {
        self.notices.lock().unwrap().push(notice.clone());
    }

    fn emit_runtime(&self, view: BootView) {
        self.runtimes.lock().unwrap().push(view);
    }

    fn disable(&self, id: &str) {
        self.disabled.lock().unwrap().push(id.to_string());
        if let Some((plugins, data)) = self.attached() {
            lifecycle::disable(&data, &plugins, id).unwrap();
        }
    }

    fn player(&self, cmd: PlayerCmd) {
        self.player.lock().unwrap().push(cmd);
    }

    fn attach_feed(&self, tap: bool) -> io::Result<FeedConsumer> {
        let consumer = self.feed.attach(tap)?;
        self.attached.lock().unwrap().push(consumer.id);
        Ok(consumer)
    }

    fn detach_feed(&self, consumer: u64) {
        self.detached.lock().unwrap().push(consumer);
        self.feed.detach(consumer);
    }

    fn with_plugins(&self, f: &mut dyn FnMut(&PluginsState)) {
        if let Some((plugins, _)) = self.attached() {
            f(&plugins);
        }
    }
}
