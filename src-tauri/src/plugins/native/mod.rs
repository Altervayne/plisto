/*
 * The native plugin host: starts an enabled native plugin as a child process, supervises it, and stops
 * it. Each child runs in its own kill-on-close job, so no plugin process outlives Plisto, however
 * Plisto ends. A start returns once the process runs; the handshake and everything the child sends
 * after it are handled on its pump thread, so no command waits on a plugin. One supervisor thread
 * pings every running child, marks a silent one as not responding (never kills it), fires due
 * restarts, and flushes held status changes.
 * A crash is a child that ended or broke without Plisto asking; a stop Plisto asked for never is. The
 * two are told apart by who takes the run out of `children` first. Status changes tied to a run are
 * made while holding `children`, so a stale run never overwrites a newer one's status; the lock order
 * is `children`, then `supervision` or a run's heartbeat, then the status board.
 * A run's feed consumer is detached on every way the run ends, before its process is killed, and its
 * open relays are failed as soon as the run is taken out of `children`.
 * Plisto's own output comes back first on every way a run ends or stops answering: a crash, a stop, a
 * silence and exit each restore it before anything else, in the same `children` critical section that
 * takes the run out, so no grant can land between the two.
 */

mod child;
mod events;
mod feed;
mod frames;
mod heartbeat;
mod host_calls;
mod launch;
pub mod link;
mod protocol;
mod pump;
mod relay;
pub mod status;
mod stream;
mod supervisor;
pub mod takeover;
#[cfg(test)]
mod test_child;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_bridge;
#[cfg(test)]
mod tests_events;
#[cfg(test)]
mod tests_sample;
#[cfg(test)]
mod tests_stream;
#[cfg(test)]
mod tests_takeover;

pub use protocol::TakeoverReason;

// -- Library Imports --
use std::collections::HashMap;
use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError, RwLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

// -- Local Imports --
use super::manifest::{Capability, Tier};
use super::paths::{data_dir, plugin_dir};
use super::revalidate::check_folder;
use super::state::{BootView, PluginsState, Starter, Stopper};
use child::{Child, Stopped};
use feed::{FeedGrant, FeedSlot};
use heartbeat::{Beat, Heartbeat};
use events::EventGate;
use host_calls::{HostCalls, SerialCalls};
use launch::{entry_path, LaunchSpec};
use link::{HostLink, Notice, NoticeKind};
use protocol::{Gesture, HostMessage, API_VERSION, PROTOCOL_VERSION};
use pump::ChildStats;
use relay::{Relays, RELAY_TIMEOUT};
use status::{CrashInfo, CrashReason, FailReason, HostState, PluginStatus, StatusBoard};
use supervisor::{CrashPolicy, Verdict};
use takeover::{TakeoverHub, ThroughLink};

/// A first launch can sit behind an antivirus scan, so `ready` gets this long.
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a child has to exit after `shutdown` before it is killed.
pub const STOP_GRACE: Duration = Duration::from_secs(2);
/// How often the supervisor thread ticks.
pub const TICK: Duration = Duration::from_millis(250);
// When a child's output ends, how long its process gets to exit so its exit code can be read.
const EXIT_SETTLE: Duration = Duration::from_millis(500);
// Windows error codes for an executable blocked by an antivirus or by policy.
const ERROR_VIRUS_INFECTED: i32 = 225;
const ERROR_VIRUS_DELETED: i32 = 226;
const ERROR_ACCESS_DISABLED_BY_POLICY: i32 = 1260;

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
    /// Plisto is quitting.
    Exiting,
    /// Starts are held while an update installs.
    Held,
}

impl std::fmt::Display for StartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StartError::NotServing => f.write_str("not enabled"),
            StartError::NotNative => f.write_str("not a native plugin"),
            StartError::Invalid(why) => write!(f, "folder does not validate: {why}"),
            StartError::Changed => f.write_str("plugin.json changed since consent"),
            StartError::Launch(e) => write!(f, "cannot launch: {e}"),
            StartError::Exiting => f.write_str("Plisto is quitting"),
            StartError::Held => f.write_str("plugins are stopped for an update"),
        }
    }
}

/// Where the host reads the time; tests drive it by hand.
pub trait Clock: Send + Sync {
    fn now(&self) -> Instant;
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Instant {
        Instant::now()
    }
}

/// One run of a plugin, from the reservation made before its launch to its end. The child is set
/// once it is launched; the heartbeat once it is ready.
struct Run {
    child: OnceLock<Arc<Child>>,
    heartbeat: Mutex<Option<Heartbeat>>,
    feed: Arc<FeedSlot>,
    relays: Relays,
    host_calls: HostCalls,
    serial_calls: SerialCalls,
    /// Orders app events against the answers to the child's event subscribes.
    event_gate: Mutex<EventGate>,
    stats: ChildStats,
    /// The `takeover_state` the child is still to hear, as `(held, reason)`.
    takeover_owed: Mutex<Option<(bool, TakeoverReason)>>,
    /// Set when the run starts to end without a stop; from then on it is granted nothing.
    ending: AtomicBool,
}

impl Run {
    fn new() -> Run {
        Run {
            child: OnceLock::new(),
            heartbeat: Mutex::new(None),
            feed: Arc::default(),
            relays: Relays::default(),
            host_calls: HostCalls::default(),
            serial_calls: SerialCalls::default(),
            event_gate: Mutex::new(EventGate::default()),
            stats: ChildStats::default(),
            takeover_owed: Mutex::new(None),
            ending: AtomicBool::new(false),
        }
    }
}

type Children = Arc<Mutex<HashMap<String, Arc<Run>>>>;

#[derive(Default)]
struct Supervision {
    // Kept across restarts; dropped by a stop, so a disable, an update or an uninstall starts afresh.
    policies: HashMap<String, CrashPolicy>,
    due: HashMap<String, Instant>,
}

/// Runs once per silence of a child, with its id, after the host took its output takeover back, to
/// take back anything else it should no longer hold.
pub type RestoreHook = Arc<dyn Fn(&str) + Send + Sync>;

/// A handle on the host; clones share everything.
#[derive(Clone)]
pub struct NativeHost {
    app_data: PathBuf,
    children: Children,
    supervision: Arc<Mutex<Supervision>>,
    board: Arc<StatusBoard>,
    link: Arc<dyn HostLink>,
    clock: Arc<dyn Clock>,
    exiting: Arc<AtomicBool>,
    // Refuses every start while an update installs; unlike `exiting`, it can be released.
    held: Arc<AtomicBool>,
    restore: Arc<RwLock<Option<RestoreHook>>>,
    relay_timeout: Duration,
    takeover: Arc<TakeoverHub>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// Whether Windows refused to run the executable: access denied, or blocked by an antivirus or a
/// policy. Retrying cannot help, so no restart follows.
fn launch_denied(e: &io::Error) -> bool {
    e.kind() == io::ErrorKind::PermissionDenied
        || matches!(
            e.raw_os_error(),
            Some(ERROR_VIRUS_INFECTED | ERROR_VIRUS_DELETED | ERROR_ACCESS_DISABLED_BY_POLICY)
        )
}

fn is_background(granted: &[Capability]) -> bool {
    granted.contains(&Capability::Background)
}

impl NativeHost {
    pub fn new(app_data: PathBuf, link: Arc<dyn HostLink>) -> NativeHost {
        NativeHost::with_clock(app_data, link, Arc::new(SystemClock))
    }

    pub fn with_clock(app_data: PathBuf, link: Arc<dyn HostLink>, clock: Arc<dyn Clock>) -> NativeHost {
        NativeHost {
            board: Arc::new(StatusBoard::new(link.clone(), clock.now())),
            takeover: Arc::new(TakeoverHub::new(Arc::new(ThroughLink(link.clone())))),
            app_data,
            children: Arc::default(),
            supervision: Arc::default(),
            link,
            clock,
            exiting: Arc::default(),
            held: Arc::default(),
            restore: Arc::default(),
            relay_timeout: RELAY_TIMEOUT,
        }
    }

    /// The same host with its takeover commands going to `player`. Only before anything holds it.
    #[cfg(test)]
    fn with_takeover_player(self, player: Arc<dyn takeover::PlayerLink>) -> NativeHost {
        NativeHost {
            takeover: Arc::new(TakeoverHub::new(player)),
            ..self
        }
    }

    pub fn is_running(&self, id: &str) -> bool {
        lock(&self.children).contains_key(id)
    }

    /// The process id of the plugin's running child.
    #[cfg(test)]
    fn pid(&self, id: &str) -> Option<u32> {
        lock(&self.children).get(id)?.child.get().map(|child| child.pid())
    }

    /// Every supervised plugin's status.
    pub fn statuses(&self) -> Vec<PluginStatus> {
        self.board.all()
    }

    pub fn status(&self, id: &str) -> Option<PluginStatus> {
        self.board.get(id)
    }

    pub fn set_restore_hook(&self, hook: RestoreHook) {
        *self.restore.write().unwrap_or_else(PoisonError::into_inner) = Some(hook);
    }

    /// Runs `f` on the plugin state the link reaches; None when there is none.
    fn with_plugins<R>(&self, f: impl FnOnce(&PluginsState) -> R) -> Option<R> {
        let mut f = Some(f);
        let mut out = None;
        self.link.with_plugins(&mut |plugins| {
            if let Some(f) = f.take() {
                out = Some(f(plugins));
            }
        });
        out
    }

    /// Starts the plugin when it is a serving native plugin whose manifest is the consented one. A
    /// plugin already running, or being started, is left as it is.
    pub fn start(&self, plugins: &PluginsState, id: &str) -> Result<(), StartError> {
        if self.exiting.load(Ordering::SeqCst) {
            return Err(StartError::Exiting);
        }
        if self.held.load(Ordering::SeqCst) {
            return Err(StartError::Held);
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
    fn prepare(&self, plugins: &PluginsState, id: &str) -> Result<LaunchSpec, StartError> {
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
        Ok(LaunchSpec {
            exe: entry_path(&dir, &manifest.entry),
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
                if let Err(e) = self.start(plugins, &id) {
                    eprintln!("plugins: {id}: not started: {e}");
                }
            } else if is_background(&serving.granted) && plugins.is_enabled(&id) {
                self.board.set_host(&id, HostState::Starting, self.clock.now());
            }
        }
    }

    /// Forgets the plugin's crashes and any due restart, for a start the user asked for.
    fn reset(&self, id: &str) {
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
            // The stop restores any output the child held before the status changes. The API is
            // forgotten after the stop, so nothing the old child asked for during its grace outlives
            // it. The page frame stays on screen, so its page slot and network work are kept.
            self.stop_plugin(id);
            self.reset(id);
            plugins.api().forget_run(id);
            return self.start(plugins, id);
        }
        self.reset(id);
        self.board.set_host(id, HostState::Starting, self.clock.now());
        Ok(())
    }

    /// Stops the plugin's child, if one runs: `shutdown`, the grace period, then a kill. Never a
    /// crash. Drops its crash policy and any due restart.
    pub fn stop_plugin(&self, id: &str) {
        {
            let mut supervision = lock(&self.supervision);
            supervision.policies.remove(id);
            supervision.due.remove(id);
        }
        let run = {
            let mut children = lock(&self.children);
            let run = children.remove(id);
            self.give_back(id, TakeoverReason::Stopped, run.as_deref());
            run
        };
        let Some(run) = run else {
            self.board.stopped(id, self.clock.now());
            return;
        };
        run.relays.fail_all();
        self.board.set_host(id, HostState::Stopping, self.clock.now());
        run.feed.detach(self.link.as_ref());
        if let Some(child) = run.child.get() {
            if child.stop(STOP_GRACE) == Stopped::Killed {
                eprintln!("plugins: {id}: killed after the shutdown grace");
            }
        }
        self.board.set_host(id, HostState::Off, self.clock.now());
    }

    /// Stops every child at once, all within one grace period, and returns when every process is
    /// gone, with the plugins' open API calls ended. For app exit, safe mode and anything that
    /// replaces the running binary.
    pub fn shutdown_all(&self) {
        lock(&self.supervision).due.clear();
        let all: Vec<(String, Arc<Run>)> = {
            let mut children = lock(&self.children);
            self.give_back_any(TakeoverReason::Stopped, &children);
            children.drain().collect()
        };
        for (id, run) in &all {
            run.relays.fail_all();
            self.board.set_host(id, HostState::Stopping, self.clock.now());
            run.feed.detach(self.link.as_ref());
            self.with_plugins(|plugins| plugins.api().forget(id));
        }
        thread::scope(|scope| {
            for (_, run) in &all {
                if let Some(child) = run.child.get() {
                    scope.spawn(move || child.stop(STOP_GRACE));
                }
            }
        });
        for (id, _) in &all {
            self.board.set_host(id, HostState::Off, self.clock.now());
        }
    }

    /// Refuses every start and restart until `release_starts`. Set before the children stop, under the
    /// children lock, so a reservation is either made before it and stopped with the rest, or refused.
    /// A refused start leaves no status behind, so the plugin starts normally once released.
    pub fn hold_starts(&self) {
        {
            let _children = lock(&self.children);
            self.held.store(true, Ordering::SeqCst);
        }
        lock(&self.supervision).due.clear();
    }

    /// Allows starts again after `hold_starts`.
    pub fn release_starts(&self) {
        self.held.store(false, Ordering::SeqCst);
    }

    /// No restart and no new start from now on. The first step of app exit.
    pub fn begin_exit(&self) {
        // Under the children lock, so a reservation is either made before it, and stopped with the
        // rest, or refused.
        {
            let _children = lock(&self.children);
            self.exiting.store(true, Ordering::SeqCst);
        }
        lock(&self.supervision).due.clear();
    }

    /// The runtime turned safe: every child stops, every status goes off, and the main window is told.
    pub fn on_runtime_safe(&self, view: BootView) {
        self.shutdown_all();
        {
            let mut supervision = lock(&self.supervision);
            supervision.policies.clear();
            supervision.due.clear();
        }
        self.board.all_off(self.clock.now());
        self.link.emit_runtime(view);
    }

    /// Starts the supervisor thread. It ends once the app begins to exit.
    pub fn spawn_ticker(&self) -> io::Result<()> {
        let host = self.clone();
        thread::Builder::new()
            .name("plugin-supervisor".into())
            .spawn(move || {
                while !host.exiting.load(Ordering::SeqCst) {
                    host.tick();
                    thread::sleep(TICK);
                }
            })
            .map(|_| ())
    }

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
        self.board.flush(now);
    }

    /// Fires a restart the crash policy scheduled, if the plugin still serves. A native start reads
    /// the plugin folder and launches a process, so it runs on a thread of its own and never holds
    /// up the pings of other children.
    fn restart_due(&self, id: &str) {
        let now = self.clock.now();
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

    /// Starts a native plugin again after a crash. When it no longer serves, or Plisto is quitting,
    /// its status leaves "restarting".
    fn restart_native(&self, id: &str) {
        let result = self.with_plugins(|plugins| self.start(plugins, id));
        match result {
            Some(Ok(())) => {}
            None | Some(Err(StartError::NotServing | StartError::Exiting | StartError::Held)) => {
                self.board.stopped(id, self.clock.now());
            }
            Some(Err(e)) => eprintln!("plugins: {id}: not restarted: {e}"),
        }
    }

    /// Takes the id for a new run. None when a run already holds it or Plisto is quitting.
    fn reserve(&self, id: &str) -> Option<Arc<Run>> {
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
    fn is_current(children: &HashMap<String, Arc<Run>>, id: &str, run: &Arc<Run>) -> bool {
        children.get(id).is_some_and(|held| Arc::ptr_eq(held, run))
    }

    /// Gives back a reservation that launched nothing, setting `host` when given. False when a stop
    /// took it first.
    fn end_reservation(&self, id: &str, run: &Arc<Run>, host: Option<HostState>) -> bool {
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
    fn adopt(&self, id: &str, run: &Arc<Run>, child: Arc<Child>) -> bool {
        let children = lock(&self.children);
        Self::is_current(&children, id, run) && run.child.set(child).is_ok()
    }

    /// Sets the host state when `run` is still current.
    fn set_host_if_ours(&self, id: &str, run: &Arc<Run>, host: HostState) -> bool {
        let children = lock(&self.children);
        let ours = Self::is_current(&children, id, run);
        if ours {
            self.board.set_host(id, host, self.clock.now());
        }
        ours
    }

    /// The child sent `ready`: its heartbeat starts and it counts as up. False when a stop took it.
    fn went_running(&self, id: &str, run: &Arc<Run>) -> bool {
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
    fn is_hung(run: &Run) -> bool {
        lock(&run.heartbeat)
            .as_ref()
            .is_some_and(Heartbeat::is_hung)
    }

    /// Marks the child not responding. A pong that came in since the silence was seen wins: the
    /// heartbeat is read again under the `children` lock, which `recovered` also takes.
    fn went_silent(&self, id: &str, run: &Arc<Run>) {
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
    fn recovered(&self, id: &str, run: &Arc<Run>) {
        let children = lock(&self.children);
        if Self::is_current(&children, id, run) && !Self::is_hung(run) {
            self.board.set_host(id, HostState::Running, self.clock.now());
        }
    }

    /// The plugin's current run and its child, once the child is ready.
    fn ready_run(&self, id: &str) -> Option<(Arc<Run>, Arc<Child>)> {
        let run = lock(&self.children).get(id)?.clone();
        let child = run.child.get()?.clone();
        let ready = lock(&run.heartbeat).is_some();
        ready.then_some((run, child))
    }

    /// The child of `run` while it is still the plugin's current run.
    fn current_child(&self, id: &str, run: &Arc<Run>) -> Option<Arc<Child>> {
        let children = lock(&self.children);
        Self::is_current(&children, id, run)
            .then(|| run.child.get().cloned())
            .flatten()
    }

    /// Hands a click on one of the plugin's sidebar controls to its child. False when the child is
    /// not running or its outbox has no room; the gesture then reaches no one.
    pub fn deliver_sidebar(
        &self,
        id: &str,
        item_id: &str,
        value: Option<bool>,
        gesture: &str,
    ) -> bool {
        let Some((_, child)) = self.ready_run(id) else {
            return false;
        };
        if self.board.host(id) != Some(HostState::Running) {
            return false;
        }
        let input = HostMessage::SidebarInput {
            item_id: item_id.to_string(),
            value,
            gesture: Gesture::new(gesture),
        };
        child.send(&input).is_ok()
    }

    /// Tells the plugin's child that its page was shown or hidden. Best effort: a child that is not
    /// ready yet hears the current value once it is.
    pub fn notify_page(&self, id: &str, open: bool) {
        if let Some((_, child)) = self.ready_run(id) {
            let _ = child.send(&HostMessage::Page { open });
        }
    }

    fn crash_info(&self, reason: CrashReason, exit_code: Option<u32>) -> CrashInfo {
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
    fn end_run(&self, id: &str, run: &Arc<Run>, child: &Child, reason: CrashReason) {
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
    fn run_policy(&self, id: &str, crash: CrashInfo) {
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
            self.link.disable(id);
            self.link.emit_notice(&Notice {
                id: id.to_string(),
                kind: NoticeKind::AutoDisabled,
            });
        }
    }
}

impl Stopper for NativeHost {
    fn stop(&self, id: &str) {
        self.stop_plugin(id);
    }
}

impl Starter for NativeHost {
    /// An enable, an update or a resolved boot: a start the user asked for, so the crash count resets.
    fn start(&self, plugins: &PluginsState, id: &str) {
        self.reset(id);
        match NativeHost::start(self, plugins, id) {
            Ok(()) => {}
            Err(StartError::NotNative) => {
                let background = plugins
                    .enabled_set()
                    .serving(id)
                    .is_some_and(|serving| is_background(&serving.granted));
                if background {
                    self.board.set_host(id, HostState::Starting, self.clock.now());
                }
            }
            Err(e) => eprintln!("plugins: {id}: not started: {e}"),
        }
    }
}

/// A clock that moves only when told to.
#[cfg(test)]
pub(crate) struct FakeClock(Mutex<Instant>);

#[cfg(test)]
impl FakeClock {
    pub fn new() -> FakeClock {
        FakeClock(Mutex::new(Instant::now()))
    }

    pub fn advance(&self, by: Duration) {
        *lock(&self.0) += by;
    }
}

#[cfg(test)]
impl Clock for FakeClock {
    fn now(&self) -> Instant {
        *lock(&self.0)
    }
}
