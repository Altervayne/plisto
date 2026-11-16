/*
 * End-to-end test of the kit's native example, `plugin-kit/examples/tap-meter`. The program is built
 * with cargo, laid out as its `pack.ps1` does, installed through the real install and enable path and
 * run by the real native host, so the journey in the native docs is checked with a program built from
 * the kit and not with the re-exec test child. Every step waits on a condition; the heartbeat runs on
 * the host's fake clock. Cargo's build output goes to `target/native-sample` beside the app's own, so
 * later runs only relink.
 */

// -- Library Imports --
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

// -- Local Imports --
use super::launch::stderr_log;
use super::link::RecordingLink;
use super::status::HostState;
use super::tests::{eventually, Supervised, Watch};
use super::{lock, FakeClock, NativeHost};
use crate::audio::{FeedCause, FeedSource, FeedState, Transport};
use crate::plugins::api::error::ApiCode;
use crate::plugins::api::events::{Side, Topic};
use crate::plugins::install::{inspect, install};
use crate::plugins::lifecycle::enable;
use crate::plugins::paths::data_dir;
use crate::plugins::stage::Limits;
use crate::plugins::test_kit::{grants, Kit};

const SAMPLE_ID: &str = "dev.plisto.tapmeter";

fn sample_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugin-kit/examples/tap-meter")
}

/// Builds the example in the debug profile and returns the path of its executable.
fn build_sample() -> PathBuf {
    let target = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/native-sample");
    let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    let out = Command::new(&cargo)
        .args(["build", "--manifest-path"])
        .arg(sample_dir().join("Cargo.toml"))
        .arg("--target-dir")
        .arg(&target)
        .output()
        .unwrap_or_else(|e| {
            panic!("cannot run cargo ({cargo:?}): {e}; this test needs cargo on PATH")
        });
    assert!(
        out.status.success(),
        "cargo build of tap-meter failed:\n{}",
        String::from_utf8_lossy(&out.stderr)
    );
    target.join("debug/tap-meter.exe")
}

/// Lays out `plugin.json`, the executable at the manifest's `entry` and the manifest's page folder
/// under `dest`, as `pack.ps1` does, and returns the manifest.
fn stage_sample(exe: &Path, dest: &Path) -> Value {
    let text = fs::read_to_string(sample_dir().join("plugin.json")).unwrap();
    let manifest: Value = serde_json::from_str(&text).unwrap();
    fs::create_dir_all(dest).unwrap();
    fs::write(dest.join("plugin.json"), &text).unwrap();
    let entry = dest.join(manifest["entry"].as_str().unwrap());
    fs::create_dir_all(entry.parent().unwrap()).unwrap();
    fs::copy(exe, entry).unwrap();
    let page = Path::new(manifest["page"].as_str().unwrap())
        .parent()
        .unwrap();
    fs::create_dir_all(dest.join(page)).unwrap();
    for file in fs::read_dir(sample_dir().join(page)).unwrap() {
        let file = file.unwrap();
        fs::copy(file.path(), dest.join(page).join(file.file_name())).unwrap();
    }
    manifest
}

/// The sample installed and enabled in a throwaway app data folder, hosted by a real `NativeHost`
/// on a fake clock.
fn hosted(exe: &Path) -> Supervised {
    let k = Kit::new();
    let source = k.data.parent().unwrap().join("sample-source");
    let manifest = stage_sample(exe, &source);
    let granted: Vec<&str> = manifest["capabilities"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect();
    let inspected = inspect(
        &k.data,
        &k.plugins,
        source.to_str().unwrap(),
        Limits::DEFAULT,
    )
    .unwrap();
    install(&k.data, &k.plugins, &inspected.token, 10).unwrap();
    let hash = k
        .plugins
        .snapshot()
        .entry(SAMPLE_ID)
        .unwrap()
        .manifest_hash
        .clone();
    enable(
        &k.data,
        &k.plugins,
        SAMPLE_ID,
        Some(&grants(&granted)),
        true,
        Some(&hash),
    )
    .unwrap();

    let plugins = Arc::new(k.relaunch());
    let link = Arc::new(RecordingLink::default());
    link.attach(&plugins, &k.data);
    let clock = Arc::new(FakeClock::new());
    let host = NativeHost::with_clock(k.data.clone(), link.clone(), clock.clone());
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

impl Supervised {
    /// The sample's stderr log: its own log lines and its argv.
    fn sample_log(&self) -> String {
        let log = stderr_log(&data_dir(&self.k.data, SAMPLE_ID));
        fs::read_to_string(log).unwrap_or_default()
    }

    fn sample_state(&self) -> Option<HostState> {
        self.host.status(SAMPLE_ID).map(|status| status.host)
    }

    fn sample_logs(&self, want: &str) -> bool {
        eventually(|| self.sample_log().contains(want))
    }

    /// The highest ping seq the run's heartbeat has taken a pong for. The heartbeat keeps it
    /// private; its `Debug` output names it.
    fn pongs(&self) -> u64 {
        let children = lock(&self.host.children);
        let Some(run) = children.get(SAMPLE_ID) else {
            return 0;
        };
        let shown = format!("{:?}", *lock(&run.heartbeat));
        shown
            .split("last_pong_seq: ")
            .nth(1)
            .and_then(|rest| rest.split(',').next())
            .and_then(|n| n.trim().parse().ok())
            .unwrap_or(0)
    }
}

fn playing(volume: f32) -> FeedState {
    FeedState {
        transport: Transport::Playing,
        sample_rate: 44_100,
        channels: 2,
        position_secs: 1.0,
        volume,
        device: Some("Speakers".into()),
        device_id: Some("{0.0.0.00000000}.{speakers}".into()),
        latency_ms: 10.0,
        source: FeedSource::Track,
        live: false,
    }
}

#[test]
#[ignore = "builds the tap-meter example with cargo and runs it as a real child; run with --ignored"]
fn native_sample_end_to_end() {
    let exe = build_sample();
    let s = hosted(&exe);
    s.host.start(&s.plugins, SAMPLE_ID).unwrap();

    // Handshake: `hello` went out and `ready` came back.
    assert!(
        eventually(|| s.sample_state() == Some(HostState::Running)),
        "{}",
        s.sample_log()
    );
    let pid = s.host.pid(SAMPLE_ID).unwrap();
    assert!(
        s.sample_logs(&format!("{SAMPLE_ID} on Plisto")),
        "{}",
        s.sample_log()
    );
    assert!(s.sample_log().contains("granted playback.read"));

    // The tap the host created is on its argv and the program opened it.
    assert!(
        s.sample_logs(r"tap opened: Local\plisto-tap-"),
        "{}",
        s.sample_log()
    );

    // Its own host calls are answered: the subscription is held on the child side, the program logs
    // the topics accepted and each value current, and none of its calls was refused.
    assert!(
        s.sample_logs("subscribed to locale, playback_state"),
        "{}",
        s.sample_log()
    );
    let events = s.plugins.api().events();
    assert_eq!(
        events.topics_of(SAMPLE_ID, Side::Child),
        [Topic::PlaybackState, Topic::Locale]
    );
    assert!(
        s.sample_logs("current locale: en"),
        "{}",
        s.sample_log()
    );
    assert!(!s.sample_log().contains("refused"), "{}", s.sample_log());
    assert!(
        !s.sample_log().contains("is not open"),
        "{}",
        s.sample_log()
    );

    // Heartbeat: three rounds of a ping on the fake clock, each answered by a pong.
    for round in 1..=3u64 {
        s.tick_after(Duration::from_secs(1));
        assert!(eventually(|| s.pongs() == round), "round {round}");
    }
    assert_eq!(s.sample_state(), Some(HostState::Running));

    // Events: delivered to the child and logged by it. Each is numbered after the subscribe's mark,
    // as the hub numbers a value produced after the answer.
    let locale = json!({ "locale": "fr" });
    let state = json!({ "transport": "playing", "start_seq": 3, "seek_seq": 1 });
    let mark = events.mark_of(SAMPLE_ID, Side::Child);
    assert_eq!(
        s.host.deliver_event(SAMPLE_ID, "locale", &locale, mark + 1),
        crate::plugins::api::events::ChildDelivery::Sent
    );
    assert_eq!(
        s.host.deliver_event(SAMPLE_ID, "playback_state", &state, mark + 2),
        crate::plugins::api::events::ChildDelivery::Sent
    );
    assert!(s.sample_logs("event locale: fr"), "{}", s.sample_log());
    assert!(
        s.sample_logs("event playback_state: playing, start 3, seek 1"),
        "{}",
        s.sample_log()
    );

    // Feed: the snapshot was requested after `ready`, and a published change reaches the program.
    assert_eq!(s.link.snapshot_requests(), 1);
    s.link.feed_hub().publish(FeedCause::Device, playing(1.0));
    assert!(s.sample_logs("feed device: playing"), "{}", s.sample_log());
    assert!(
        s.sample_logs("output device id {0.0.0.00000000}.{speakers}"),
        "{}",
        s.sample_log()
    );

    // The program reports its state: the tap is open and silent, as nothing writes samples.
    assert!(eventually(|| {
        s.host.tick();
        s.host
            .status(SAMPLE_ID)
            .and_then(|status| status.reported)
            .is_some_and(|r| r.text.as_deref() == Some("silent"))
    }));

    // The page is shown, and the program starts its level events.
    s.host.notify_page(SAMPLE_ID, true);
    assert!(
        s.sample_logs("page open: sending levels"),
        "{}",
        s.sample_log()
    );

    // A page call is relayed to the program and answered; an unknown method is a plugin error.
    let pong = s.host.relay(SAMPLE_ID, "ping", json!({})).unwrap();
    assert_eq!(pong["pong"], true);
    let unknown = s.host.relay(SAMPLE_ID, "nope", json!({})).unwrap_err();
    assert_eq!(unknown.code, ApiCode::PluginError);
    assert!(
        unknown.message.contains("no method 'nope'"),
        "{}",
        unknown.message
    );

    // A clean stop: the process ends, no crash is recorded, the plugin stays enabled and the feed
    // consumer is detached.
    let watch = Watch::new(pid);
    s.host.stop_plugin(SAMPLE_ID);
    assert!(watch.gone_within(Duration::from_secs(10)));
    let status = s.host.status(SAMPLE_ID).unwrap();
    assert_eq!(status.host, HostState::Off);
    assert!(status.crash.is_none());
    assert_eq!(status.protocol_errors, 0);
    assert!(s.link.disabled().is_empty());
    let (attached, detached) = s.link.feed_consumers();
    assert_eq!(attached, detached);
}
