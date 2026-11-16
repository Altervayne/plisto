/*
 * The stream hub's test bench: a fake link that records what the hub sends the engine and the
 * windows, and a plugin state serving the plugins a test names. The test plays the engine itself:
 * it takes the `StreamStart` the hub sent and drives the item's control, queue and signals.
 *
 * `pcm_s16le` decodes for real, in-process. A container input is read and thrown away by a stand-in
 * that never yields audio, the way a decode helper caught in a read loop behaves.
 */

// -- Library Imports --
use std::cell::Cell;
use std::collections::HashMap;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;

// -- Local Imports --
use super::link::{OnEnd, StreamLink};
use super::{StreamEndNotice, StreamEvent, StreamNow};
use crate::adhoc::AdHocTrack;
use crate::audio::stream::{spawn_decoder, DecodeEnd, PcmQueue, StreamInput};
use crate::audio::{PlayerCmd, StreamItem};
use crate::commands::covers::{DETAIL_EDGE, THUMB_EDGE};
use crate::covers::{ensure_thumbs_from, InFlightGuard};
use crate::db;
use crate::plugins::api::error::ApiError;
use crate::plugins::api::state::ApiState;
use crate::plugins::api::{admit_from, run, Caller, FakeHost};
use crate::plugins::manifest::{Capability, Tier};
use crate::plugins::registry::{Entry, EntryState, Registry};
use crate::plugins::revalidate::Problems;
use crate::plugins::session::BootState;
use crate::plugins::stage::Temp;
use crate::plugins::state::PluginsState;
use crate::state::AppState;

pub const A: &str = "com.example.alpha";
pub const B: &str = "com.example.beta";
pub const RADIO: &str = "https://radio.example.com";

#[derive(Default)]
pub struct FakeLink {
    pub engine_gone: AtomicBool,
    pub sent: Mutex<Vec<PlayerCmd>>,
    pub stash: Mutex<HashMap<i64, AdHocTrack>>,
    pub nows: Mutex<Vec<Option<StreamNow>>>,
    pub ends: Mutex<Vec<StreamEndNotice>>,
    pub events: Mutex<Vec<(String, StreamEvent)>>,
    // Bytes the stand-in decoder has read and thrown away.
    pub media_read: Arc<AtomicU64>,
    // Container decodes started, one per epoch of a pull item.
    pub media_decodes: AtomicU64,
    pub covers: PathBuf,
    guard: InFlightGuard,
    // Artwork writes running now, the most ever at once, and how long each one holds on.
    pub art_running: AtomicU64,
    pub art_most: AtomicU64,
    pub art_hold: Mutex<Duration>,
}

impl FakeLink {
    /// The items the engine was asked to seat, in order; every other command stays recorded.
    pub fn starts(&self) -> Vec<StreamItem> {
        let mut sent = self.sent.lock().unwrap();
        let mut starts = Vec::new();
        let mut rest = Vec::new();
        for cmd in sent.drain(..) {
            match cmd {
                PlayerCmd::StreamStart(item) => starts.push(item),
                other => rest.push(other),
            }
        }
        *sent = rest;
        starts
    }

    /// The ids and reasons of every `StreamEnd` sent.
    pub fn stream_ends(&self) -> Vec<(i64, crate::audio::StreamEndReason)> {
        self.sent
            .lock()
            .unwrap()
            .iter()
            .filter_map(|cmd| match cmd {
                PlayerCmd::StreamEnd { id, reason } => Some((*id, *reason)),
                _ => None,
            })
            .collect()
    }

    pub fn owner_events(&self, id: &str) -> Vec<StreamEvent> {
        let events = self.events.lock().unwrap();
        events
            .iter()
            .filter(|(owner, _)| owner == id)
            .map(|(_, event)| event.clone())
            .collect()
    }
}

/// Reads and drops bytes until the source ends, never queueing audio.
fn read_forever(
    mut source: Box<dyn Read + Send>,
    read: Arc<AtomicU64>,
    queue: PcmQueue,
    on_end: OnEnd,
) {
    let mut buf = [0u8; 4096];
    let end = loop {
        match source.read(&mut buf) {
            Ok(0) => break DecodeEnd::Failed(crate::audio::stream::Unsupported::Format),
            Ok(n) => {
                read.fetch_add(n as u64, Ordering::AcqRel);
            }
            Err(_) if queue.control().is_cancelled() => break DecodeEnd::Cancelled,
            Err(_) => break DecodeEnd::SourceBroken,
        }
    };
    on_end(end);
}

impl StreamLink for FakeLink {
    fn send(&self, cmd: PlayerCmd) -> bool {
        if self.engine_gone.load(Ordering::Acquire) {
            return false;
        }
        self.sent.lock().unwrap().push(cmd);
        true
    }

    fn decode(&self, input: StreamInput, queue: PcmQueue, on_end: OnEnd) -> io::Result<()> {
        match input {
            StreamInput::Media { source, .. } => {
                self.media_decodes.fetch_add(1, Ordering::AcqRel);
                let read = Arc::clone(&self.media_read);
                thread::Builder::new()
                    .name("test-stream-reader".into())
                    .spawn(move || read_forever(Box::new(source), read, queue, on_end))
                    .map(drop)
            }
            input => spawn_decoder(input, queue, on_end).map(drop),
        }
    }

    fn stash(&self, id: i64, track: Option<AdHocTrack>) {
        let mut stash = self.stash.lock().unwrap();
        match track {
            Some(track) => stash.insert(id, track),
            None => stash.remove(&id),
        };
    }

    fn now(&self, now: Option<&StreamNow>) {
        self.nows.lock().unwrap().push(now.cloned());
    }

    fn ended(&self, notice: &StreamEndNotice) {
        self.ends.lock().unwrap().push(notice.clone());
    }

    fn owner(&self, id: &str, event: StreamEvent) {
        self.events.lock().unwrap().push((id.to_string(), event));
    }

    fn cache_art(&self, hash: &str, image: &image::DynamicImage) -> bool {
        let running = self.art_running.fetch_add(1, Ordering::AcqRel) + 1;
        self.art_most.fetch_max(running, Ordering::AcqRel);
        thread::sleep(*self.art_hold.lock().unwrap());
        let edges = [THUMB_EDGE, DETAIL_EDGE];
        let written = ensure_thumbs_from(&self.covers, hash, image, &edges, &self.guard).is_ok();
        self.art_running.fetch_sub(1, Ordering::AcqRel);
        written
    }

    fn position(&self, _id: i64) -> Option<f64> {
        Some(12.5)
    }
}

/// One plugin of the bench: its id, tier and grants. A `network` grant consents to `RADIO`.
pub struct Plugin(pub &'static str, pub Tier, pub &'static [Capability]);

pub struct Bench {
    pub temp: Temp,
    pub plugins: PluginsState,
    pub link: Arc<FakeLink>,
    pub host: FakeHost,
    t0: Instant,
    tick: Cell<u64>,
}

fn entry(plugin: &Plugin, origin: &str) -> Entry {
    let network = plugin.2.contains(&Capability::Network);
    Entry {
        id: plugin.0.to_string(),
        version: "1.0.0".into(),
        tier: plugin.1,
        enabled: true,
        granted: plugin.2.to_vec(),
        installed_at: 1,
        manifest_hash: "h".into(),
        state: EntryState::Ready,
        source_path: None,
        sidebar_collapsed: false,
        ready_enabled: None,
        consented_network: if network {
            vec![origin.into()]
        } else {
            Vec::new()
        },
    }
}

impl Bench {
    pub fn new(plugins: &[Plugin]) -> Bench {
        Bench::consenting(plugins, RADIO)
    }

    /// One stream- and network-granted UI plugin, `A`, consenting to `origin`, its requests going
    /// through `net`.
    pub fn pull(origin: &str, net: crate::plugins::api::NetEngine) -> Bench {
        let grants = &[Capability::PlaybackStream, Capability::Network];
        let mut bench = Bench::consenting(&[Plugin(A, Tier::Ui, grants)], origin);
        bench.host.net = Some(net);
        bench
    }

    /// A bench whose network-granted plugins consent to `origin`.
    pub fn consenting(plugins: &[Plugin], origin: &str) -> Bench {
        let temp = Temp::new("streams");
        let covers = temp.0.join("covers");
        std::fs::create_dir_all(&covers).unwrap();
        let registry = Registry {
            entries: plugins.iter().map(|p| entry(p, origin)).collect(),
            ..Registry::default()
        };
        let state = PluginsState::new(registry, Problems::new(), BootState::default());
        let link = Arc::new(FakeLink {
            covers,
            ..FakeLink::default()
        });
        state.api().streams().attach(link.clone());
        let app = AppState::for_test(db::open_in_memory().unwrap(), PathBuf::new());
        Bench {
            temp,
            plugins: state,
            link,
            host: FakeHost {
                app: Some(app),
                ..FakeHost::default()
            },
            t0: Instant::now(),
            tick: Cell::new(0),
        }
    }

    /// One stream-granted UI plugin, `A`.
    pub fn one() -> Bench {
        Bench::new(&[Plugin(A, Tier::Ui, &[Capability::PlaybackStream])])
    }

    pub fn api(&self) -> &ApiState {
        self.plugins.api()
    }

    pub fn data(&self) -> &Path {
        &self.temp.0
    }

    /// A call from a frame of plugin `id`, a second after the previous one.
    pub fn call(&self, id: &str, method: &str, args: Value) -> Result<Value, ApiError> {
        self.call_as(Caller::Frame, id, method, args)
    }

    pub fn call_as(
        &self,
        caller: Caller,
        id: &str,
        method: &str,
        args: Value,
    ) -> Result<Value, ApiError> {
        self.tick.set(self.tick.get() + 1);
        let now = self.t0 + Duration::from_secs(self.tick.get());
        let args = args.to_string();
        let enabled = self.plugins.enabled_set();
        let admitted = admit_from(caller, &enabled, self.api(), id, method, args.len(), now)?;
        run(&admitted, &args, self.data(), &self.host, self.api())
    }

    /// Starts a push item of `id` and returns its number and the engine's seat.
    pub fn push_item(&self, id: &str, format: Value) -> (i64, StreamItem) {
        let args = serde_json::json!({ "source": { "push": format }, "title": "Push" });
        let reply = self.call(id, "stream.play", args).unwrap();
        let item = reply["item"].as_i64().unwrap();
        let seat = self.link.starts().pop().unwrap();
        assert_eq!(seat.id, item);
        (item, seat)
    }
}

/// A `pcm_s16le` push format: 8 kHz mono, so a little data is a lot of audio.
pub fn pcm() -> Value {
    serde_json::json!({ "format": "pcm_s16le", "rate": 8000, "channels": 1 })
}

/// Polls `check` for up to 5 s.
pub fn until(mut check: impl FnMut() -> bool) -> bool {
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(5) {
        if check() {
            return true;
        }
        thread::sleep(Duration::from_millis(5));
    }
    false
}
