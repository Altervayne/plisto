/*
 * The supervisor's step: pings and silence for every running child, due restarts, and the starts and
 * crash-loop disables an earlier step still owes.
 */

// -- Local Imports --
use super::*;

impl NativeHost {
    /// One supervisor step: pings and silence for every running child, due restarts, held statuses.
    pub fn tick(&self) {
        let now = self.clock.now();
        let runs: Vec<(String, Arc<Run>)> = lock(&self.children)
            .iter()
            .map(|(id, run)| (id.clone(), run.clone()))
            .collect();
        for (id, run) in runs {
            // A helper the child started can hold its output open after it exits, so the exit is
            // looked for here too, not only through the end of the output.
            if let Some(child) = run.child.get() {
                if child.wait_exit(Duration::ZERO) {
                    self.end_run(&id, &run, child, CrashReason::Exited);
                    continue;
                }
            }
            let beats = match lock(&run.heartbeat).as_mut() {
                Some(heartbeat) => heartbeat.tick(now),
                None => continue,
            };
            for beat in beats {
                match beat {
                    Beat::Ping(seq) => {
                        // A full outbox skips the ping; the silence then speaks for itself.
                        if let Some(child) = run.child.get() {
                            let _ = child.send(&HostMessage::Ping { seq });
                        }
                    }
                    Beat::WentSilent => self.went_silent(&id, &run),
                    Beat::Recovered | Beat::Nothing => {}
                }
            }
        }
        let due: Vec<String> = {
            let mut supervision = lock(&self.supervision);
            let due: Vec<String> = supervision
                .due
                .iter()
                .filter(|(_, at)| **at <= now)
                .map(|(id, _)| id.clone())
                .collect();
            for id in &due {
                supervision.due.remove(id);
            }
            due
        };
        for id in due {
            self.restart_due(&id);
        }
        self.retry_owed();
        self.board.flush(now);
    }

    /// Records how a crash-loop disable went: one that did not land stays pending, at the next tick
    /// after meeting a turn, or after a growing wait when it could not be saved. The first failed
    /// save is logged; later ones are not.
    pub(super) fn disable_tried(&self, id: &str, outcome: Disabled) {
        let now = self.clock.now();
        let mut supervision = lock(&self.supervision);
        let last = supervision.owed_disables.remove(id).map(|retry| retry.backoff);
        let backoff = match outcome {
            Disabled::Landed => return,
            Disabled::Busy => last.unwrap_or(Duration::ZERO),
            Disabled::Failed => match last {
                Some(wait) if !wait.is_zero() => (wait * 2).min(DISABLE_RETRY_MAX),
                _ => {
                    eprintln!("plugins: {id}: cannot save the crash-loop disable; trying again later");
                    #[cfg(test)]
                    {
                        supervision.disable_failures_logged += 1;
                    }
                    DISABLE_RETRY_FIRST
                }
            },
        };
        let at = if outcome == Disabled::Busy { now } else { now + backoff };
        supervision
            .owed_disables
            .insert(id.to_string(), DisableRetry { at, backoff });
    }

    /// Whether the saved entry still has the plugin enabled and approved. A plugin only withdrawn for
    /// the length of an operation still counts, and while another operation holds the turn the
    /// entry is not judged at all: it may be mid-change.
    pub(super) fn still_owes_disable(&self, id: &str) -> Option<bool> {
        let judged = self.with_plugins(|plugins| {
            drop(plugins.try_turn(id)?);
            Some(plugins.snapshot().entry(id).is_some_and(|e| e.is_serving()))
        });
        // No plugin state at all: nothing is left to disable.
        judged.unwrap_or(Some(false))
    }

    /// Tries every pending crash-loop disable that is due, then every owed start, each again from the
    /// start: a disable is dropped once the saved entry no longer serves, and a start re-checks
    /// everything in its own turn, so a plugin disabled, reset or removed meanwhile drops out. A
    /// start runs on a thread of its own, as a restart does.
    pub(super) fn retry_owed(&self) {
        let now = self.clock.now();
        let (disables, starts) = {
            let mut supervision = lock(&self.supervision);
            let disables: Vec<String> = supervision
                .owed_disables
                .iter()
                .filter(|(_, retry)| retry.at <= now)
                .map(|(id, _)| id.clone())
                .collect();
            let starts: Vec<String> = supervision.owed.drain().collect();
            (disables, starts)
        };
        for id in disables {
            match self.still_owes_disable(&id) {
                // Another operation holds the turn: the next tick looks again.
                None => self.disable_tried(&id, Disabled::Busy),
                Some(false) => {
                    lock(&self.supervision).owed_disables.remove(&id);
                }
                Some(true) => {
                    let outcome = self.link.disable(&id);
                    self.disable_tried(&id, outcome);
                }
            }
        }
        for id in starts {
            if lock(&self.supervision).owed_disables.contains_key(&id) {
                continue;
            }
            let host = self.clone();
            let spawned = thread::Builder::new()
                .name(format!("plugin-start-{id}"))
                .spawn(move || {
                    host.with_plugins(|plugins| host.start_owed(plugins, &id));
                });
            if let Err(e) = spawned {
                eprintln!("plugins: a start owed to a plugin cannot run: {e}");
            }
        }
    }

    /// Fires a restart the crash policy scheduled, if the plugin still serves. A native start reads
    /// the plugin folder and launches a process, so it runs on a thread of its own and never holds
    /// up the pings of other children.
    pub(super) fn restart_due(&self, id: &str) {
        let now = self.clock.now();
        // A plugin waiting to be turned off for its crash loop is never restarted.
        if lock(&self.supervision).owed_disables.contains_key(id) {
            return;
        }
        let target = self
            .with_plugins(|plugins| plugins.enabled_set().serving(id))
            .flatten();
        match target {
            Some(serving) if serving.tier == Tier::Native => {
                let host = self.clone();
                let owned = id.to_string();
                let spawned = thread::Builder::new()
                    .name(format!("plugin-restart-{id}"))
                    .spawn(move || host.restart_native(&owned));
                if let Err(e) = spawned {
                    eprintln!("plugins: {id}: not restarted: {e}");
                    self.board.stopped(id, now);
                }
            }
            Some(serving) if is_background(&serving.granted) => {
                self.board.set_host(id, HostState::Starting, now);
            }
            _ => self.board.stopped(id, now),
        }
    }

    /// Starts a native plugin again after a crash. One that meets another operation's turn stays
    /// due, for the next tick, and keeps its "restarting" status. When it no longer serves or Plisto
    /// is quitting, its status leaves "restarting".
    pub(super) fn restart_native(&self, id: &str) {
        let result = self.with_plugins(|plugins| self.start(plugins, id));
        match result {
            Some(Ok(())) => {}
            Some(Err(StartError::Busy)) => {
                let now = self.clock.now();
                lock(&self.supervision).due.insert(id.to_string(), now);
            }
            None
            | Some(Err(StartError::NotServing | StartError::Exiting | StartError::Held)) => {
                self.board.stopped(id, self.clock.now());
            }
            Some(Err(e)) => eprintln!("plugins: {id}: not restarted: {e}"),
        }
    }
}
