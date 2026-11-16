/*
 * Process tests for the seated stream's events reaching a native owner: what the child hears, what a
 * full outbox costs, and the owners that are not native or have no child to hear.
 */

// -- Library Imports --
use std::fs;
use std::io;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use image::DynamicImage;
use serde_json::{json, Value};

// -- Local Imports --
use super::child::SendError;
use super::link::{HostLink, RecordingLink};
use super::protocol::HostMessage;
use super::status::HostState;
use super::test_child::{MODE_FILE, RESUME_FILE};
use super::tests::{eventually, Supervised};
use super::{FakeClock, NativeHost};
use crate::adhoc::AdHocTrack;
use crate::audio::stream::{DecodeEnd, PcmQueue, StreamInput};
use crate::audio::{PlayerCmd, StreamEndReason};
use crate::plugins::api::stream::test_link::FakeLink;
use crate::plugins::api::stream::{StreamEndNotice, StreamEvent, StreamLink, StreamNow};
use crate::plugins::paths::{data_dir, plugin_dir};
use crate::plugins::test_kit::{native, Kit, ID};

const STREAM: &str = "playback.stream";

fn ended() -> StreamEvent {
    StreamEvent::Ended {
        item: -4,
        reason: StreamEndReason::Stopped,
        detail: None,
    }
}

const ORIGIN: &str = "https://radio.example.com";

/// The hub's fake link, with the owner's events also going to the native host as in the app.
struct ForwardLink {
    inner: Arc<FakeLink>,
    host: NativeHost,
}

impl StreamLink for ForwardLink {
    fn send(&self, cmd: PlayerCmd) -> bool {
        self.inner.send(cmd)
    }

    fn decode(
        &self,
        input: StreamInput,
        queue: PcmQueue,
        on_end: Box<dyn FnOnce(DecodeEnd) + Send>,
    ) -> io::Result<()> {
        self.inner.decode(input, queue, on_end)
    }

    fn stash(&self, id: i64, track: Option<AdHocTrack>) {
        self.inner.stash(id, track);
    }

    fn now(&self, now: Option<&StreamNow>) {
        self.inner.now(now);
    }

    fn ended(&self, notice: &StreamEndNotice) {
        self.inner.ended(notice);
    }

    fn owner(&self, id: &str, event: StreamEvent) {
        self.host.deliver_stream(id, &event);
        self.inner.owner(id, event);
    }

    fn cache_art(&self, hash: &str, image: &DynamicImage) -> bool {
        self.inner.cache_art(hash, image)
    }

    fn position(&self, id: i64) -> Option<f64> {
        self.inner.position(id)
    }
}

/// A native plugin granted `playback.stream` (and `network` with `ORIGIN` listed when `pull`), whose
/// stream hub talks to a fake engine link and delivers owner events to its child.
fn streaming(mode: &str, pull: bool) -> (Supervised, Arc<FakeLink>) {
    let caps: &[&str] = if pull { &[STREAM, "network"] } else { &[STREAM] };
    let k = Kit::new();
    let mut manifest = native("1.0.0", caps);
    if pull {
        manifest["network"] = json!([ORIGIN]);
    }
    k.install(&manifest);
    let exe = plugin_dir(&k.data, ID).join("bin").join("tool.exe");
    fs::copy(std::env::current_exe().unwrap(), exe).unwrap();
    let data = data_dir(&k.data, ID);
    fs::create_dir_all(&data).unwrap();
    fs::write(data.join(MODE_FILE), mode).unwrap();
    k.enable(caps);

    let plugins = Arc::new(k.relaunch());
    let link = Arc::new(RecordingLink::default());
    link.attach(&plugins, &k.data);
    let clock = Arc::new(FakeClock::new());
    let host = NativeHost::with_clock(k.data.clone(), link.clone(), clock.clone());
    plugins.set_starter(Arc::new(host.clone()));
    plugins.set_stopper(Arc::new(host.clone()));
    let covers = k.data.join("covers");
    fs::create_dir_all(&covers).unwrap();
    let mut fake = FakeLink::default();
    fake.covers = covers;
    let fake = Arc::new(fake);
    let forward = ForwardLink {
        inner: fake.clone(),
        host: host.clone(),
    };
    plugins.api().streams().attach(Arc::new(forward));
    let s = Supervised {
        k,
        plugins,
        host,
        link,
        clock,
    };
    (s, fake)
}

#[test]
fn a_native_child_pushes_and_receives_ended_on_stop() {
    let (s, fake) = streaming("stream-push", false);
    s.start();
    assert!(s.reaches(HostState::Running));

    assert!(eventually(|| !s.stream_frames().is_empty()), "{}", s.stderr());
    let seat = fake.starts().pop().expect("the engine was asked to seat the item");
    let heard = s.stream_frames();
    let ended = &heard[0]["event"];
    assert_eq!(ended["kind"], "ended");
    assert_eq!(ended["reason"], "stopped");
    assert_eq!(ended["item"], seat.id);
    assert!(s.plugins.api().streams().now().is_none());
}

#[test]
fn a_crashed_push_child_ends_producer_gone() {
    let (s, fake) = streaming("stream-push:1", false);
    s.start();
    assert!(s.reaches(HostState::Restarting { retry_in_ms: 1000 }));

    assert_eq!(fake.starts().len(), 1);
    let ends = fake.ends.lock().unwrap();
    assert_eq!(ends.len(), 1);
    assert_eq!(ends[0].reason, StreamEndReason::ProducerGone);
    drop(ends);
    assert!(s.plugins.api().streams().now().is_none());
}

#[test]
fn a_crashed_child_leaves_a_pull_stream_playing() {
    let (s, fake) = streaming("stream-pull:1", true);
    // The rig's host has no network engine, so the pull item seats without a feeder: no DNS lookup
    // and no socket.
    assert!(HostLink::api_host(&*s.link).net().is_none());
    s.start();
    assert!(s.reaches(HostState::Restarting { retry_in_ms: 1000 }));

    let seat = fake.starts().pop().expect("the engine was asked to seat the item");
    let now = s.plugins.api().streams().now().expect("the item is still seated");
    assert_eq!(now.item, seat.id);
    assert!(fake.ends.lock().unwrap().is_empty());
    assert!(fake.stream_ends().is_empty());
}

impl Supervised {
    /// Every `stream` frame the child received, in order.
    fn stream_frames(&self) -> Vec<Value> {
        self.stderr()
            .lines()
            .filter_map(|line| line.strip_prefix("stream="))
            .filter_map(|json| serde_json::from_str(json).ok())
            .collect()
    }
}

#[test]
fn a_native_owner_child_hears_the_event_its_frame_gets() {
    let s = Supervised::granted("echo", &[STREAM]);
    s.start();
    assert!(s.reaches(HostState::Running));

    s.host.deliver_stream(ID, &ended());
    assert!(eventually(|| !s.stream_frames().is_empty()), "{}", s.stderr());
    assert_eq!(
        s.stream_frames()[0],
        json!({ "type": "stream", "event": {
            "kind": "ended", "item": -4, "reason": "stopped", "detail": null
        }})
    );
}

#[test]
fn an_owner_that_is_not_a_native_plugin_reaches_no_child() {
    let s = Supervised::granted("echo", &[STREAM]);
    s.start();
    assert!(s.reaches(HostState::Running));

    s.host.deliver_stream("com.example.elsewhere", &ended());
    assert!(s.stream_frames().is_empty());
}

#[test]
fn an_event_with_no_current_child_is_dropped() {
    let s = Supervised::granted("echo", &[STREAM]);
    s.start();
    assert!(s.reaches(HostState::Running));
    s.host.ready_run(ID).unwrap().1.kill();
    assert!(s.reaches(HostState::Restarting { retry_in_ms: 1000 }));

    s.host.deliver_stream(ID, &ended());
    assert!(s.stream_frames().is_empty());
}

#[test]
fn a_full_outbox_drops_the_stream_event_and_counts_it() {
    let s = Supervised::granted("read-after-file", &[STREAM]);
    s.start();
    assert!(s.reaches(HostState::Running));
    let (run, child) = s.host.ready_run(ID).unwrap();
    let big = HostMessage::Feed {
        event: json!("y".repeat(64 * 1024)),
        lost: 0,
    };
    let mut filled = 0;
    let mut full = false;
    for _ in 0..10_000 {
        if child.send(&big) == Err(SendError::Full) {
            full = true;
            break;
        }
        filled += 1;
    }
    assert!(full);

    s.host.deliver_stream(ID, &ended());
    assert_eq!(run.stats.stream_dropped.load(Ordering::Relaxed), 1);

    // The child reads again: it hears every frame that filled the outbox, then a later one, and
    // never the dropped event.
    fs::write(data_dir(&s.k.data, ID).join(RESUME_FILE), b"").unwrap();
    assert!(eventually(|| child
        .send(&HostMessage::Page { open: false })
        .is_ok()));
    let lines_of = |name: &str| {
        let prefix = format!("{name}=");
        s.stderr().lines().filter(|line| line.starts_with(&prefix)).count()
    };
    assert!(eventually(|| lines_of("feed") == filled && lines_of("page") >= 1), "{filled}");
    assert!(s.stream_frames().is_empty(), "the dropped event is not sent later");
    assert_eq!(run.stats.stream_dropped.load(Ordering::Relaxed), 1);
}
