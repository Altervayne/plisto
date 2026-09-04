/*
 * Burst intake for OS file-opens. Windows launches Plisto once per file on a multi-select (a %1
 * association), so opening N files arrives as one cold launch plus N-1 single-instance forwards, each a
 * separate process hop landing here at its own moment. Left alone, every forward would replace the queue
 * and only the last file would play. This gathers the burst into one debounced batch instead: each push
 * appends its files and re-arms a short timer, and the whole accumulation plays as a single queue once the
 * launches stop arriving. The cold-launch setup and the single-instance callback both push here.
 *
 * The buffer is a GLOBAL, not a field on AppState, and that is load-bearing: a multi-select's sibling
 * launches forward within milliseconds, so a forward's `push` routinely runs while the cold instance is
 * still inside `setup()`, BEFORE `app.manage(AppState)`. Reading managed state there would panic and crash
 * the process (the white-then-close a multi-open showed). So `push` touches no managed state at all; only
 * the delayed play - which fires after the debounce, well past setup - reads AppState, and guards it.
 */

// -- Library Imports --
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager};

// -- Local Imports --
use crate::audio::PlayerNotice;
use crate::state::AppState;

/// How long to wait for more file-opens before playing the batch. Long enough to catch the sibling
/// launches a multi-select fans out, short enough that a lone open still plays promptly.
const DEBOUNCE: Duration = Duration::from_millis(300);

/// The burst buffer: the files gathered so far and a generation stamp. Each push appends and bumps the
/// stamp, arming its own timer; only the timer whose stamp still matches at wake plays the batch, so the
/// last push in a burst wins and every earlier timer bows out.
struct Intake {
    paths: Vec<String>,
    generation: u64,
}

impl Intake {
    /// A const empty buffer, so it can back a `static` without a lazy initializer.
    const fn new() -> Self {
        Intake {
            paths: Vec::new(),
            generation: 0,
        }
    }

    /// Appends `paths` and stamps a fresh generation, returned so the arming timer can tell whether it is
    /// still the latest when it wakes.
    fn arm(&mut self, paths: Vec<String>) -> u64 {
        self.paths.extend(paths);
        self.generation = self.generation.wrapping_add(1);
        self.generation
    }

    /// Drains the whole burst when `generation` is still the latest, else leaves it for the timer that is.
    /// A superseded timer gets None, so only the last arm of a burst ever plays.
    fn take_if_latest(&mut self, generation: u64) -> Option<Vec<String>> {
        if self.generation != generation {
            return None;
        }
        Some(std::mem::take(&mut self.paths))
    }
}

/// The process-wide burst buffer. Global rather than on AppState so an early single-instance forward never
/// touches unmanaged state (see the module note): the forwards of a cold multi-select land here while the
/// first instance is still in setup.
static INTAKE: Mutex<Intake> = Mutex::new(Intake::new());

/// Adds `paths` to the pending burst and arms the debounce. Called from the cold-launch setup and the
/// single-instance forward, both of which carry the OS-delivered files. An empty set is ignored, so a
/// bare relaunch never arms a timer. Touches no managed state, so it is safe before `app.manage`.
pub fn push(app: &AppHandle, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    let generation = {
        let mut intake = match INTAKE.lock() {
            Ok(intake) => intake,
            Err(_) => return,
        };
        intake.arm(paths)
    };

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Wait off a runtime worker so the debounce never blocks a task. A fresh push arms a new
        // generation meanwhile, leaving this timer stale.
        let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(DEBOUNCE)).await;

        let batch = {
            let mut intake = match INTAKE.lock() {
                Ok(intake) => intake,
                Err(_) => return,
            };
            match intake.take_if_latest(generation) {
                Some(batch) => batch,
                None => return,
            }
        };
        if batch.is_empty() {
            return;
        }

        // The debounce outlasts setup, so managed state is up by now; guard anyway so a play never panics
        // on it. Play the whole burst as one queue. An all-unreadable open latches a notice so the
        // standalone shell can show its refusal body even when the file error fired before the webview
        // subscribed.
        if app.try_state::<AppState>().is_none() {
            return;
        }
        if crate::commands::player::play_files(&app, batch).await.is_err() {
            if let Some(state) = app.try_state::<AppState>() {
                if let Ok(mut slot) = state.startup_error.lock() {
                    *slot = Some(PlayerNotice::File);
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_lone_arm_drains_its_own_files() {
        let mut intake = Intake::new();
        let gen = intake.arm(paths(&["a.mp3"]));
        assert_eq!(intake.take_if_latest(gen), Some(paths(&["a.mp3"])));
    }

    #[test]
    fn a_second_arm_collapses_the_burst_into_one_batch() {
        // Two opens land before either timer wakes: the first timer is superseded and bows out, the
        // second drains both files as one queue - the multi-select collapse.
        let mut intake = Intake::new();
        let first = intake.arm(paths(&["a.mp3"]));
        let second = intake.arm(paths(&["b.flac"]));
        assert_eq!(intake.take_if_latest(first), None, "the superseded timer plays nothing");
        assert_eq!(
            intake.take_if_latest(second),
            Some(paths(&["a.mp3", "b.flac"])),
            "the latest timer plays the whole burst in arrival order",
        );
    }

    #[test]
    fn a_drained_burst_leaves_the_buffer_empty() {
        // A later open after the batch played is its own burst, never replaying the drained files.
        let mut intake = Intake::new();
        let gen = intake.arm(paths(&["a.mp3"]));
        let _ = intake.take_if_latest(gen);
        let next = intake.arm(paths(&["b.flac"]));
        assert_eq!(intake.take_if_latest(next), Some(paths(&["b.flac"])));
    }
}
