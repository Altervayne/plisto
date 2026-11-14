/*
 * Output takeover: which plugin, if any, holds Plisto's output, and the one road to muting and
 * restoring it. Every release sends the restore to the engine before anything else changes, so no
 * later step of a release can leave Plisto silent; a poisoned lock still restores. The holder lives in
 * memory only, so nothing is held after a restart.
 * The host side takes the hub under the `children` lock, so a grant and the end of the run that asked
 * for it never interleave: either the grant lands first and the end of the run releases it, or the run
 * is already gone and the grant is refused. The hub's own lock is a leaf: nothing is sent to a child and
 * no status changes while it is held.
 */

// -- Library Imports --
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

// -- Local Imports --
use super::link::HostLink;
use super::protocol::{HostMessage, TakeoverReason};
use super::pump::bump;
use super::status::HostState;
use super::{lock, NativeHost, Run};
use crate::audio::PlayerCmd;
use crate::plugins::manifest::Capability;
use crate::plugins::state::Runtime;

/// The engine as the hub reaches it.
pub trait PlayerLink: Send + Sync {
    fn player(&self, cmd: PlayerCmd);
}

/// The engine through the host link, the same road every other player command takes.
pub struct ThroughLink(pub Arc<dyn HostLink>);

impl PlayerLink for ThroughLink {
    fn player(&self, cmd: PlayerCmd) {
        self.0.player(cmd);
    }
}

pub struct TakeoverHub {
    holder: Mutex<Option<String>>,
    player: Arc<dyn PlayerLink>,
}

impl TakeoverHub {
    pub fn new(player: Arc<dyn PlayerLink>) -> TakeoverHub {
        TakeoverHub {
            holder: Mutex::new(None),
            player,
        }
    }

    /// Answers a plugin's `takeover`. A hold needs the capability granted and the plugin and the
    /// runtime running, and no other holder; otherwise nothing changes, except that a holder no longer
    /// allowed to hold loses the output. Asking again while holding is granted without a second
    /// command. Giving back what it does not hold changes nothing.
    pub fn request(&self, id: &str, hold: bool, granted: bool, running: bool) -> TakeoverReason {
        if !hold {
            self.release(id, TakeoverReason::Released);
            return TakeoverReason::Released;
        }
        let mut holder = lock(&self.holder);
        if !granted || !running {
            // A holder that may no longer hold loses the output now, so its `held: false` is true.
            if holder.as_deref() == Some(id) {
                self.player.player(PlayerCmd::SetOutputTakeover(false));
                *holder = None;
                eprintln!("plugins: {id}: output given back (Denied)");
            }
            return TakeoverReason::Denied;
        }
        match holder.as_deref() {
            Some(held) if held == id => TakeoverReason::Granted,
            Some(_) => TakeoverReason::Busy,
            None => {
                self.player.player(PlayerCmd::SetOutputTakeover(true));
                *holder = Some(id.to_string());
                eprintln!("plugins: {id}: holds the output");
                TakeoverReason::Granted
            }
        }
    }

    /// Restores the output when `id` holds it. True when it did.
    pub fn release(&self, id: &str, why: TakeoverReason) -> bool {
        let mut holder = lock(&self.holder);
        if holder.as_deref() != Some(id) {
            return false;
        }
        self.player.player(PlayerCmd::SetOutputTakeover(false));
        *holder = None;
        eprintln!("plugins: {id}: output given back ({why:?})");
        true
    }

    /// Restores the output from whichever plugin holds it, and returns that plugin.
    pub fn release_any(&self, why: TakeoverReason) -> Option<String> {
        let mut holder = lock(&self.holder);
        holder.as_ref()?;
        self.player.player(PlayerCmd::SetOutputTakeover(false));
        let id = holder.take();
        eprintln!(
            "plugins: {}: output given back ({why:?})",
            id.as_deref().unwrap_or("")
        );
        id
    }

    #[cfg(test)]
    pub fn holder(&self) -> Option<String> {
        lock(&self.holder).clone()
    }
}

impl NativeHost {
    /// Answers a `takeover` frame from `run`, and tells its child the outcome. A run that is no longer
    /// the plugin's current one, or is ending, changes nothing.
    pub(super) fn takeover(&self, id: &str, run: &Arc<Run>, hold: bool) -> TakeoverReason {
        let (granted, runtime_running) = self
            .with_plugins(|plugins| {
                let granted = plugins.enabled_set().serving(id).is_some_and(|serving| {
                    serving.granted.contains(&Capability::AudioOutputTakeover)
                });
                (granted, plugins.runtime() == Runtime::Running)
            })
            .unwrap_or((false, false));
        let children = lock(&self.children);
        let current = Self::is_current(&children, id, run) && !run.ending.load(Ordering::SeqCst);
        let reason = if current {
            let running = runtime_running && self.board.host(id) == Some(HostState::Running);
            self.takeover.request(id, hold, granted, running)
        } else if hold {
            TakeoverReason::Denied
        } else {
            TakeoverReason::Released
        };
        let held = reason == TakeoverReason::Granted;
        if held {
            self.board.took_over(id, self.clock.now());
        } else if current && reason == TakeoverReason::Released {
            self.board.gave_back(id, None, self.clock.now());
        } else if current && reason == TakeoverReason::Denied {
            // Changes the status only when the request took the output from this holder.
            self.board.gave_back(id, Some(reason), self.clock.now());
        }
        self.tell_takeover(run, held, reason);
        reason
    }

    /// Restores the output from whichever plugin holds it, for a host-side reason. True when one did.
    pub fn release_takeover(&self, why: TakeoverReason) -> bool {
        let children = lock(&self.children);
        self.give_back_any(why, &children).is_some()
    }

    /// Restores the output when `id` holds it, then records the release on its status and tells
    /// `run`'s child when given. Called with `children` held.
    pub(super) fn give_back(&self, id: &str, why: TakeoverReason, run: Option<&Run>) -> bool {
        if !self.takeover.release(id, why) {
            return false;
        }
        self.board.gave_back(id, Some(why), self.clock.now());
        if let Some(run) = run {
            self.tell_takeover(run, false, why);
        }
        true
    }

    /// `give_back` for whichever plugin holds the output; its child is found in `children`, which the
    /// caller holds.
    pub(super) fn give_back_any(
        &self,
        why: TakeoverReason,
        children: &HashMap<String, Arc<Run>>,
    ) -> Option<String> {
        let id = self.takeover.release_any(why)?;
        self.board.gave_back(&id, Some(why), self.clock.now());
        if let Some(run) = children.get(&id) {
            self.tell_takeover(run, false, why);
        }
        Some(id)
    }

    /// Sends the child its takeover state. One the outbox has no room for is owed and sent after the
    /// next valid pong; so is a release for silence, which the child hears again once it answers.
    fn tell_takeover(&self, run: &Run, held: bool, reason: TakeoverReason) {
        let Some(child) = run.child.get() else {
            return;
        };
        let sent = child
            .send(&HostMessage::TakeoverState { held, reason })
            .is_ok();
        if !sent {
            bump(&run.stats.takeover_dropped);
        }
        let owed = !sent || reason == TakeoverReason::NotResponding;
        *lock(&run.takeover_owed) = owed.then_some((held, reason));
    }

    /// Sends the takeover state `run`'s child is owed, if any. After a valid pong.
    pub(super) fn resend_takeover(&self, id: &str, run: &Arc<Run>) {
        let children = lock(&self.children);
        if !Self::is_current(&children, id, run) {
            return;
        }
        let owed = lock(&run.takeover_owed).take();
        if let Some((held, reason)) = owed {
            let resent = run.child.get().is_some_and(|child| {
                child
                    .send(&HostMessage::TakeoverState { held, reason })
                    .is_ok()
            });
            if !resent {
                *lock(&run.takeover_owed) = Some((held, reason));
            }
        }
    }

    /// Holds the output for `id` without a child, as a granted request would.
    #[cfg(test)]
    pub(crate) fn hold_output_for(&self, id: &str) {
        let _children = lock(&self.children);
        self.takeover.request(id, true, true, true);
        self.board.took_over(id, self.clock.now());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::panic::{catch_unwind, AssertUnwindSafe};

    const ID: &str = "com.example.demo";
    const OTHER: &str = "com.example.other";

    /// Records every takeover command in order.
    #[derive(Default)]
    struct Commands(Mutex<Vec<bool>>);

    impl PlayerLink for Commands {
        fn player(&self, cmd: PlayerCmd) {
            if let PlayerCmd::SetOutputTakeover(on) = cmd {
                self.0.lock().unwrap().push(on);
            }
        }
    }

    impl Commands {
        fn sent(&self) -> Vec<bool> {
            self.0.lock().unwrap().clone()
        }
    }

    fn hub() -> (TakeoverHub, Arc<Commands>) {
        let commands = Arc::new(Commands::default());
        (TakeoverHub::new(commands.clone()), commands)
    }

    #[test]
    fn a_hold_needs_the_grant_a_running_plugin_and_no_other_holder() {
        let (hub, commands) = hub();
        assert_eq!(hub.request(ID, true, false, true), TakeoverReason::Denied);
        assert_eq!(hub.request(ID, true, true, false), TakeoverReason::Denied);
        assert!(commands.sent().is_empty());
        assert_eq!(hub.holder(), None);

        assert_eq!(hub.request(ID, true, true, true), TakeoverReason::Granted);
        // Asked again while holding: granted, with no second command.
        assert_eq!(hub.request(ID, true, true, true), TakeoverReason::Granted);
        assert_eq!(commands.sent(), [true]);

        assert_eq!(hub.request(OTHER, true, true, true), TakeoverReason::Busy);
        assert_eq!(hub.holder().as_deref(), Some(ID));
        assert_eq!(commands.sent(), [true]);
    }

    #[test]
    fn a_give_back_restores_only_for_the_holder() {
        let (hub, commands) = hub();
        hub.request(ID, true, true, true);
        assert_eq!(
            hub.request(OTHER, false, true, true),
            TakeoverReason::Released
        );
        assert!(!hub.release(OTHER, TakeoverReason::User));
        assert_eq!(hub.holder().as_deref(), Some(ID));
        assert_eq!(hub.request(ID, false, true, true), TakeoverReason::Released);
        assert_eq!(commands.sent(), [true, false]);
        assert_eq!(hub.holder(), None);
        // Nothing held: nothing sent.
        assert!(!hub.release(ID, TakeoverReason::Stopped));
        assert_eq!(hub.release_any(TakeoverReason::Stopped), None);
        assert_eq!(commands.sent(), [true, false]);
    }

    #[test]
    fn release_any_restores_and_names_the_holder() {
        let (hub, commands) = hub();
        hub.request(ID, true, true, true);
        assert_eq!(hub.release_any(TakeoverReason::User).as_deref(), Some(ID));
        assert_eq!(commands.sent(), [true, false]);
        assert_eq!(
            hub.request(OTHER, true, true, true),
            TakeoverReason::Granted
        );
    }

    #[test]
    fn plugins_racing_for_the_output_get_one_grant_and_one_command() {
        let (hub, commands) = hub();
        let ids: Vec<String> = (0..8).map(|n| format!("com.example.n{n}")).collect();
        let answers: Vec<TakeoverReason> = std::thread::scope(|scope| {
            let asking: Vec<_> = ids
                .iter()
                .map(|id| scope.spawn(|| hub.request(id, true, true, true)))
                .collect();
            asking.into_iter().map(|t| t.join().unwrap()).collect()
        });
        let granted: Vec<&String> = ids
            .iter()
            .zip(&answers)
            .filter(|(_, reason)| **reason == TakeoverReason::Granted)
            .map(|(id, _)| id)
            .collect();
        assert_eq!(granted.len(), 1);
        assert_eq!(hub.holder().as_ref(), Some(granted[0]));
        assert!(answers
            .iter()
            .all(|r| matches!(r, TakeoverReason::Granted | TakeoverReason::Busy)));
        assert_eq!(commands.sent(), [true]);
    }

    #[test]
    fn a_holder_no_longer_allowed_to_hold_loses_the_output_when_it_asks() {
        let (hub, commands) = hub();
        hub.request(ID, true, true, true);
        assert_eq!(hub.request(ID, true, true, false), TakeoverReason::Denied);
        assert_eq!(hub.holder(), None);
        assert_eq!(commands.sent(), [true, false]);
        // Anyone else denied changes nothing.
        hub.request(ID, true, true, true);
        assert_eq!(
            hub.request(OTHER, true, false, true),
            TakeoverReason::Denied
        );
        assert_eq!(hub.holder().as_deref(), Some(ID));
        assert_eq!(commands.sent(), [true, false, true]);
    }

    #[test]
    fn a_poisoned_lock_still_restores() {
        let (hub, commands) = hub();
        hub.request(ID, true, true, true);
        let poisoned = catch_unwind(AssertUnwindSafe(|| {
            let _held = hub.holder.lock().unwrap();
            panic!("poison the holder lock");
        }));
        assert!(poisoned.is_err());
        assert!(hub.holder.is_poisoned());
        assert!(hub.release(ID, TakeoverReason::Stopped));
        assert_eq!(commands.sent(), [true, false]);

        hub.request(ID, true, true, true);
        assert_eq!(
            hub.release_any(TakeoverReason::Stopped).as_deref(),
            Some(ID)
        );
        assert_eq!(commands.sent(), [true, false, true, false]);
    }
}
