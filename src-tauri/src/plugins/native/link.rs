/*
 * What the native host needs from the app around it: sending events to the main window, turning a
 * plugin off through the lifecycle, commands to the player, the playback feed, the plugin state, and
 * the app as the plugin API sees it for a child's calls.
 * Behind a trait so the supervisor runs in tests without a Tauri app. Events go to the main window
 * only, never into a plugin frame.
 */

// -- Library Imports --
use std::io;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

// -- Local Imports --
use super::status::PluginStatus;
use crate::audio::{self, FeedConsumer, PlayerCmd};
use crate::plugins::api::tauri_host::TauriHost;
use crate::plugins::api::HostContext;
use crate::plugins::install_error::{ErrorCode, InstallError};
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

/// How a disable through the lifecycle went.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Disabled {
    /// Saved, or there is nothing left to disable.
    Landed,
    /// Another operation holds the plugin's turn.
    Busy,
    /// Refused otherwise, a failed save among them.
    Failed,
}

impl Disabled {
    fn of(outcome: Result<(), InstallError>) -> Disabled {
        match outcome {
            Ok(()) => Disabled::Landed,
            Err(e) if e.code == ErrorCode::Busy => Disabled::Busy,
            Err(_) => Disabled::Failed,
        }
    }
}

pub trait HostLink: Send + Sync {
    fn emit_status(&self, status: &PluginStatus);
    fn emit_notice(&self, notice: &Notice);
    fn emit_runtime(&self, view: BootView);
    /// Disables the plugin as the user would: saved, and the main window told.
    fn disable(&self, id: &str) -> Disabled;
    /// Queues a command for the player without waiting.
    fn player(&self, cmd: PlayerCmd);
    /// Attaches a playback feed consumer; with `tap`, one that reads the tap.
    fn attach_feed(&self, tap: bool) -> io::Result<FeedConsumer>;
    fn detach_feed(&self, consumer: u64);
    /// Runs `f` on the plugin state; not at all when the app has none.
    fn with_plugins(&self, f: &mut dyn FnMut(&PluginsState));
    /// The app as a plugin method sees it, for the calls a child makes.
    fn api_host(&self) -> Arc<dyn HostContext>;
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

    fn disable(&self, id: &str) -> Disabled {
        // Without app data or state there is nothing to disable, and nothing to try again.
        let Ok(app_data) = self.app.path().app_data_dir() else {
            return Disabled::Landed;
        };
        let Some(state) = self.app.try_state::<AppState>() else {
            return Disabled::Landed;
        };
        let outcome = lifecycle::disable(&app_data, &state.plugins, id);
        if outcome.is_ok() {
            let _ = self.app.emit_to(MAIN_LABEL, EVENT_CHANGED, ());
        }
        Disabled::of(outcome.map(|_| ()))
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

    fn api_host(&self) -> Arc<dyn HostContext> {
        Arc::new(TauriHost::new(self.app.clone()))
    }
}

/// A link for tests: records every event, disable, player command and feed attach and detach, and
/// reaches a plugin state when given one. Its feed hub is its own, so tests running side by side
/// never see each other's consumers. A child's calls see a fake app that records what they emit.
#[cfg(test)]
#[derive(Default)]
pub(crate) struct RecordingLink {
    api_host: Arc<crate::plugins::api::FakeHost>,
    statuses: std::sync::Mutex<Vec<PluginStatus>>,
    notices: std::sync::Mutex<Vec<Notice>>,
    runtimes: std::sync::Mutex<Vec<BootView>>,
    disabled: std::sync::Mutex<Vec<String>>,
    disable_attempts: std::sync::Mutex<usize>,
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

    /// Every disable tried, landed or not.
    pub fn disable_attempts(&self) -> usize {
        *self.disable_attempts.lock().unwrap()
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

    /// The events a child's calls and page events sent to the main window.
    pub fn api_events(&self) -> Vec<crate::plugins::api::host_event::HostEvent> {
        self.api_host.events.lock().unwrap().clone()
    }

    pub fn snapshot_requests(&self) -> usize {
        let player = self.player.lock().unwrap();
        player
            .iter()
            .filter(|cmd| matches!(cmd, PlayerCmd::FeedSnapshot))
            .count()
    }

    /// Every output takeover command, in order: true mutes, false restores.
    pub fn takeovers(&self) -> Vec<bool> {
        let player = self.player.lock().unwrap();
        player
            .iter()
            .filter_map(|cmd| match cmd {
                PlayerCmd::SetOutputTakeover(on) => Some(*on),
                _ => None,
            })
            .collect()
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

    /// Records each attempt, and each disable that landed.
    fn disable(&self, id: &str) -> Disabled {
        *self.disable_attempts.lock().unwrap() += 1;
        if let Some((plugins, data)) = self.attached() {
            let outcome = Disabled::of(lifecycle::disable(&data, &plugins, id).map(|_| ()));
            if outcome != Disabled::Landed {
                return outcome;
            }
        }
        self.disabled.lock().unwrap().push(id.to_string());
        Disabled::Landed
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

    fn api_host(&self) -> Arc<dyn HostContext> {
        self.api_host.clone()
    }
}
