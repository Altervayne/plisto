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
mod runs;
mod start;
pub mod status;
mod stream;
mod supervisor;
pub mod takeover;
mod tick;
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
use std::collections::{HashMap, HashSet};
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
use super::state::{BootView, PluginsState, Starter, Stopper, Turn};
use child::{Child, Stopped};
use feed::{FeedGrant, FeedSlot};
use heartbeat::{Beat, Heartbeat};
use events::EventGate;
use host_calls::{HostCalls, SerialCalls};
use launch::{entry_path, LaunchSpec};
use link::{Disabled, HostLink, Notice, NoticeKind};
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
// A crash-loop disable that cannot be saved is tried again after this, doubling up to the cap. One
// that meets another operation's turn is tried again at the next tick.
const DISABLE_RETRY_FIRST: Duration = Duration::from_secs(1);
const DISABLE_RETRY_MAX: Duration = Duration::from_secs(60);
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
    /// Another operation on the plugin holds its lifecycle turn.
    Busy,
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
            StartError::Busy => f.write_str("another change to the plugin is under way"),
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
    // Starts owed to a plugin (boot, resume, an enable's or update's end) that met another
    // operation's turn. Tried again every tick until one runs or the plugin no longer serves.
    owed: HashSet<String>,
    // Crash-loop disables that did not land, with when to try again. Kept until one lands or the
    // saved entry no longer serves; meanwhile the plugin does not start.
    owed_disables: HashMap<String, DisableRetry>,
    // How many failed crash-loop disables were logged.
    #[cfg(test)]
    disable_failures_logged: usize,
}

/// When a crash-loop disable that did not land is tried again.
struct DisableRetry {
    at: Instant,
    // The wait after the last failed save; zero while it only met another operation's turn.
    backoff: Duration,
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

    /// Stops the plugin's child, if one runs: `shutdown`, the grace period, then a kill. Never a
    /// crash. Drops its crash policy, any due restart and any owed start: whatever stops it decides
    /// whether it starts again.
    pub fn stop_plugin(&self, id: &str) {
        {
            let mut supervision = lock(&self.supervision);
            supervision.policies.remove(id);
            supervision.due.remove(id);
            supervision.owed.remove(id);
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
        self.forget_scheduled();
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
        self.forget_scheduled();
    }

    /// Drops every due restart and owed start. A pending crash-loop disable is kept: it takes rights
    /// away and still has to land.
    fn forget_scheduled(&self) {
        let mut supervision = lock(&self.supervision);
        supervision.due.clear();
        supervision.owed.clear();
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
        self.forget_scheduled();
    }

    /// The runtime turned safe: every child stops, every status goes off, and the main window is told.
    pub fn on_runtime_safe(&self, view: BootView) {
        self.shutdown_all();
        {
            let mut supervision = lock(&self.supervision);
            supervision.policies.clear();
            supervision.due.clear();
            supervision.owed.clear();
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
}

impl Stopper for NativeHost {
    fn stop(&self, id: &str) {
        self.stop_plugin(id);
    }
}

impl Starter for NativeHost {
    /// An enable, an update or a resolved boot: a start the user asked for, so the crash count resets.
    fn start(&self, plugins: &PluginsState, id: &str) {
        self.start_owed(plugins, id);
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
