/*
 * Process tests for the native host. Every child is the test binary itself in one of the behaviors
 * of `test_child.rs`, started through the real launch path, so each one sits in a job its test owns:
 * a failing assertion drops the handle and the job kills whatever is left. Waits are generous upper
 * bounds for slow machines; no sleep stands in for an assertion.
 */

// -- Library Imports --
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
use windows::Win32::System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE};

// -- Local Imports --
use super::child::{Child, HandshakeError, Inbound, SendError, Stopped, INBOX_CAP, OUTBOX_CAP};
use super::launch::{stderr_log, LaunchSpec};
use super::child::CLOSED_EXITED;
use super::link::{NoticeKind, RecordingLink};
use super::protocol::{
    ChildMessage, HostMessage, ReportedState, API_VERSION, PROTOCOL_VERSION,
};
use super::status::{CrashReason, HostState};
use super::test_child::{LAUNCHES_FILE, MODE_FILE, RESUME_FILE};
use super::{Clock, FakeClock, NativeHost, StartError, STOP_GRACE};
use crate::audio::{FeedCause, FeedState, Transport};
use crate::plugins::paths::{data_dir, plugin_dir};
use crate::plugins::session::{self, BootState};
use crate::plugins::state::{BootView, PluginsState, Runtime};
use crate::plugins::test_kit::{native, ui, Kit, ID};

// Upper bound for anything that only waits on a process starting or answering.
pub(super) const SLOW: Duration = Duration::from_secs(60);

struct Rig {
    root: PathBuf,
    spec: LaunchSpec,
}

impl Rig {
    fn new(mode: &str) -> Rig {
        static N: AtomicUsize = AtomicUsize::new(0);
        let root = std::env::temp_dir().join(format!(
            "plisto-native-test-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let plugin_dir = root.join("plugin");
        let data_dir = root.join("data");
        fs::create_dir_all(&plugin_dir).unwrap();
        fs::create_dir_all(&data_dir).unwrap();
        fs::write(data_dir.join(MODE_FILE), mode).unwrap();
        let spec = LaunchSpec {
            exe: std::env::current_exe().unwrap(),
            plugin_dir,
            data_dir,
            tap: None,
        };
        Rig { root, spec }
    }

    fn spawn(&self) -> Child {
        Child::spawn(ID, &self.spec).unwrap()
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn hello() -> HostMessage {
    HostMessage::Hello {
        protocol: PROTOCOL_VERSION,
        api_version: API_VERSION,
        plisto_version: "2.7.0".into(),
        id: ID.into(),
        granted: Vec::new(),
    }
}

/// The next message, skipping none; panics on a timeout.
fn next_message(child: &Child) -> ChildMessage {
    match child.recv_timeout(SLOW) {
        Ok(Inbound::Message(m)) => m,
        other => panic!("{other:?}"),
    }
}

/// A process handle that only waits; closed on drop.
pub(super) struct Watch(HANDLE);

impl Watch {
    pub(super) fn new(pid: u32) -> Watch {
        // Safety: plain arguments; the returned handle is owned by the Watch.
        Watch(unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, pid) }.unwrap())
    }

    pub(super) fn gone_within(&self, timeout: Duration) -> bool {
        let ms = timeout.as_millis() as u32;
        // Safety: the handle is open for as long as the Watch lives.
        let event = unsafe { WaitForSingleObject(self.0, ms) };
        event == WAIT_OBJECT_0
    }
}

impl Drop for Watch {
    fn drop(&mut self) {
        // Safety: the handle is owned by this Watch and closed exactly once, here.
        let _ = unsafe { CloseHandle(self.0) };
    }
}

/// Polls `check` until it holds or `SLOW` runs out.
pub(super) fn eventually(mut check: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + SLOW;
    while Instant::now() < deadline {
        if check() {
            return true;
        }
        thread::sleep(Duration::from_millis(20));
    }
    check()
}

#[test]
fn a_well_behaved_child_handshakes_answers_and_exits_on_shutdown() {
    let rig = Rig::new("echo");
    let child = rig.spawn();
    child.handshake(&hello(), SLOW).unwrap();
    child.send(&HostMessage::Ping { seq: 7 }).unwrap();
    assert_eq!(next_message(&child), ChildMessage::Pong { seq: 7 });
    let args = json!({"text": "round trip", "n": [1, 2]});
    child
        .send(&HostMessage::Call {
            seq: 8,
            method: "plugin.echo".into(),
            args: args.clone(),
        })
        .unwrap();
    assert_eq!(
        next_message(&child),
        ChildMessage::Result {
            seq: 8,
            ok: true,
            result: Some(args),
            error: None
        }
    );
    assert_eq!(child.stop(STOP_GRACE), Stopped::Clean);
    assert!(child.wait_exit(Duration::ZERO));
    assert_eq!(
        child.recv_timeout(SLOW),
        Ok(Inbound::Closed(CLOSED_EXITED.into()))
    );
}

#[test]
fn the_child_gets_the_argv_folder_and_environment_it_is_promised() {
    let rig = Rig::new("echo");
    let child = rig.spawn();
    child.handshake(&hello(), SLOW).unwrap();
    child.stop(STOP_GRACE);
    drop(child);
    let log = fs::read_to_string(stderr_log(&rig.spec.data_dir)).unwrap();
    let data = rig.spec.data_dir.display().to_string();
    let expected_args = format!(
        "{:?}",
        [
            "--plisto-protocol",
            "1",
            "--plisto-data",
            &data,
            "--plisto-tap",
            "none"
        ]
    );
    assert!(log.contains(&format!("args={expected_args}")), "{log}");
    assert!(
        log.contains(&format!("cwd={}", rig.spec.plugin_dir.display())),
        "{log}"
    );
    let webview2 = rig.spec.data_dir.join("webview2");
    assert!(
        log.contains(&format!("webview2={}", webview2.display())),
        "{log}"
    );

    // The log is truncated at the next launch.
    let child = rig.spawn();
    child.handshake(&hello(), SLOW).unwrap();
    child.stop(STOP_GRACE);
    drop(child);
    let again = fs::read_to_string(stderr_log(&rig.spec.data_dir)).unwrap();
    assert_eq!(again.matches("args=").count(), 1);
}

#[test]
fn a_child_that_crashes_fails_the_handshake() {
    let rig = Rig::new("crash");
    let child = rig.spawn();
    match child.handshake(&hello(), SLOW) {
        Err(HandshakeError::Exited(_)) => {}
        other => panic!("{other:?}"),
    }
    assert!(child.wait_exit(SLOW));
}

#[test]
fn a_hung_child_times_out_and_is_killed() {
    let rig = Rig::new("hang");
    let child = rig.spawn();
    assert_eq!(
        child.handshake(&hello(), Duration::from_secs(1)),
        Err(HandshakeError::Timeout)
    );
    assert_eq!(child.stop(STOP_GRACE), Stopped::Killed);
    assert!(child.wait_exit(Duration::ZERO));
}

#[test]
fn a_child_that_ignores_stdin_is_killed_at_the_deadline() {
    let rig = Rig::new("ignore-stdin");
    let child = rig.spawn();
    child.handshake(&hello(), SLOW).unwrap();
    let started = Instant::now();
    assert_eq!(child.stop(STOP_GRACE), Stopped::Killed);
    assert!(started.elapsed() >= STOP_GRACE);
    assert!(child.wait_exit(Duration::ZERO));
}

#[test]
fn a_grandchild_dies_with_the_job() {
    let rig = Rig::new("spawn-grandchild");
    let child = rig.spawn();
    child.handshake(&hello(), SLOW).unwrap();
    let pid = match next_message(&child) {
        ChildMessage::Log { text, .. } if text.starts_with("grandchild=") => {
            text["grandchild=".len()..].parse::<u32>().unwrap()
        }
        other => panic!("{other:?}"),
    };
    let grandchild = Watch::new(pid);
    let parent = Watch::new(child.pid());
    assert!(!grandchild.gone_within(Duration::ZERO));
    drop(child);
    assert!(parent.gone_within(SLOW));
    assert!(grandchild.gone_within(SLOW));
}

#[test]
fn dropping_the_handle_kills_the_child() {
    let rig = Rig::new("echo");
    let child = rig.spawn();
    child.handshake(&hello(), SLOW).unwrap();
    let watch = Watch::new(child.pid());
    assert!(!watch.gone_within(Duration::ZERO));
    drop(child);
    assert!(watch.gone_within(SLOW));
}

#[test]
fn a_flooding_child_is_bounded_and_never_blocks_the_sender() {
    let rig = Rig::new("flood-stdout");
    let child = rig.spawn();
    child.handshake(&hello(), SLOW).unwrap();
    // The reader fills the inbox and then waits on it instead of growing.
    assert!(eventually(|| child.inbox_len() == INBOX_CAP));
    assert!(child.inbox_len() <= INBOX_CAP);

    // The child never reads its input: the pipe and the queue fill, and sends fail without waiting.
    let big = json!("y".repeat(16 * 1024));
    let mut full = 0;
    let started = Instant::now();
    for seq in 0..(10 * OUTBOX_CAP as u64) {
        let call = HostMessage::Call {
            seq,
            method: "plugin.big".into(),
            args: big.clone(),
        };
        match child.send(&call) {
            Ok(()) => {}
            Err(SendError::Full) => full += 1,
            Err(e) => panic!("{e:?}"),
        }
    }
    assert!(full > 0);
    assert!(started.elapsed() < SLOW);
    assert!(child.inbox_len() <= INBOX_CAP);
    assert_eq!(child.stop(STOP_GRACE), Stopped::Killed);
}

#[test]
fn a_child_that_sends_bad_statuses_has_each_one_reported() {
    let rig = Rig::new("bad-status");
    let child = rig.spawn();
    child.handshake(&hello(), SLOW).unwrap();
    for _ in 0..3 {
        match child.recv_timeout(SLOW) {
            Ok(Inbound::Malformed(_)) => {}
            other => panic!("{other:?}"),
        }
    }
    assert_eq!(
        next_message(&child),
        ChildMessage::Status {
            state: ReportedState::Idle,
            text: Some("fine".into())
        }
    );
}

#[test]
fn a_status_flooding_child_alternates_states() {
    let rig = Rig::new("status-flood");
    let child = rig.spawn();
    child.handshake(&hello(), SLOW).unwrap();
    let mut states = Vec::new();
    for _ in 0..4 {
        match next_message(&child) {
            ChildMessage::Status { state, .. } => states.push(state),
            other => panic!("{other:?}"),
        }
    }
    use ReportedState::{On, Warn};
    assert_eq!(states, [On, Warn, On, Warn]);
}

#[test]
fn a_host_call_is_answered_and_the_child_logs_the_result() {
    let rig = Rig::new("host-call");
    let child = rig.spawn();
    child.handshake(&hello(), SLOW).unwrap();
    assert_eq!(
        next_message(&child),
        ChildMessage::HostCall {
            seq: 1,
            method: "library.tracks".into(),
            args: json!({})
        }
    );
    child
        .send(&HostMessage::HostResult {
            seq: 1,
            ok: true,
            result: Some(json!({"tracks": 3})),
            error: None,
        })
        .unwrap();
    let log = stderr_log(&rig.spec.data_dir);
    assert!(eventually(|| fs::read_to_string(&log)
        .is_ok_and(|text| text.contains(r#"host_result={"type":"host_result","seq":1,"ok":true"#))));
}

#[test]
fn a_page_event_child_streams_events_and_a_takeover_child_asks_once() {
    let rig = Rig::new("page-events:200");
    let child = rig.spawn();
    child.handshake(&hello(), SLOW).unwrap();
    for n in 0..3 {
        assert_eq!(
            next_message(&child),
            ChildMessage::PageEvent {
                topic: "levels".into(),
                data: json!({ "n": n })
            }
        );
    }
    drop(child);

    let rig = Rig::new("takeover");
    let child = rig.spawn();
    child.handshake(&hello(), SLOW).unwrap();
    assert_eq!(next_message(&child), ChildMessage::Takeover { hold: true });
}

#[test]
fn a_stalled_child_answers_pings_again_after_its_stall() {
    let rig = Rig::new("stall-pongs:600");
    let child = rig.spawn();
    child.handshake(&hello(), SLOW).unwrap();
    child.send(&HostMessage::Ping { seq: 1 }).unwrap();
    assert!(child.recv_timeout(Duration::from_millis(200)).is_err());
    let started = Instant::now();
    let mut seq = 1;
    while started.elapsed() < SLOW {
        seq += 1;
        child.send(&HostMessage::Ping { seq }).unwrap();
        if let Ok(Inbound::Message(ChildMessage::Pong { .. })) =
            child.recv_timeout(Duration::from_millis(100))
        {
            return;
        }
    }
    panic!("no pong after the stall");
}

/// A host that records what it sends to the app, reaching no plugin state.
fn bare_host() -> NativeHost {
    NativeHost::new(std::env::temp_dir(), Arc::new(RecordingLink::default()))
}

#[test]
fn shutdown_all_stops_every_child_within_one_grace_period() {
    let host = bare_host();
    let rigs: Vec<Rig> = (0..3).map(|_| Rig::new("ignore-stdin")).collect();
    let mut watches = Vec::new();
    for (n, rig) in rigs.iter().enumerate() {
        let child = rig.spawn();
        child.handshake(&hello(), SLOW).unwrap();
        watches.push(Watch::new(child.pid()));
        let id = format!("com.example.n{n}");
        let run = host.reserve(&id).unwrap();
        assert!(host.adopt(&id, &run, Arc::new(child)));
    }
    let started = Instant::now();
    host.shutdown_all();
    // Each child ignores shutdown and is killed only at the end of its grace, so stopping even two
    // of them one after the other takes two full grace periods.
    assert!(started.elapsed() < 2 * STOP_GRACE);
    for watch in &watches {
        assert!(watch.gone_within(Duration::ZERO));
    }
    assert!((0..3).all(|n| !host.is_running(&format!("com.example.n{n}"))));
}

/// Installs the demo native plugin with the test binary as its entry, answering as `mode`.
fn native_kit(mode: &str) -> Kit {
    native_kit_asking(mode, &[])
}

/// `native_kit` with a manifest that asks for `caps`.
pub(super) fn native_kit_asking(mode: &str, caps: &[&str]) -> Kit {
    let k = Kit::new();
    k.install(&native("1.0.0", caps));
    let exe = plugin_dir(&k.data, ID).join("bin").join("tool.exe");
    fs::copy(std::env::current_exe().unwrap(), exe).unwrap();
    let data = data_dir(&k.data, ID);
    fs::create_dir_all(&data).unwrap();
    fs::write(data.join(MODE_FILE), mode).unwrap();
    k
}

#[test]
fn enable_starts_the_plugin_and_disable_stops_it() {
    let k = native_kit("echo");
    let host = Arc::new(NativeHost::new(
        k.data.clone(),
        Arc::new(RecordingLink::default()),
    ));
    k.plugins.set_starter(host.clone());
    k.plugins.set_stopper(host.clone());

    k.enable(&[]);
    assert!(host.is_running(ID));
    let log = stderr_log(&data_dir(&k.data, ID));
    assert!(eventually(
        || fs::read_to_string(&log).is_ok_and(|text| text.contains("webview2="))
    ));

    crate::plugins::lifecycle::disable(&k.data, &k.plugins, ID).unwrap();
    assert!(!host.is_running(ID));
    assert!(matches!(
        host.start(&k.plugins, ID),
        Err(StartError::NotServing)
    ));

    crate::plugins::lifecycle::enable(&k.data, &k.plugins, ID, None, false, None).unwrap();
    assert!(host.is_running(ID));
    // A second start of a running plugin leaves it alone.
    host.start(&k.plugins, ID).unwrap();
    host.shutdown_all();
    assert!(!host.is_running(ID));
}

#[test]
fn start_refuses_a_ui_plugin_and_a_changed_manifest() {
    let k = native_kit("echo");
    let host = NativeHost::new(k.data.clone(), Arc::new(RecordingLink::default()));
    k.enable(&[]);
    let manifest = plugin_dir(&k.data, ID).join("plugin.json");
    let mut edited = native("1.0.0", &[]);
    edited["name"] = json!("Edited");
    fs::write(&manifest, edited.to_string()).unwrap();
    assert!(matches!(
        host.start(&k.plugins, ID),
        Err(StartError::Changed)
    ));
    assert!(!host.is_running(ID));
    assert_eq!(
        host.status(ID).unwrap().host,
        HostState::Failed {
            reason: super::status::FailReason::Changed
        }
    );

    let k = Kit::new();
    k.install(&ui("1.0.0", &[]));
    k.enable(&[]);
    assert!(matches!(
        host.start(&k.plugins, ID),
        Err(StartError::NotNative)
    ));
}

#[test]
fn starting_the_serving_set_starts_nothing_while_held_or_safe() {
    let k = native_kit("echo");
    k.enable(&[]);
    let host = NativeHost::new(k.data.clone(), Arc::new(RecordingLink::default()));

    // The kit's own boot left its marker behind, so this boot reads as an unclean exit.
    let unclean = k.reboot();
    assert_eq!(unclean.runtime(), Runtime::Held);
    host.start_serving(&unclean);
    assert!(!host.is_running(ID));

    session::clear(&k.data);
    session::set_safe_mode(&k.data, true).unwrap();
    let safe = k.reboot();
    host.start_serving(&safe);
    assert!(!host.is_running(ID));

    session::clear(&k.data);
    session::set_safe_mode(&k.data, false).unwrap();
    let clean = k.reboot();
    assert_eq!(clean.boot_state(), BootState::default());
    host.start_serving(&clean);
    assert!(host.is_running(ID));
    host.shutdown_all();
}

/// A native plugin enabled in a state the host starts, stops and disables through, on a fake clock.
pub(super) struct Supervised {
    pub(super) k: Kit,
    pub(super) plugins: Arc<PluginsState>,
    pub(super) host: NativeHost,
    pub(super) link: Arc<RecordingLink>,
    pub(super) clock: Arc<FakeClock>,
}

impl Supervised {
    pub(super) fn new(mode: &str) -> Supervised {
        Supervised::granted(mode, &[])
    }

    /// A plugin that asks for and is granted `caps`.
    pub(super) fn granted(mode: &str, caps: &[&str]) -> Supervised {
        Supervised::hosted(mode, caps, |host| host)
    }

    /// `granted`, with the host passed through `adapt` before anything else holds it.
    pub(super) fn hosted(
        mode: &str,
        caps: &[&str],
        adapt: impl FnOnce(NativeHost) -> NativeHost,
    ) -> Supervised {
        let k = native_kit_asking(mode, caps);
        k.enable(caps);
        let plugins = Arc::new(k.relaunch());
        let link = Arc::new(RecordingLink::default());
        link.attach(&plugins, &k.data);
        let clock = Arc::new(FakeClock::new());
        let host = adapt(NativeHost::with_clock(
            k.data.clone(),
            link.clone(),
            clock.clone(),
        ));
        plugins.set_starter(Arc::new(host.clone()));
        plugins.set_stopper(Arc::new(host.clone()));
        Supervised {
            k,
            plugins,
            host,
            link,
            clock,
        }
    }

    pub(super) fn start(&self) {
        self.host.start(&self.plugins, ID).unwrap();
    }

    pub(super) fn state(&self) -> Option<HostState> {
        self.host.status(ID).map(|s| s.host)
    }

    /// Waits until the plugin's host state is `host`.
    pub(super) fn reaches(&self, host: HostState) -> bool {
        eventually(|| self.state() == Some(host))
    }

    /// Moves the fake clock on and runs one supervisor step.
    pub(super) fn tick_after(&self, by: Duration) {
        self.clock.advance(by);
        self.host.tick();
    }
}

impl Drop for Supervised {
    fn drop(&mut self) {
        self.host.shutdown_all();
    }
}

#[test]
fn a_crashing_child_restarts_with_backoff_and_the_third_crash_turns_it_off() {
    let s = Supervised::new("crash");
    s.start();
    assert!(s.reaches(HostState::Restarting { retry_in_ms: 1000 }));
    let crash = s.host.status(ID).unwrap().crash.unwrap();
    assert_eq!(crash.reason, CrashReason::Exited);
    assert_eq!(crash.exit_code, Some(3));

    // Not due yet.
    s.tick_after(Duration::from_millis(999));
    assert_eq!(s.state(), Some(HostState::Restarting { retry_in_ms: 1000 }));
    s.tick_after(Duration::from_millis(1));
    assert!(s.reaches(HostState::Restarting { retry_in_ms: 2000 }));
    s.tick_after(Duration::from_secs(2));
    assert!(s.reaches(HostState::CrashLoop));
    // The notice follows the disable.
    assert!(eventually(|| !s.link.notices().is_empty()));
    assert_eq!(s.link.disabled(), [ID]);
    assert!(!s.plugins.is_enabled(ID));
    assert!(!s.k.saved_entry().enabled, "the disable is saved");
    // Nothing restarts it, and the notice went out once.
    s.tick_after(Duration::from_secs(10));
    assert!(!s.host.is_running(ID));
    assert_eq!(s.state(), Some(HostState::CrashLoop));
    let notices = s.link.notices();
    assert_eq!(notices.len(), 1);
    assert_eq!((notices[0].id.as_str(), notices[0].kind), (ID, NoticeKind::AutoDisabled));

    // Enabling again starts afresh.
    crate::plugins::lifecycle::enable(&s.k.data, &s.plugins, ID, None, false, None).unwrap();
    assert!(s.reaches(HostState::Restarting { retry_in_ms: 1000 }));
}

#[test]
fn a_silent_child_goes_not_responding_and_recovers_without_being_killed() {
    let s = Supervised::new("stall-until-file");
    let silences = Arc::new(AtomicUsize::new(0));
    let counted = silences.clone();
    s.host.set_restore_hook(Arc::new(move |id: &str| {
        assert_eq!(id, ID);
        counted.fetch_add(1, Ordering::SeqCst);
    }));
    s.start();
    assert!(s.reaches(HostState::Running));
    let pid = s.host.pid(ID).unwrap();
    for _ in 0..3 {
        s.tick_after(Duration::from_secs(1));
    }
    assert_eq!(s.state(), Some(HostState::NotResponding));
    assert_eq!(silences.load(Ordering::SeqCst), 1);
    // Once its stall is over the child answers the next ping.
    fs::write(data_dir(&s.k.data, ID).join(RESUME_FILE), b"").unwrap();
    assert!(eventually(|| {
        s.tick_after(Duration::from_secs(1));
        s.state() == Some(HostState::Running)
    }));
    assert_eq!(silences.load(Ordering::SeqCst), 1, "the hook ran once");
    assert_eq!(s.host.pid(ID), Some(pid), "the same process");
    assert!(s.host.status(ID).unwrap().crash.is_none());
}

#[test]
fn a_child_that_ignores_its_input_is_only_marked_and_its_stop_is_no_crash() {
    let s = Supervised::new("ignore-stdin");
    s.start();
    assert!(s.reaches(HostState::Running));
    let watch = Watch::new(s.host.pid(ID).unwrap());
    for _ in 0..10 {
        s.tick_after(Duration::from_secs(1));
    }
    assert_eq!(s.state(), Some(HostState::NotResponding));
    assert!(!watch.gone_within(Duration::ZERO), "silence never kills");

    s.host.stop_plugin(ID);
    assert!(watch.gone_within(Duration::ZERO));
    let status = s.host.status(ID).unwrap();
    assert_eq!(status.host, HostState::Off);
    assert!(status.crash.is_none());
    s.tick_after(Duration::from_secs(10));
    assert!(!s.host.is_running(ID));
    assert!(s.link.disabled().is_empty());
}

#[test]
fn a_stop_is_never_a_crash() {
    let s = Supervised::new("echo");
    s.start();
    assert!(s.reaches(HostState::Running));
    let watch = Watch::new(s.host.pid(ID).unwrap());
    crate::plugins::lifecycle::disable(&s.k.data, &s.plugins, ID).unwrap();
    assert!(watch.gone_within(SLOW));
    let status = s.host.status(ID).unwrap();
    assert_eq!(status.host, HostState::Off);
    assert!(status.crash.is_none());
    s.tick_after(Duration::from_secs(10));
    assert!(!s.host.is_running(ID));
    assert!(s.link.notices().is_empty());
    // Every change went out in order.
    let sent: Vec<HostState> = s.link.statuses().iter().map(|s| s.host).collect();
    assert_eq!(
        sent,
        [
            HostState::Starting,
            HostState::Running,
            HostState::Stopping,
            HostState::Off
        ]
    );
}

#[test]
fn a_broken_frame_kills_the_process_as_a_crash() {
    let s = Supervised::new("broken-frame:300");
    s.start();
    assert!(s.reaches(HostState::Running));
    let watch = Watch::new(s.host.pid(ID).unwrap());
    assert!(s.reaches(HostState::Restarting { retry_in_ms: 1000 }));
    assert!(watch.gone_within(SLOW), "the child never exits by itself");
    let crash = s.host.status(ID).unwrap().crash.unwrap();
    assert_eq!(crash.reason, CrashReason::Protocol);
    assert_eq!(crash.exit_code, None);
}

#[test]
fn concurrent_starts_launch_the_plugin_once() {
    let s = Supervised::new("echo");
    thread::scope(|scope| {
        for _ in 0..8 {
            scope.spawn(|| s.host.start(&s.plugins, ID).unwrap());
        }
    });
    assert!(s.reaches(HostState::Running));
    let launches = fs::read_to_string(data_dir(&s.k.data, ID).join(LAUNCHES_FILE)).unwrap();
    assert_eq!(launches.lines().count(), 1);
}

#[test]
fn after_exit_begins_nothing_restarts_or_starts() {
    let s = Supervised::new("crash");
    s.start();
    assert!(s.reaches(HostState::Restarting { retry_in_ms: 1000 }));
    s.host.begin_exit();
    s.tick_after(Duration::from_secs(5));
    assert!(!s.host.is_running(ID));
    assert!(matches!(
        s.host.start(&s.plugins, ID),
        Err(StartError::Exiting)
    ));
    // The reservation itself is refused, whatever path reaches it.
    assert!(s.host.reserve(ID).is_none());
    assert!(!s.host.is_running(ID));
}

#[test]
fn an_exit_is_seen_while_a_helper_holds_the_output_open_and_counted_once() {
    let s = Supervised::new("exit-leaving-helper");
    s.start();
    assert!(s.reaches(HostState::Running));
    let watch = Watch::new(s.host.pid(ID).unwrap());
    assert!(watch.gone_within(SLOW));
    // The output stays open, so only the supervisor's own check can see the exit.
    assert!(eventually(|| {
        s.host.tick();
        s.state() == Some(HostState::Restarting { retry_in_ms: 1000 })
    }));
    let crash = s.host.status(ID).unwrap().crash.unwrap();
    assert_eq!((crash.reason, crash.exit_code), (CrashReason::Exited, Some(3)));
    // Killing the job ends the helper and the output with it; the pump's end of output is the same
    // exit and counts nothing more.
    thread::sleep(Duration::from_millis(300));
    s.host.tick();
    assert_eq!(s.state(), Some(HostState::Restarting { retry_in_ms: 1000 }));
}

#[test]
fn a_silence_seen_after_the_pong_that_ended_it_changes_nothing() {
    let s = Supervised::new("echo");
    let silences = Arc::new(AtomicUsize::new(0));
    let counted = silences.clone();
    s.host.set_restore_hook(Arc::new(move |_: &str| {
        counted.fetch_add(1, Ordering::SeqCst);
    }));
    s.start();
    assert!(s.reaches(HostState::Running));
    let run = s.host.children.lock().unwrap().get(ID).unwrap().clone();
    // The heartbeat is not hung: a late `WentSilent` is dropped.
    s.host.went_silent(ID, &run);
    assert_eq!(s.state(), Some(HostState::Running));
    assert_eq!(silences.load(Ordering::SeqCst), 0);
    // Hung again before a late `Recovered` lands: the child stays not responding.
    let now = s.clock.now();
    let beats = s
        .host
        .children
        .lock()
        .unwrap()
        .get(ID)
        .map(|run| {
            let mut heartbeat = run.heartbeat.lock().unwrap();
            heartbeat.as_mut().unwrap().tick(now + Duration::from_secs(5))
        })
        .unwrap();
    assert!(beats.contains(&super::heartbeat::Beat::WentSilent));
    s.host.went_silent(ID, &run);
    assert_eq!(s.state(), Some(HostState::NotResponding));
    s.host.recovered(ID, &run);
    assert_eq!(s.state(), Some(HostState::NotResponding));
}

#[test]
fn a_due_restart_of_a_plugin_that_no_longer_serves_clears_restarting() {
    let s = Supervised::new("crash");
    s.start();
    assert!(s.reaches(HostState::Restarting { retry_in_ms: 1000 }));
    let withdrawn = s.plugins.withdraw(ID);
    s.tick_after(Duration::from_secs(1));
    assert!(s.reaches(HostState::Off));
    assert!(!s.host.is_running(ID));
    drop(withdrawn);
}

#[test]
fn a_safe_runtime_stops_every_child_and_tells_the_window() {
    let s = Supervised::new("echo");
    s.start();
    assert!(s.reaches(HostState::Running));
    let watch = Watch::new(s.host.pid(ID).unwrap());
    let view = BootView {
        runtime: Runtime::Safe,
        unclean: false,
        safe_flag: false,
    };
    s.host.on_runtime_safe(view);
    assert!(watch.gone_within(Duration::ZERO));
    assert_eq!(s.state(), Some(HostState::Off));
    assert_eq!(s.link.runtimes(), [view]);
}

#[test]
fn a_child_status_and_log_reach_the_board_and_the_plugin_log() {
    let s = Supervised::new("bad-status");
    s.start();
    assert!(s.reaches(HostState::Running));
    assert!(eventually(|| s
        .host
        .status(ID)
        .is_some_and(|status| status.reported.is_some())));
    let status = s.host.status(ID).unwrap();
    assert_eq!(status.protocol_errors, 3);
    let reported = status.reported.unwrap();
    assert_eq!(reported.state, ReportedState::Idle);
    assert_eq!(reported.text.as_deref(), Some("fine"));

    let s = Supervised::new("spawn-grandchild");
    s.start();
    let log = crate::plugins::paths::log_file(&s.k.data, ID);
    assert!(eventually(|| fs::read_to_string(&log)
        .is_ok_and(|text| text.contains(" INFO grandchild="))));
}

// ---- Feed delivery ----

/// A snapshot's state, on a device whose name carries a person's name.
fn feed_state(volume: f32) -> FeedState {
    FeedState {
        transport: Transport::Playing,
        sample_rate: 44_100,
        channels: 2,
        position_secs: 1.0,
        volume,
        device: Some("John's AirPods".into()),
        device_id: Some("{0.0.0.00000000}.{airpods}".into()),
        latency_ms: 10.0,
    }
}

impl Supervised {
    /// The child's stderr log; a read error comes back as text, so a failed assertion shows it.
    pub(super) fn stderr(&self) -> String {
        fs::read_to_string(stderr_log(&data_dir(&self.k.data, ID)))
            .unwrap_or_else(|e| format!("<stderr log unreadable: {e}>"))
    }

    /// Waits until the stderr log holds `want`.
    pub(super) fn logs(&self, want: &str) -> bool {
        eventually(|| self.stderr().contains(want))
    }

    /// The `feed` frames the child received, in order.
    fn feeds(&self) -> Vec<Value> {
        self.stderr()
            .lines()
            .filter_map(|line| line.strip_prefix("feed="))
            .filter_map(|json| serde_json::from_str(json).ok())
            .collect()
    }

    fn feed_wanted(&self) -> bool {
        self.link.feed_hub().wanted()
    }

    /// Whether every feed consumer attached so far was detached exactly once.
    fn feeds_detached_once(&self) -> bool {
        let (mut attached, mut detached) = self.link.feed_consumers();
        attached.sort_unstable();
        detached.sort_unstable();
        attached == detached
    }
}

#[test]
fn a_tap_child_gets_the_tap_name_on_its_argv() {
    let s = Supervised::granted("echo", &["audio.tap"]);
    s.start();
    assert!(s.reaches(HostState::Running));
    assert!(s.feed_wanted());
    // Debug quoting doubles the backslash in `Local\plisto-tap-<pid>-<nonce>`.
    let tap = format!("{:?}", r"Local\plisto-tap-");
    let tap = tap.trim_end_matches('"');
    let want = format!(r#""--plisto-tap", {tap}"#);
    assert!(s.logs(&want), "{}", s.stderr());
    // Without `audio.events` nothing is forwarded, so no snapshot is asked for.
    assert_eq!(s.link.snapshot_requests(), 0);
}

#[test]
fn an_events_child_gets_no_tap_a_snapshot_and_feed_frames_without_device_fields() {
    let s = Supervised::granted("echo", &["audio.events"]);
    s.start();
    assert!(s.reaches(HostState::Running));
    assert!(s.logs(r#""--plisto-tap", "none""#), "{}", s.stderr());
    assert!(eventually(|| s.link.snapshot_requests() == 1));
    s.link
        .feed_hub()
        .publish(FeedCause::Volume, feed_state(0.5));
    assert!(eventually(|| !s.feeds().is_empty()));
    let frame = &s.feeds()[0];
    assert_eq!(frame["lost"], 0);
    let event = &frame["event"];
    assert_eq!(event["cause"], "volume");
    assert_eq!(event["volume"], 0.5);
    assert_eq!(event["latency_ms"], 10.0);
    assert!(event["device"].is_null());
    assert!(event["device_id"].is_null());
}

#[test]
fn the_device_fields_reach_a_child_granted_audio_device() {
    let s = Supervised::granted("echo", &["audio.events", "audio.device"]);
    s.start();
    assert!(s.reaches(HostState::Running));
    s.link
        .feed_hub()
        .publish(FeedCause::Device, feed_state(1.0));
    assert!(eventually(|| !s.feeds().is_empty()));
    let event = &s.feeds()[0]["event"];
    assert_eq!(event["device"], "John's AirPods");
    assert_eq!(event["device_id"], "{0.0.0.00000000}.{airpods}");
}

#[test]
fn a_child_with_neither_grant_gets_no_consumer() {
    let s = Supervised::new("echo");
    s.start();
    assert!(s.reaches(HostState::Running));
    assert!(!s.feed_wanted());
    assert_eq!(s.link.feed_consumers(), (vec![], vec![]));
    assert!(s.logs(r#""--plisto-tap", "none""#), "{}", s.stderr());
    assert_eq!(s.link.snapshot_requests(), 0);
}

#[test]
fn a_full_outbox_counts_into_lost() {
    let s = Supervised::granted("read-after-file", &["audio.events"]);
    s.start();
    assert!(s.reaches(HostState::Running));
    let hub = s.link.feed_hub();
    // The child reads nothing yet, so its pipe and then the outbox fill and frames are refused.
    let mut published = 0u64;
    for _ in 0..50 {
        for _ in 0..16 {
            hub.publish(FeedCause::Volume, feed_state(0.5));
            published += 1;
        }
        thread::sleep(Duration::from_millis(2));
    }
    fs::write(data_dir(&s.k.data, ID).join(RESUME_FILE), b"").unwrap();
    // Once the child reads again, a new snapshot gets through.
    assert!(eventually(|| {
        hub.publish(FeedCause::Volume, feed_state(0.5));
        published += 1;
        s.feeds()
            .last()
            .is_some_and(|frame| frame["event"]["seq"] == published)
    }));
    let feeds = s.feeds();
    let seqs: Vec<u64> = feeds.iter().map(|f| f["event"]["seq"].as_u64().unwrap()).collect();
    let lost: Vec<u64> = feeds.iter().map(|f| f["lost"].as_u64().unwrap()).collect();
    // Every snapshot is either delivered or counted on the next frame that is.
    assert_eq!(lost[0], seqs[0] - 1);
    for i in 1..seqs.len() {
        assert_eq!(lost[i], seqs[i] - seqs[i - 1] - 1, "frame {i}");
    }
    assert!(lost.iter().sum::<u64>() > 0);
}

#[test]
fn a_stop_a_restart_and_a_disable_detach_and_a_restart_attaches_afresh() {
    let s = Supervised::granted("echo", &["audio.tap", "audio.events"]);
    s.start();
    assert!(s.reaches(HostState::Running));
    assert!(eventually(|| s.link.snapshot_requests() == 1));

    s.host.restart(&s.plugins, ID).unwrap();
    assert!(s.reaches(HostState::Running));
    assert!(s.feed_wanted());
    assert!(eventually(|| s.link.snapshot_requests() == 2));
    let (attached, detached) = s.link.feed_consumers();
    assert_eq!((attached.len(), detached.len()), (2, 1));

    s.host.stop_plugin(ID);
    assert!(!s.feed_wanted());
    assert!(s.feeds_detached_once());

    crate::plugins::lifecycle::enable(&s.k.data, &s.plugins, ID, None, false, None).unwrap();
    assert!(s.reaches(HostState::Running));
    assert!(s.feed_wanted());
    crate::plugins::lifecycle::disable(&s.k.data, &s.plugins, ID).unwrap();
    assert!(!s.feed_wanted());
    assert!(s.feeds_detached_once());
}

#[test]
fn a_crash_before_or_after_ready_detaches_once() {
    let s = Supervised::granted("crash", &["audio.tap", "audio.events"]);
    s.start();
    assert!(s.reaches(HostState::Restarting { retry_in_ms: 1000 }));
    assert!(!s.feed_wanted());
    assert!(s.feeds_detached_once());
    assert_eq!(s.link.feed_consumers().0.len(), 1);
    // It never got to `ready`, so no snapshot was asked for.
    assert_eq!(s.link.snapshot_requests(), 0);

    let s = Supervised::granted("broken-frame:300", &["audio.events"]);
    s.start();
    assert!(s.reaches(HostState::Running));
    assert!(s.reaches(HostState::Restarting { retry_in_ms: 1000 }));
    assert!(!s.feed_wanted());
    assert!(s.feeds_detached_once());
    s.host.shutdown_all();
    assert!(s.feeds_detached_once());
}

#[test]
fn exit_and_safe_mode_detach_every_feed() {
    let s = Supervised::granted("echo", &["audio.events"]);
    s.start();
    assert!(s.reaches(HostState::Running));
    assert!(s.feed_wanted());
    s.host.begin_exit();
    s.host.shutdown_all();
    assert!(!s.feed_wanted());
    assert!(s.feeds_detached_once());

    let s = Supervised::granted("echo", &["audio.tap"]);
    s.start();
    assert!(s.reaches(HostState::Running));
    assert!(s.feed_wanted());
    s.host.on_runtime_safe(BootView {
        runtime: Runtime::Safe,
        unclean: false,
        safe_flag: false,
    });
    assert!(!s.feed_wanted());
    assert!(s.feeds_detached_once());
}

#[test]
fn a_launch_refused_by_windows_detaches_once() {
    let s = Supervised::granted("echo", &["audio.tap", "audio.events"]);
    // A folder where the stderr log goes makes the launch fail with access denied.
    let log = stderr_log(&data_dir(&s.k.data, ID));
    let _ = fs::remove_file(&log);
    fs::create_dir_all(&log).unwrap();
    assert!(matches!(
        s.host.start(&s.plugins, ID),
        Err(StartError::Launch(_))
    ));
    assert_eq!(
        s.state(),
        Some(HostState::Failed {
            reason: super::status::FailReason::LaunchDenied
        })
    );
    assert!(!s.feed_wanted());
    assert_eq!(s.link.feed_consumers().0.len(), 1);
    assert!(s.feeds_detached_once());
}

#[test]
fn a_launch_that_cannot_run_the_entry_detaches_once() {
    let s = Supervised::granted("echo", &["audio.tap", "audio.events"]);
    // Not a valid executable: Windows refuses to create the process.
    let exe = plugin_dir(&s.k.data, ID).join("bin").join("tool.exe");
    fs::write(&exe, b"MZ").unwrap();
    assert!(matches!(
        s.host.start(&s.plugins, ID),
        Err(StartError::Launch(_))
    ));
    assert_eq!(s.state(), Some(HostState::Restarting { retry_in_ms: 1000 }));
    assert!(!s.feed_wanted());
    assert_eq!(s.link.feed_consumers().0.len(), 1);
    assert!(s.feeds_detached_once());
}
