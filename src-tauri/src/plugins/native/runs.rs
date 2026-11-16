/*
 * One run's bookkeeping: reserving the id, adopting the child, the state changes a run reports, and
 * what its end sets off.
 */

// -- Local Imports --
use super::*;

impl NativeHost {
    /// Takes the id for a new run. None when a run already holds it or Plisto is quitting.
    pub(super) fn reserve(&self, id: &str) -> Option<Arc<Run>> {
        let mut children = lock(&self.children);
        if children.contains_key(id)
            || self.exiting.load(Ordering::SeqCst)
            || self.held.load(Ordering::SeqCst)
        {
            return None;
        }
        let run = Arc::new(Run::new());
        children.insert(id.to_string(), run.clone());
        Some(run)
    }

    /// Whether `run` is still the id's current run.
    pub(super) fn is_current(children: &HashMap<String, Arc<Run>>, id: &str, run: &Arc<Run>) -> bool {
        children.get(id).is_some_and(|held| Arc::ptr_eq(held, run))
    }

    /// Gives back a reservation that launched nothing, setting `host` when given. False when a stop
    /// took it first.
    pub(super) fn end_reservation(&self, id: &str, run: &Arc<Run>, host: Option<HostState>) -> bool {
        let mut children = lock(&self.children);
        if !Self::is_current(&children, id, run) {
            return false;
        }
        children.remove(id);
        if let Some(host) = host {
            self.board.set_host(id, host, self.clock.now());
        }
        true
    }

    /// Records a launched child on its run. False when a stop took the run first.
    pub(super) fn adopt(&self, id: &str, run: &Arc<Run>, child: Arc<Child>) -> bool {
        let children = lock(&self.children);
        Self::is_current(&children, id, run) && run.child.set(child).is_ok()
    }

    /// Sets the host state when `run` is still current.
    pub(super) fn set_host_if_ours(&self, id: &str, run: &Arc<Run>, host: HostState) -> bool {
        let children = lock(&self.children);
        let ours = Self::is_current(&children, id, run);
        if ours {
            self.board.set_host(id, host, self.clock.now());
        }
        ours
    }

    /// The child sent `ready`: its heartbeat starts and it counts as up. False when a stop took it.
    pub(super) fn went_running(&self, id: &str, run: &Arc<Run>) -> bool {
        let now = self.clock.now();
        {
            let children = lock(&self.children);
            if !Self::is_current(&children, id, run) {
                return false;
            }
            *lock(&run.heartbeat) = Some(Heartbeat::start(now));
            self.board.set_host(id, HostState::Running, now);
        }
        lock(&self.supervision)
            .policies
            .entry(id.to_string())
            .or_default()
            .on_running(now);
        true
    }

    /// Whether the run's heartbeat is in a silence now.
    pub(super) fn is_hung(run: &Run) -> bool {
        lock(&run.heartbeat)
            .as_ref()
            .is_some_and(Heartbeat::is_hung)
    }

    /// Marks the child not responding. A pong that came in since the silence was seen wins: the
    /// heartbeat is read again under the `children` lock, which `recovered` also takes.
    pub(super) fn went_silent(&self, id: &str, run: &Arc<Run>) {
        {
            let children = lock(&self.children);
            if !Self::is_current(&children, id, run) || !Self::is_hung(run) {
                return;
            }
            // Taken back once per silence, before the status shows it; a child that answers again
            // has to ask for it again.
            self.give_back(id, TakeoverReason::NotResponding, Some(run.as_ref()));
            self.board
                .set_host(id, HostState::NotResponding, self.clock.now());
        }
        let hook = self
            .restore
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        if let Some(hook) = hook {
            hook(id);
        }
    }

    /// Marks the child running again, unless it went silent again since its pong.
    pub(super) fn recovered(&self, id: &str, run: &Arc<Run>) {
        let children = lock(&self.children);
        if Self::is_current(&children, id, run) && !Self::is_hung(run) {
            self.board.set_host(id, HostState::Running, self.clock.now());
        }
    }

    /// The plugin's current run and its child, once the child is ready.
    pub(super) fn ready_run(&self, id: &str) -> Option<(Arc<Run>, Arc<Child>)> {
        let run = lock(&self.children).get(id)?.clone();
        let child = run.child.get()?.clone();
        let ready = lock(&run.heartbeat).is_some();
        ready.then_some((run, child))
    }

    /// The child of `run` while it is still the plugin's current run.
    pub(super) fn current_child(&self, id: &str, run: &Arc<Run>) -> Option<Arc<Child>> {
        let children = lock(&self.children);
        Self::is_current(&children, id, run)
            .then(|| run.child.get().cloned())
            .flatten()
    }

    pub(super) fn crash_info(&self, reason: CrashReason, exit_code: Option<u32>) -> CrashInfo {
        CrashInfo {
            reason,
            exit_code,
            at_ms: unix_ms(),
        }
    }

    /// The child's run ended without a stop: its open relays fail, the process tree is killed, its API
    /// state is dropped, and the crash policy decides what follows. The run keeps the id until the
    /// tree is dead, so no start can launch a second copy beside a child that is still running.
    /// Nothing is counted when a stop took the run first; of two callers for one run, only the first
    /// counts.
    pub(super) fn end_run(&self, id: &str, run: &Arc<Run>, child: &Child, reason: CrashReason) {
        {
            let children = lock(&self.children);
            if !Self::is_current(&children, id, run) {
                return;
            }
            run.ending.store(true, Ordering::SeqCst);
            self.give_back(id, TakeoverReason::Stopped, None);
        }
        run.relays.fail_all();
        run.feed.detach(self.link.as_ref());
        let exit_code = if reason == CrashReason::Exited && child.wait_exit(EXIT_SETTLE) {
            child.exit_code()
        } else {
            None
        };
        child.kill();
        {
            let mut children = lock(&self.children);
            if !Self::is_current(&children, id, run) {
                return;
            }
            children.remove(id);
            // A backstop: no grant reaches an ending run, and none may outlive it.
            self.give_back(id, TakeoverReason::Stopped, None);
        }
        self.with_plugins(|plugins| plugins.api().forget_run(id));
        eprintln!("plugins: {id}: stopped unexpectedly ({reason:?}, exit code {exit_code:?})");
        self.run_policy(id, self.crash_info(reason, exit_code));
    }

    /// Counts a crash and acts on the verdict: a restart later, or the plugin turned off for good.
    pub(super) fn run_policy(&self, id: &str, crash: CrashInfo) {
        let now = self.clock.now();
        if self.exiting.load(Ordering::SeqCst) {
            self.board.crashed(id, HostState::Off, crash, now);
            return;
        }
        let verdict = {
            let children = lock(&self.children);
            let mut supervision = lock(&self.supervision);
            let verdict = supervision
                .policies
                .entry(id.to_string())
                .or_default()
                .on_crash(now);
            // A start that came in after the crash owns the status now.
            if children.contains_key(id) {
                return;
            }
            match verdict {
                Verdict::RestartIn(delay) => {
                    supervision.due.insert(id.to_string(), now + delay);
                    let retry_in_ms = delay.as_millis() as u64;
                    self.board
                        .crashed(id, HostState::Restarting { retry_in_ms }, crash, now);
                }
                Verdict::CrashLoop => self.board.crashed(id, HostState::CrashLoop, crash, now),
            }
            verdict
        };
        if verdict == Verdict::CrashLoop {
            eprintln!("plugins: {id}: turned off after repeated crashes");
            let outcome = self.link.disable(id);
            self.disable_tried(id, outcome);
            self.link.emit_notice(&Notice {
                id: id.to_string(),
                kind: NoticeKind::AutoDisabled,
            });
        }
    }
}
