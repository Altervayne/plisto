/*
 * Starting a native plugin: the checks made under the plugin's lifecycle turn, the launch, a start owed
 * from an earlier refusal, and the restart a user asks for.
 */

// -- Local Imports --
use super::*;
use crate::plugins::summary::read_manifest;

impl NativeHost {
    /// Starts the plugin when it is a serving native plugin whose manifest is the consented one. A
    /// plugin already running, or being started, is left as it is. Refused as `Busy` while another
    /// operation holds the plugin's lifecycle turn.
    pub fn start(&self, plugins: &PluginsState, id: &str) -> Result<(), StartError> {
        self.start_with(plugins, id, false)
    }

    /// `start`; with `fresh`, the plugin's crashes and any due restart are forgotten first, once its
    /// turn is taken, so a refused start forgets nothing.
    pub(super) fn start_with(&self, plugins: &PluginsState, id: &str, fresh: bool) -> Result<(), StartError> {
        if self.exiting.load(Ordering::SeqCst) {
            return Err(StartError::Exiting);
        }
        if self.held.load(Ordering::SeqCst) {
            return Err(StartError::Held);
        }
        let turn = plugins.try_turn(id).ok_or(StartError::Busy)?;
        if fresh {
            self.reset(id);
        }
        self.start_in_turn(plugins, id, turn)
    }

    /// A start the plugin is owed: an enable's, an update's, a boot's or a resume's. One that meets
    /// another operation's turn is kept and tried again on the next tick, never dropped.
    pub(super) fn start_owed(&self, plugins: &PluginsState, id: &str) {
        match self.start_with(plugins, id, true) {
            Ok(()) => {}
            Err(StartError::NotNative) => {
                let background = plugins
                    .enabled_set()
                    .serving(id)
                    .is_some_and(|serving| self.has_background_frame(id, &serving.granted));
                if background {
                    self.board.set_host(id, HostState::Starting, self.clock.now());
                }
            }
            Err(StartError::Busy) => {
                lock(&self.supervision).owed.insert(id.to_string());
            }
            Err(e) => eprintln!("plugins: {id}: not started: {e}"),
        }
    }

    /// `start` with the plugin's turn already taken. Everything from the serving check to the adopted
    /// child runs in the turn, so no update can swap the files between the check and the launch; the
    /// turn ends before the handshake and before any crash policy runs.
    pub(super) fn start_in_turn(
        &self,
        plugins: &PluginsState,
        id: &str,
        turn: Turn<'_>,
    ) -> Result<(), StartError> {
        // A crash-loop disable still owed keeps the plugin off for the session, saved or not.
        if lock(&self.supervision).owed_disables.contains_key(id) {
            return Err(StartError::NotServing);
        }
        let serving = plugins
            .enabled_set()
            .serving(id)
            .ok_or(StartError::NotServing)?;
        if serving.tier != Tier::Native {
            return Err(StartError::NotNative);
        }
        // Reserved before anything is read or launched, so a second start of the same id meanwhile
        // finds it taken and never runs the plugin's code twice.
        let Some(run) = self.reserve(id) else {
            if self.exiting.load(Ordering::SeqCst) {
                return Err(StartError::Exiting);
            }
            if self.held.load(Ordering::SeqCst) {
                return Err(StartError::Held);
            }
            return Ok(());
        };
        let mut spec = match self.prepare(plugins, id) {
            Ok(spec) => spec,
            Err(e) => {
                let reason = match e {
                    StartError::Invalid(_) => Some(FailReason::Invalid),
                    StartError::Changed => Some(FailReason::Changed),
                    _ => None,
                };
                self.end_reservation(id, &run, reason.map(|reason| HostState::Failed { reason }));
                return Err(e);
            }
        };
        if !self.set_host_if_ours(id, &run, HostState::Starting) {
            return Ok(());
        }
        // Every way out of this function that does not leave the child running detaches it again.
        spec.tap = run
            .feed
            .attach(self.link.as_ref(), id, FeedGrant::of(&serving.granted));
        let child = match Child::spawn(id, &spec) {
            Ok(child) => Arc::new(child),
            Err(e) => {
                // The crash policy can turn the plugin off, which takes the turn.
                drop(turn);
                run.feed.detach(self.link.as_ref());
                if launch_denied(&e) {
                    let denied = HostState::Failed {
                        reason: FailReason::LaunchDenied,
                    };
                    self.end_reservation(id, &run, Some(denied));
                } else if self.end_reservation(id, &run, None) {
                    plugins.api().forget_run(id);
                    self.run_policy(id, self.crash_info(CrashReason::Launch, None));
                }
                return Err(StartError::Launch(e));
            }
        };
        if !self.adopt(id, &run, child.clone()) {
            run.feed.detach(self.link.as_ref());
            child.kill();
            return Ok(());
        }
        if !plugins.is_enabled(id) {
            self.stop_plugin(id);
            return Err(StartError::NotServing);
        }
        drop(turn);
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
        let host = self.clone();
        let owned = id.to_string();
        if let Err(e) = thread::Builder::new()
            .name(format!("plugin-pump-{id}"))
            .spawn(move || pump::run(&host, &owned, &run, &child, &hello))
        {
            self.stop_plugin(id);
            return Err(StartError::Launch(e));
        }
        Ok(())
    }

    /// Checks the folder against the consented manifest and builds the launch.
    pub(super) fn prepare(&self, plugins: &PluginsState, id: &str) -> Result<LaunchSpec, StartError> {
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
        let exe = manifest
            .entry
            .as_deref()
            .ok_or_else(|| StartError::Invalid("the manifest names no entry".to_string()))?;
        Ok(LaunchSpec {
            exe: entry_path(&dir, exe),
            plugin_dir: dir,
            data_dir: data_dir(&self.app_data, id),
            tap: None,
        })
    }

    /// Starts every serving native plugin, and marks every serving background frame as starting.
    /// Failures are logged per plugin. Reads each plugin folder, so it belongs off the setup thread.
    pub fn start_serving(&self, plugins: &PluginsState) {
        for (id, serving) in plugins.snapshot().serving() {
            if serving.tier == Tier::Native {
                match self.start(plugins, &id) {
                    Ok(()) => {}
                    Err(StartError::Busy) => {
                        lock(&self.supervision).owed.insert(id.clone());
                    }
                    Err(e) => eprintln!("plugins: {id}: not started: {e}"),
                }
            } else if plugins.is_enabled(&id) && self.has_background_frame(&id, &serving.granted) {
                self.board.set_host(&id, HostState::Starting, self.clock.now());
            }
        }
    }

    /// Whether a UI plugin has a background frame to mount: it holds the background grant and its
    /// manifest names an entry. Without a frame, nothing would ever report it live.
    fn has_background_frame(&self, id: &str, granted: &[Capability]) -> bool {
        is_background(granted)
            && read_manifest(&plugin_dir(&self.app_data, id)).is_some_and(|m| m.entry.is_some())
    }

    /// Forgets the plugin's crashes and any due restart, for a start the user asked for.
    pub(super) fn reset(&self, id: &str) {
        let mut supervision = lock(&self.supervision);
        supervision.policies.remove(id);
        supervision.due.remove(id);
        drop(supervision);
        self.board.clear_crash(id, self.clock.now());
    }

    /// Restarts a serving plugin with a fresh crash count: a native child is stopped and started
    /// again, a UI plugin's frames are told to remount through the `starting` state.
    pub fn restart(&self, plugins: &PluginsState, id: &str) -> Result<(), StartError> {
        let serving = plugins
            .enabled_set()
            .serving(id)
            .ok_or(StartError::NotServing)?;
        if serving.tier == Tier::Native {
            if self.exiting.load(Ordering::SeqCst) {
                return Err(StartError::Exiting);
            }
            if self.held.load(Ordering::SeqCst) {
                return Err(StartError::Held);
            }
            // Taken before the stop, so a restart refused as busy leaves the running child alone.
            let turn = plugins.try_turn(id).ok_or(StartError::Busy)?;
            // The stop restores any output the child held before the status changes. The API is
            // forgotten after the stop, so nothing the old child asked for during its grace outlives
            // it. The page frame stays on screen, so its page slot and network work are kept.
            self.stop_plugin(id);
            self.reset(id);
            plugins.api().forget_run(id);
            return self.start_in_turn(plugins, id, turn);
        }
        self.reset(id);
        self.board.set_host(id, HostState::Starting, self.clock.now());
        Ok(())
    }
}
