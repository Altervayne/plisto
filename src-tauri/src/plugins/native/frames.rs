/*
 * Supervision of a UI plugin's frames, from what the main window reports about them. A background
 * frame is supervised like a native child: its crashes go through the crash policy, and a due restart
 * sets it `starting`, which the window takes as the cue to remount it. A page frame is not: a crash
 * leaves it stopped until the user restarts it. Events for an id that is not a serving UI plugin are
 * ignored, native ones included.
 */

// -- Local Imports --
use super::status::{CrashReason, HostState};
use super::{is_background, lock, NativeHost};
use crate::plugins::manifest::Tier;
use crate::plugins::state::PluginsState;

/// The crash reasons a frame may report.
fn frame_reason(reason: Option<&str>) -> Option<CrashReason> {
    match reason? {
        "silent" => Some(CrashReason::Silent),
        "navigated" => Some(CrashReason::Navigated),
        "init" => Some(CrashReason::Init),
        _ => None,
    }
}

impl NativeHost {
    /// Applies a frame report: `live`, `not_responding`, `crashed` with its reason, or `detached`. Any
    /// other kind, and a crash without a known reason, changes nothing.
    pub fn frame_event(&self, plugins: &PluginsState, id: &str, kind: &str, reason: Option<&str>) {
        let Some(serving) = plugins.enabled_set().serving(id) else {
            return;
        };
        if serving.tier != Tier::Ui {
            return;
        }
        let background = is_background(&serving.granted);
        let now = self.clock.now();
        match kind {
            "live" => {
                self.board.set_host(id, HostState::Running, now);
                if background {
                    lock(&self.supervision)
                        .policies
                        .entry(id.to_string())
                        .or_default()
                        .on_running(now);
                }
            }
            "not_responding" => self.board.set_host(id, HostState::NotResponding, now),
            "crashed" => {
                let Some(reason) = frame_reason(reason) else {
                    return;
                };
                let crash = self.crash_info(reason, None);
                if background {
                    self.run_policy(id, crash);
                } else {
                    self.board.crashed(id, HostState::Stopped, crash, now);
                }
            }
            "detached" => self.board.set_host(id, HostState::Off, now),
            _ => {}
        }
    }
}
