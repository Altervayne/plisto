// -- Library Imports --
use std::collections::VecDeque;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use crossbeam_channel::Receiver;
use rodio::queue::SourcesQueueOutput;
use rodio::Sink;

// -- Local Imports --
use super::*;
use crate::audio::dsp::{DspShared, DspStage};
use crate::audio::engine::AppEvents;
use crate::audio::feed::{FeedEvent, FeedHub, Transport};
use crate::audio::queue::{block_spans, Xorshift};
use crate::audio::source::tests::{write_wav, TempDir};
use crate::audio::source::{DecoderSource, StreamPackets, BAND_COUNT};
use crate::audio::stream::{pcm_queue, PcmQueue, Seam, Segment, StreamControl};
use crate::audio::tap::tests::tapped;
use crate::audio::tap::{HeapRegion, TapSlot};
use crate::audio::{AudioSpec, PcmChunk, QueueMirror, QueueTrack, RepeatMode};
use crate::scan::progress::ProgressThrottle;

const RATE: u32 = 8_000;
const SPEC: AudioSpec = AudioSpec {
    sample_rate: RATE,
    channels: 2,
};
const ID: i64 = -7;
// Frames per pushed chunk: 128 ms at `RATE`.
const CHUNK: usize = 1_024;
// Chunks that reach `START_MS`, and `REBUFFER_MS`.
const START_CHUNKS: usize = 12;
const REBUFFER_CHUNKS: usize = 20;

// Position slack for reads that a call's audio service may have moved on.
// Wide enough for what the service may pull in a slow call; the cases it tells apart are seconds
// apart.
const SLACK: f64 = 0.25;
// The longest any engine call may take in a test.
const CALL_DEADLINE: Duration = Duration::from_secs(10);

type Log = Arc<Mutex<Vec<(String, serde_json::Value)>>>;

/// The sink's output, pulled by the test in place of the audio thread. `Sink::clear` waits for the
/// audio side to drop what it cleared, so while the engine is inside a call that lasts past a
/// short grace a service thread pulls for it, keeping what it pulls for the test's next read.
struct Output {
    out: Mutex<SourcesQueueOutput<f32>>,
    backlog: Mutex<VecDeque<f32>>,
    in_call: AtomicBool,
    stop: AtomicBool,
}

fn serve(output: Arc<Output>) {
    while !output.stop.load(Ordering::Acquire) {
        if !output.in_call.load(Ordering::Acquire) {
            thread::sleep(Duration::from_millis(1));
            continue;
        }
        thread::sleep(Duration::from_millis(2));
        loop {
            // Checked under the output lock, so no burst starts after a call has returned.
            {
                let mut out = output.out.lock().unwrap();
                if !output.in_call.load(Ordering::Acquire) {
                    break;
                }
                let mut backlog = output.backlog.lock().unwrap();
                for _ in 0..64 {
                    backlog.push_back(out.next().expect("the keep-alive queue never ends"));
                }
            }
            thread::sleep(Duration::from_millis(1));
        }
    }
}

/// Runs `f`, ending the test process when it blocks past `CALL_DEADLINE` instead of hanging it.
fn within_deadline<T>(what: &'static str, f: impl FnOnce() -> T) -> T {
    let (done, watch) = crossbeam_channel::bounded::<()>(1);
    thread::spawn(move || {
        if let Err(crossbeam_channel::RecvTimeoutError::Timeout) = watch.recv_timeout(CALL_DEADLINE)
        {
            eprintln!("{what} blocked past {CALL_DEADLINE:?}");
            std::process::abort();
        }
    });
    let got = f();
    drop(done);
    got
}

/// An engine on an idle sink, with an active heap tap and its own feed hub.
struct Rig {
    engine: Engine,
    output: Arc<Output>,
    log: Log,
    tap: Arc<TapSlot>,
    hub: &'static FeedHub,
    dir: TempDir,
}

impl Drop for Rig {
    fn drop(&mut self) {
        self.output.stop.store(true, Ordering::Release);
    }
}

fn rig() -> Rig {
    let (sink, out) = Sink::new_idle();
    let output = Arc::new(Output {
        out: Mutex::new(out),
        backlog: Mutex::default(),
        in_call: AtomicBool::new(false),
        stop: AtomicBool::new(false),
    });
    let served = Arc::clone(&output);
    thread::spawn(move || serve(served));
    let log: Log = Arc::default();
    let tap = Arc::new(TapSlot::new(HeapRegion::new()));
    tap.set_active(true);
    let hub: &'static FeedHub = Box::leak(Box::new(FeedHub::new()));
    let engine = Engine {
        _stream: None,
        sink: Some(sink),
        queue: Vec::new(),
        index: 0,
        original_order: Vec::new(),
        shuffle: false,
        rng: Xorshift::new(1),
        next_block: 0,
        repeat: RepeatMode::Off,
        paused: false,
        playing: false,
        volume: 1.0,
        taken_over: false,
        cur_frames: None,
        cur_spectrum: None,
        prev_bands: [0.0; BAND_COUNT],
        fine_spectrum: false,
        dsp: Arc::new(DspShared::default()),
        tap: Arc::clone(&tap),
        feed: hub,
        device_report: None,
        cur_rate: 0,
        cur_channels: 0,
        cur_duration: 0.0,
        cur_track_id: None,
        cur_block: None,
        cur_ended: None,
        cut: None,
        pending: None,
        preload_tried: None,
        played_half: false,
        listen_recorded: false,
        stop_at_frame: None,
        status: Arc::default(),
        queue_mirror: Arc::default(),
        app: AppEvents::Log(Arc::clone(&log)),
        throttle: ProgressThrottle::new(200),
        // Pinned, so the tick never polls the system default and rebuilds a real device.
        device_pref: Some("test output".into()),
        bound_device: None,
        last_default_name: None,
        last_device_poll: 0,
        seating: Seating::default(),
        opened: None,
        start_seq: 0,
        seek_seq: 0,
    };
    Rig {
        engine,
        output,
        log,
        tap,
        hub,
        dir: TempDir::new("seat"),
    }
}

impl Rig {
    fn call<T>(&mut self, f: impl FnOnce(&mut Engine) -> T) -> T {
        self.output.in_call.store(true, Ordering::Release);
        let got = within_deadline("an engine call", || f(&mut self.engine));
        self.output.in_call.store(false, Ordering::Release);
        // The service finishes its burst before the test reads the output.
        drop(self.output.out.lock().unwrap());
        got
    }

    fn handle(&mut self, cmd: PlayerCmd) {
        self.call(|e| e.handle(cmd));
    }

    fn tick(&mut self) {
        self.call(|e| e.tick());
    }

    fn next_sample(&self) -> f32 {
        if let Some(s) = self.output.backlog.lock().unwrap().pop_front() {
            return s;
        }
        self.output
            .out
            .lock()
            .unwrap()
            .next()
            .expect("the keep-alive queue never ends")
    }

    /// `n` ten-second library tracks with ids 1..=n, longer than any service pull plays out.
    fn library(&self, n: i64) -> Vec<QueueTrack> {
        (1..=n).map(|id| self.track(id)).collect()
    }

    fn track(&self, id: i64) -> QueueTrack {
        let path = self.dir.path.join(format!("t{id}.wav"));
        if !path.exists() {
            write_wav(&path, RATE, 2, 10 * RATE as usize);
        }
        QueueTrack {
            id,
            path,
            gain_db: 0.0,
            block: None,
            detached: false,
        }
    }

    /// Tracks `ids` sent as one block, under a batch-local mark the engine swaps for a token.
    fn album(&self, ids: &[i64]) -> Vec<QueueTrack> {
        ids.iter()
            .map(|&id| QueueTrack {
                block: Some(0),
                ..self.track(id)
            })
            .collect()
    }

    /// The queue's (id, token) copies.
    fn copies(&self) -> Vec<(i64, Option<u64>)> {
        self.engine.queue.iter().map(|t| (t.id, t.block)).collect()
    }

    fn sink(&self) -> &Sink {
        self.engine.sink.as_ref().expect("the rig has a sink")
    }

    fn pull(&mut self, samples: usize) -> Vec<f32> {
        (0..samples).map(|_| self.next_sample()).collect()
    }

    /// Pulls until the stream has played out what was queued. Returns everything pulled.
    fn pull_until_starved(&mut self, control: &StreamControl) -> Vec<f32> {
        let mut heard = Vec::new();
        for _ in 0..1_000 {
            heard.extend(self.pull(500));
            if control.is_starved() {
                // The rest of the block the source was in.
                heard.extend(self.pull(2_000));
                return heard;
            }
        }
        panic!("the stream never starved");
    }

    /// Pulls until `value` is heard. What a slow call pulled comes first, so no fixed count does.
    fn hears(&mut self, value: f32) -> bool {
        (0..1_000).any(|_| self.pull(500).contains(&value))
    }

    fn pull_until_drained(&mut self) {
        let mut n = 0;
        while !self.sink().empty() {
            self.next_sample();
            n += 1;
            assert!(n < 1_000_000, "the sink never drains");
        }
    }

    fn status(&self) -> PlayerStatus {
        self.engine.snapshot()
    }

    fn stream(&self) -> StreamStatus {
        self.status().stream.expect("a stream is seated")
    }

    fn queue_ids(&self) -> Vec<i64> {
        self.engine.queue.iter().map(|t| t.id).collect()
    }

    fn attached(&self) -> bool {
        self.engine
            .seating
            .seat
            .as_ref()
            .is_some_and(|s| s.attached.is_some())
    }

    fn emitted(&self, event: &str) -> bool {
        self.log.lock().unwrap().iter().any(|(e, _)| e == event)
    }

    /// Seats a stream and plays it once `START_CHUNKS` are queued.
    fn start(&mut self, item: StreamItem, producer: &mut Producer) {
        self.handle(PlayerCmd::StreamStart(item));
        producer.push(START_CHUNKS);
        self.tick();
        assert!(self.attached());
        assert_eq!(self.stream().phase, StreamPhase::Playing);
    }
}

/// The producer side of one stream, as the decode thread holds it.
struct Producer {
    queue: PcmQueue,
    control: Arc<StreamControl>,
    signals: Receiver<StreamSignal>,
    skip: Arc<SkipFlags>,
}

impl Producer {
    fn push(&mut self, chunks: usize) {
        self.push_spec(chunks, SPEC);
    }

    fn push_value(&mut self, chunks: usize, value: f32) {
        for _ in 0..chunks {
            let mut c = chunk(CHUNK, SPEC);
            c.samples.fill(value);
            within_deadline("a push", || self.queue.push_chunk(c))
                .expect("the queue takes the chunk");
        }
    }

    fn push_spec(&mut self, chunks: usize, spec: AudioSpec) {
        for _ in 0..chunks {
            within_deadline("a push", || self.queue.push_chunk(chunk(CHUNK, spec)))
                .expect("the queue takes the chunk");
        }
    }

    fn signals(&self) -> Vec<StreamSignal> {
        self.signals.try_iter().collect()
    }
}

fn chunk(frames: usize, spec: AudioSpec) -> PcmChunk {
    PcmChunk {
        samples: vec![0.25; frames * spec.channels as usize],
        spec,
    }
}

fn item(id: i64, live: bool, duration: Option<f64>) -> (StreamItem, Producer) {
    let control = Arc::new(StreamControl::new());
    let (queue, reader) = pcm_queue(Arc::clone(&control));
    let (signals, rx) = crossbeam_channel::unbounded();
    let skip = Arc::new(SkipFlags::default());
    let item = StreamItem {
        id,
        live,
        seekable: !live,
        duration_secs: duration,
        pcm: reader,
        control: Arc::clone(&control),
        skip: Arc::clone(&skip),
        signals,
    };
    let producer = Producer {
        queue,
        control,
        signals: rx,
        skip,
    };
    (item, producer)
}

fn live() -> (StreamItem, Producer) {
    item(ID, true, None)
}

fn finite(duration: f64) -> (StreamItem, Producer) {
    item(ID, false, Some(duration))
}

// Plays track 2 of three for a quarter second and returns the play head.
fn play_second_track(r: &mut Rig) -> f64 {
    let queue = r.library(3);
    r.handle(PlayerCmd::Play { queue, index: 1 });
    for _ in 0..1_000 {
        if r.engine.position_secs() >= 0.2 {
            break;
        }
        r.pull(500);
    }
    let secs = r.engine.position_secs();
    assert!(secs >= 0.2);
    secs
}

fn assert_parked(parked: Option<ParkedStatus>, track_id: i64, secs: f64) {
    let parked = parked.expect("a parked track");
    assert_eq!(parked.track_id, track_id);
    assert!(
        (parked.secs - secs).abs() < SLACK,
        "parked at {} for {secs}",
        parked.secs
    );
}

fn feed_events(rx: &Receiver<FeedEvent>) -> Vec<(FeedCause, Transport)> {
    rx.try_iter()
        .map(|e| (e.cause, e.state.transport))
        .collect()
}

// ---- Seat ----

#[test]
fn a_stream_seats_over_a_parked_queue() {
    let mut r = rig();
    let secs = play_second_track(&mut r);
    let (item, _p) = live();
    r.handle(PlayerCmd::StreamStart(item));

    let status = r.status();
    assert_eq!(status.track_id, Some(ID));
    assert!(!status.playing);
    assert_eq!(status.queue_index, 1);
    assert_eq!(status.queue_len, 3);
    let stream = status.stream.expect("seated");
    assert_eq!(stream.phase, StreamPhase::Connecting);
    assert_parked(stream.parked, 2, secs);
    assert!(!stream.parked_cleared);
    assert_eq!(r.queue_ids(), vec![1, 2, 3]);
    // The library source leaves the sink.
    r.pull(2_000);
    assert!(r.sink().empty());
}

#[test]
fn the_stream_starts_at_start_ms() {
    let mut r = rig();
    let (item, mut p) = live();
    r.handle(PlayerCmd::StreamStart(item));
    p.push(START_CHUNKS - 1);
    r.tick();
    assert!(!r.attached());
    assert!(r.sink().empty());
    assert_eq!(r.stream().phase, StreamPhase::Connecting);

    p.push(1);
    r.tick();
    assert!(r.attached());
    assert!(!r.sink().empty());
    assert!(r.status().playing);
    assert!(r.hears(0.25));

    // A short item that already holds its end starts at once.
    let mut r = rig();
    let (item, mut p) = finite(0.3);
    r.handle(PlayerCmd::StreamStart(item));
    p.push(2);
    p.queue.push_end().expect("queues the end");
    r.tick();
    assert!(r.attached());
}

#[test]
fn starved_pauses_and_rebuffer_resumes() {
    let mut r = rig();
    let (item, mut p) = live();
    r.start(item, &mut p);
    r.pull_until_starved(&p.control);
    assert!(p.control.is_starved());

    r.tick();
    assert_eq!(r.stream().phase, StreamPhase::Buffering);
    assert!(r.sink().is_paused());
    assert!(!r.status().playing);

    p.push(REBUFFER_CHUNKS - 1);
    r.tick();
    assert_eq!(r.stream().phase, StreamPhase::Buffering);
    p.push(1);
    r.tick();
    assert_eq!(r.stream().phase, StreamPhase::Playing);
    assert!(!r.sink().is_paused());
    assert!(!p.control.is_starved());
    assert!(r.hears(0.25));

    let phases: Vec<StreamSignal> = p.signals();
    assert_eq!(
        phases,
        vec![
            StreamSignal::Phase(ID, StreamPhase::Connecting),
            StreamSignal::Phase(ID, StreamPhase::Playing),
            StreamSignal::Phase(ID, StreamPhase::Buffering),
            StreamSignal::Phase(ID, StreamPhase::Playing),
        ]
    );
}

#[test]
fn starved_silence_is_not_counted_tapped_or_analyzed() {
    let control = Arc::new(StreamControl::new());
    let (mut queue, reader) = pcm_queue(Arc::clone(&control));
    queue.push_chunk(chunk(CHUNK, SPEC)).expect("queued");
    let slot = Arc::new(TapSlot::new(HeapRegion::new()));
    slot.set_active(true);
    let packets = StreamPackets::new(reader, Arc::new(EdgeCell::default()), None);
    let stage = DspStage::new(Arc::new(DspShared::default()), 0.0);
    let mut src =
        DecoderSource::new(packets, 0.0, stage, Some(slot.cold())).expect("primes the chunk");
    let (frames, spectrum) = (Arc::clone(&src.frames), Arc::clone(&src.spectrum));

    for _ in 0..CHUNK * 2 {
        assert_eq!(src.next(), Some(0.25));
    }
    // Starved: a block of silence, then another while still starved.
    for _ in 0..1_024 {
        assert_eq!(src.next(), Some(0.0));
    }
    assert!(control.is_starved());
    assert_eq!(frames.load(Ordering::Relaxed), CHUNK as u64);
    assert_eq!(spectrum.written.load(Ordering::Relaxed), CHUNK as u64);

    queue.push_chunk(chunk(CHUNK, SPEC)).expect("queued");
    queue.push_end().expect("queues the end");
    let rest: Vec<f32> = src.by_ref().collect();
    assert_eq!(rest.iter().filter(|&&s| s == 0.25).count(), CHUNK * 2);
    assert!(!control.is_starved());
    assert_eq!(frames.load(Ordering::Relaxed), 2 * CHUNK as u64);
    assert_eq!(spectrum.written.load(Ordering::Relaxed), 2 * CHUNK as u64);
    let tap = tapped(&slot);
    assert_eq!(tap.len(), 4 * CHUNK);
    assert!(tap.iter().all(|&s| s == 0.25));
}

#[test]
fn a_break_reattaches_cold_in_a_new_epoch() {
    let mut r = rig();
    let feed = r.hub.attach(false).expect("attaches");
    let (item, mut p) = live();
    r.handle(PlayerCmd::StreamStart(item));
    p.push(START_CHUNKS);
    p.queue.push_break(Seam::Chain).expect("queues the break");
    p.push(START_CHUNKS);
    r.tick();
    let epoch = r.tap.epoch();
    r.pull_until_drained();
    let position = r.engine.position_secs();
    assert!(position >= START_CHUNKS as f64 * 0.128 - 1e-9);

    r.tick();
    assert!(r.attached());
    assert!(!r.sink().empty());
    assert_eq!(r.tap.epoch(), epoch + 1);
    assert!((r.status().position_secs - position).abs() < SLACK);
    assert_eq!(r.stream().phase, StreamPhase::Playing);
    let causes: Vec<FeedCause> = feed_events(&feed.events).into_iter().map(|e| e.0).collect();
    assert_eq!(
        causes,
        vec![FeedCause::Buffering, FeedCause::Start, FeedCause::Start]
    );
    assert!(r.hears(0.25));
}

#[test]
fn a_spec_change_plays_on_with_no_gap_and_the_tap_keeps_up() {
    let mut r = rig();
    let feed = r.hub.attach(false).expect("attaches");
    let (item, mut p) = live();
    r.handle(PlayerCmd::StreamStart(item));
    p.push(START_CHUNKS);
    let wide = AudioSpec {
        sample_rate: 16_000,
        channels: 2,
    };
    p.push_spec(4, wide);
    r.tick();
    let epoch = r.tap.epoch();
    let total = (START_CHUNKS + 4) * CHUNK * 2;
    let heard = r.pull_until_starved(&p.control);

    // One run of audio after the start's primer, with no silence where the spec changed.
    let first = heard.iter().position(|&s| s == 0.25).expect("audible");
    assert!(heard[first..first + total].iter().all(|&s| s == 0.25));

    // The play head and the feed state follow the new spec, with no event of their own.
    r.tick();
    assert_eq!(r.engine.cur_rate, 16_000);
    assert_eq!(r.engine.cur_channels, 2);
    let played = START_CHUNKS as f64 * 0.128 + 4.0 * 0.064;
    assert!((r.engine.position_secs() - played).abs() < 1e-3);
    let causes: Vec<FeedCause> = feed_events(&feed.events).into_iter().map(|e| e.0).collect();
    assert_eq!(
        causes,
        vec![FeedCause::Buffering, FeedCause::Start, FeedCause::Buffering]
    );

    // The tap holds exactly what was heard, in one epoch.
    p.queue.push_end().expect("queues the end");
    r.tick();
    r.pull(2_000);
    let tap = tapped(&r.tap);
    assert_eq!(tap.len(), total);
    assert!(tap.iter().all(|&s| s == 0.25));
    assert_eq!(r.tap.epoch(), epoch, "a spec change keeps the epoch");
}

// ---- End ----

#[test]
fn end_restores_the_parked_track_paused() {
    let mut r = rig();
    let secs = play_second_track(&mut r);
    let (item, mut p) = live();
    r.start(item, &mut p);
    r.pull(4_000);
    r.handle(PlayerCmd::StreamEnd {
        id: ID,
        reason: StreamEndReason::Stopped,
    });

    let status = r.status();
    assert_eq!(status.track_id, Some(2));
    assert!(!status.playing);
    assert!(status.stream.is_none());
    assert!((status.position_secs - secs).abs() < SLACK);
    assert!(p.control.is_cancelled());
    assert!(r.sink().is_paused());
    // The owner asked for the end, so it is not told again.
    assert!(!p
        .signals()
        .iter()
        .any(|s| matches!(s, StreamSignal::Ended(..))));
}

#[test]
fn end_with_a_dead_parked_file_stops_silently() {
    let mut r = rig();
    play_second_track(&mut r);
    let (item, mut p) = live();
    r.start(item, &mut p);
    std::fs::remove_file(&r.engine.queue[1].path).expect("removes the parked file");
    r.handle(PlayerCmd::StreamEnd {
        id: ID,
        reason: StreamEndReason::Network,
    });

    let status = r.status();
    assert_eq!(status.track_id, None);
    assert!(!status.playing);
    assert!(status.stream.is_none());
    assert!(!r.emitted("player:error"));
}

#[test]
fn user_stop_ends_with_user() {
    let mut r = rig();
    play_second_track(&mut r);
    let (item, mut p) = live();
    r.start(item, &mut p);
    r.handle(PlayerCmd::Stop);
    assert!(p
        .signals()
        .contains(&StreamSignal::Ended(ID, StreamEndReason::User)));
    assert_eq!(r.status().track_id, Some(2));
    assert!(!r.status().playing);
}

#[test]
fn a_local_play_ends_with_replaced() {
    let mut r = rig();
    play_second_track(&mut r);
    let (item, mut p) = live();
    r.start(item, &mut p);
    let queue = r.library(3);
    r.handle(PlayerCmd::Play { queue, index: 2 });
    assert!(p
        .signals()
        .contains(&StreamSignal::Ended(ID, StreamEndReason::Replaced)));
    let status = r.status();
    assert_eq!(status.track_id, Some(3));
    assert!(status.playing);
    assert!(status.stream.is_none());
    assert!(p.control.is_cancelled());
}

// ---- The parked queue ----

#[test]
fn queue_edits_touch_only_the_parked_queue() {
    let mut r = rig();
    let queue = r.library(3);
    r.handle(PlayerCmd::Play { queue, index: 0 });
    let (item, mut p) = live();
    r.start(item, &mut p);

    let (t4, t5) = (r.track(4), r.track(5));
    r.handle(PlayerCmd::Enqueue(vec![t4]));
    r.handle(PlayerCmd::InsertNext(vec![t5]));
    assert_eq!(r.queue_ids(), vec![1, 5, 2, 3, 4]);
    r.handle(PlayerCmd::MoveQueueItem { from: 3, to: 4 });
    r.handle(PlayerCmd::RemoveQueueItem { index: 2 });
    r.handle(PlayerCmd::SetRepeat(RepeatMode::All));
    r.handle(PlayerCmd::SetShuffle(true));
    r.handle(PlayerCmd::SetShuffle(false));
    assert_eq!(r.queue_ids(), vec![1, 5, 4, 3]);

    let status = r.status();
    assert_eq!(status.track_id, Some(ID));
    assert_eq!(status.queue_len, 4);
    assert_eq!(status.queue_index, 0);
    let stream = status.stream.expect("seated");
    assert_eq!(stream.phase, StreamPhase::Playing);
    assert_eq!(stream.parked.map(|p| p.track_id), Some(1));
    assert!(r.attached());
    assert!(!p.control.is_cancelled());
    assert!(r.hears(0.25));
}

#[test]
fn a_stream_never_clears_the_parked_queue() {
    let mut r = rig();
    play_second_track(&mut r);
    let (item, mut p) = live();
    r.start(item, &mut p);
    r.pull_until_starved(&p.control);
    r.tick();
    p.push(REBUFFER_CHUNKS);
    p.queue.push_end().expect("queues the end");
    r.tick();
    r.pull_until_drained();
    r.tick();

    assert!(p
        .signals()
        .contains(&StreamSignal::Ended(ID, StreamEndReason::Finished)));
    assert_eq!(r.queue_ids(), vec![1, 2, 3]);
    assert_eq!(r.status().track_id, Some(2));
}

#[test]
fn clear_parked_empties_the_queue_and_the_stream_plays_on() {
    let mut r = rig();
    play_second_track(&mut r);
    let (item, mut p) = live();
    r.start(item, &mut p);
    r.handle(PlayerCmd::ClearParked);

    let status = r.status();
    assert_eq!(status.queue_len, 0);
    assert!(r.queue_ids().is_empty());
    let stream = status.stream.expect("seated");
    assert_eq!(stream.parked, None);
    assert!(stream.parked_cleared);
    assert_eq!(stream.phase, StreamPhase::Playing);
    assert!(r.attached());
    assert!(!r.emitted("player:played"));
    assert!(r.hears(0.25));
}

#[test]
fn end_after_clear_parked_stops() {
    let mut r = rig();
    play_second_track(&mut r);
    let (item, mut p) = live();
    r.start(item, &mut p);
    r.handle(PlayerCmd::ClearParked);
    r.handle(PlayerCmd::Stop);
    let status = r.status();
    assert_eq!(status.track_id, None);
    assert!(!status.playing);
    assert!(status.stream.is_none());
}

#[test]
fn clear_parked_without_a_stream_is_ignored() {
    let mut r = rig();
    play_second_track(&mut r);
    r.handle(PlayerCmd::ClearParked);
    let status = r.status();
    assert_eq!(status.queue_len, 3);
    assert_eq!(status.track_id, Some(2));
    assert!(status.playing);
}

#[test]
fn a_second_stream_keeps_the_first_parked_slot() {
    let mut r = rig();
    let secs = play_second_track(&mut r);
    let (first, mut a) = live();
    r.start(first, &mut a);
    let (second, _b) = item(-8, true, None);
    r.handle(PlayerCmd::StreamStart(second));

    let status = r.status();
    assert_eq!(status.track_id, Some(-8));
    let stream = status.stream.expect("seated");
    assert_eq!(stream.phase, StreamPhase::Connecting);
    assert_parked(stream.parked, 2, secs);
    assert!(a.control.is_cancelled());
    assert!(a
        .signals()
        .contains(&StreamSignal::Ended(ID, StreamEndReason::Replaced)));
}

#[test]
fn load_while_seated_fills_an_empty_parked_slot_only() {
    let mut r = rig();
    let (item, _p) = live();
    r.handle(PlayerCmd::StreamStart(item));
    assert_eq!(r.stream().parked, None);

    let queue = r.library(3);
    r.handle(PlayerCmd::Load {
        queue,
        index: 1,
        secs: 12.0,
    });
    let status = r.status();
    assert_eq!(status.queue_len, 3);
    assert_eq!(status.queue_index, 1);
    assert_eq!(status.track_id, Some(ID));
    assert_eq!(
        status.stream.and_then(|s| s.parked),
        Some(ParkedStatus {
            track_id: 2,
            secs: 12.0
        })
    );
    assert!(r.sink().empty());

    let other = vec![r.track(9)];
    r.handle(PlayerCmd::Load {
        queue: other,
        index: 0,
        secs: 3.0,
    });
    assert_eq!(r.queue_ids(), vec![1, 2, 3]);
    assert_eq!(r.stream().parked.map(|p| p.secs), Some(12.0));
}

#[test]
fn load_after_clear_parked_is_ignored() {
    let mut r = rig();
    play_second_track(&mut r);
    let (item, _p) = live();
    r.handle(PlayerCmd::StreamStart(item));
    r.handle(PlayerCmd::ClearParked);
    let queue = r.library(2);
    r.handle(PlayerCmd::Load {
        queue,
        index: 0,
        secs: 5.0,
    });
    let stream = r.stream();
    assert!(r.queue_ids().is_empty());
    assert_eq!(stream.parked, None);
    assert!(stream.parked_cleared);
}

#[test]
fn status_reports_the_parked_track_and_secs() {
    let mut r = rig();
    assert_eq!(
        serde_json::to_value(r.status()).expect("serializes")["stream"],
        serde_json::Value::Null
    );
    let secs = play_second_track(&mut r);
    let (item, _p) = live();
    r.handle(PlayerCmd::StreamStart(item));
    let json = serde_json::to_value(r.status()).expect("serializes");
    assert_eq!(json["stream"]["parked"]["track_id"], 2);
    assert!((json["stream"]["parked"]["secs"].as_f64().expect("a number") - secs).abs() < SLACK);
    assert_eq!(json["stream"]["parked_cleared"], false);
    assert_eq!(json["stream"]["live"], true);
    assert_eq!(json["stream"]["seekable"], false);
}

#[test]
fn parked_follows_a_move_and_a_removal_of_its_row() {
    let mut r = rig();
    let queue = r.library(4);
    r.handle(PlayerCmd::Play { queue, index: 1 });
    let (item, _p) = live();
    r.handle(PlayerCmd::StreamStart(item));

    r.handle(PlayerCmd::MoveQueueItem { from: 1, to: 3 });
    assert_eq!(r.queue_ids(), vec![1, 3, 4, 2]);
    assert_eq!(r.status().queue_index, 3);
    assert_eq!(r.stream().parked.map(|p| p.track_id), Some(2));

    // The parked row goes: the last row is parked, at its start.
    r.handle(PlayerCmd::RemoveQueueItem { index: 3 });
    assert_eq!(
        r.stream().parked,
        Some(ParkedStatus {
            track_id: 4,
            secs: 0.0
        })
    );
    assert_eq!(r.status().queue_index, 2);
    // A row before it goes: the parked track keeps its place by id.
    r.handle(PlayerCmd::RemoveQueueItem { index: 0 });
    assert_eq!(r.status().queue_index, 1);
    assert_eq!(r.stream().parked.map(|p| p.track_id), Some(4));
    // The slot that slides in is parked.
    r.handle(PlayerCmd::RemoveQueueItem { index: 0 });
    r.handle(PlayerCmd::RemoveQueueItem { index: 0 });
    assert!(r.queue_ids().is_empty());
    assert_eq!(r.stream().parked, None);
    assert!(!r.stream().parked_cleared);
}

#[test]
fn enqueue_into_an_empty_parked_queue_parks_its_first_track() {
    let mut r = rig();
    let (item, _p) = live();
    r.handle(PlayerCmd::StreamStart(item));
    let tracks = vec![r.track(4), r.track(5)];
    r.handle(PlayerCmd::Enqueue(tracks));

    let status = r.status();
    assert_eq!(status.track_id, Some(ID));
    assert_eq!(status.queue_index, 0);
    assert_eq!(
        status.stream.and_then(|s| s.parked),
        Some(ParkedStatus {
            track_id: 4,
            secs: 0.0
        })
    );
    // Nothing starts.
    assert!(r.sink().empty());
}

#[test]
fn clear_parked_sets_parked_cleared_until_a_track_is_added() {
    let mut r = rig();
    play_second_track(&mut r);
    let (item, _p) = live();
    r.handle(PlayerCmd::StreamStart(item));
    r.handle(PlayerCmd::ClearParked);
    assert!(r.stream().parked_cleared);

    let track = r.track(6);
    r.handle(PlayerCmd::InsertNext(vec![track]));
    let stream = r.stream();
    assert!(!stream.parked_cleared);
    assert_eq!(
        stream.parked,
        Some(ParkedStatus {
            track_id: 6,
            secs: 0.0
        })
    );
}

// ---- Previews, in the order the Track Editor sends them ----

/// What the editor reads on entry, after pausing what plays.
struct Entry {
    secs: f64,
    playing: bool,
    had_track: bool,
}

impl Rig {
    fn enter_editor(&mut self) -> Entry {
        let status = self.status();
        if status.playing {
            self.handle(PlayerCmd::Pause);
        }
        Entry {
            secs: status.position_secs,
            playing: status.playing,
            had_track: status.track_id.is_some(),
        }
    }

    fn preview(&mut self) {
        let path = self.track(9).path;
        self.handle(PlayerCmd::Preview {
            path,
            start_secs: 0.0,
            end_secs: 0.5,
        });
    }

    fn sounding(&self) -> bool {
        let status = self.status();
        status.playing && status.track_id.is_none()
    }

    fn leave_editor(&mut self, entry: Entry) {
        if self.sounding() {
            self.handle(PlayerCmd::Stop);
        }
        if entry.had_track {
            self.handle(PlayerCmd::RestoreLibrary {
                secs: entry.secs,
                playing: entry.playing,
            });
        }
    }
}

#[test]
fn restore_resumes_an_item_paused_on_entry_with_no_preview() {
    let mut r = rig();
    let (item, mut p) = live();
    r.start(item, &mut p);
    let entry = r.enter_editor();
    assert!(entry.playing);
    assert_eq!(r.stream().phase, StreamPhase::Paused);
    r.leave_editor(entry);
    assert_eq!(r.stream().phase, StreamPhase::Playing);
    assert!(r.attached());
    assert!(!r.sink().is_paused());
}

#[test]
fn previews_clear_the_item_and_restore_resumes_it() {
    let mut r = rig();
    let (item, mut p) = live();
    r.start(item, &mut p);
    r.pull(4_000);
    let entry = r.enter_editor();
    let position = r.engine.position_secs();
    r.preview();
    assert!(!r.attached());
    assert!(r.sounding());
    r.handle(PlayerCmd::Stop);
    assert!(!r.sounding());
    assert_eq!(r.stream().phase, StreamPhase::Paused);
    r.preview();
    assert!(r.sounding());
    assert!(!p.control.is_cancelled());
    // The producer fills the queue while the item waits.
    p.push(15);
    r.leave_editor(entry);

    assert!(r.attached());
    assert_eq!(r.stream().phase, StreamPhase::Playing);
    assert!((r.engine.position_secs() - position).abs() < SLACK);
    assert!(r.hears(0.25));
}

#[test]
fn an_item_the_user_paused_stays_paused() {
    // No preview: it stays attached and paused.
    let mut r = rig();
    let (item, mut p) = live();
    r.start(item, &mut p);
    r.handle(PlayerCmd::Pause);
    let entry = r.enter_editor();
    assert!(!entry.playing);
    r.leave_editor(entry);
    assert_eq!(r.stream().phase, StreamPhase::Paused);
    assert!(r.attached());

    // With a preview: it stays paused, detached.
    let mut r = rig();
    let (item, mut p) = live();
    r.start(item, &mut p);
    r.handle(PlayerCmd::Pause);
    let entry = r.enter_editor();
    r.preview();
    r.leave_editor(entry);
    assert_eq!(r.stream().phase, StreamPhase::Paused);
    assert!(!r.attached());
    assert_eq!(r.status().track_id, Some(ID));
}

#[test]
fn a_sounding_preview_reports_as_with_no_stream_and_stop_stops_it_only() {
    let mut r = rig();
    let (item, mut p) = live();
    r.start(item, &mut p);
    r.enter_editor();
    r.preview();
    let status = r.status();
    assert_eq!(status.track_id, None);
    assert!(status.playing);
    assert_eq!(status.stream.map(|s| s.phase), Some(StreamPhase::Paused));

    r.handle(PlayerCmd::Stop);
    let status = r.status();
    assert_eq!(status.track_id, Some(ID));
    assert!(!status.playing);
    assert!(!p.control.is_cancelled());
    assert!(!p
        .signals()
        .iter()
        .any(|s| matches!(s, StreamSignal::Ended(..))));

    r.handle(PlayerCmd::Stop);
    assert!(p
        .signals()
        .contains(&StreamSignal::Ended(ID, StreamEndReason::User)));
    assert!(r.status().stream.is_none());
}

#[test]
fn a_stream_over_a_library_paused_on_entry_parks_its_position() {
    let mut r = rig();
    play_second_track(&mut r);
    let entry = r.enter_editor();
    assert!(entry.playing);
    let (item, mut p) = live();
    r.start(item, &mut p);
    assert_parked(r.stream().parked, 2, entry.secs);

    r.leave_editor(entry);
    assert!(r.attached());
    assert_eq!(r.stream().phase, StreamPhase::Playing);
    let parked = r.stream().parked.expect("still parked");
    assert_eq!(parked.track_id, 2);
    assert!(parked.secs > 0.0);
}

#[test]
fn restore_with_playing_false_never_pauses_an_item() {
    let mut r = rig();
    let (item, mut p) = live();
    r.start(item, &mut p);
    r.handle(PlayerCmd::RestoreLibrary {
        secs: 3.0,
        playing: false,
    });
    assert_eq!(r.stream().phase, StreamPhase::Playing);
    assert!(r.attached());
    assert!(!r.sink().is_paused());
}

#[test]
fn a_stream_after_a_stopped_preview_parks_the_displaced_track() {
    let mut r = rig();
    play_second_track(&mut r);
    let entry = r.enter_editor();
    r.preview();
    r.handle(PlayerCmd::Stop);
    assert!(!r.sounding());
    let (item, mut p) = live();
    r.start(item, &mut p);
    let parked = r.stream().parked.expect("the displaced track is parked");
    assert_eq!(parked.track_id, 2);

    let secs = entry.secs;
    r.leave_editor(entry);
    assert_parked(r.stream().parked, 2, secs);
    assert!(r.attached());
    assert_eq!(r.stream().phase, StreamPhase::Playing);
}

#[test]
fn a_stream_started_while_a_preview_sounds_plays_once_it_ends() {
    let mut r = rig();
    play_second_track(&mut r);
    let entry = r.enter_editor();
    r.preview();
    let (item, mut p) = live();
    r.handle(PlayerCmd::StreamStart(item));
    p.push(START_CHUNKS);
    r.tick();
    assert!(!r.attached());
    assert!(r.sounding());
    assert_eq!(r.stream().parked.map(|p| p.track_id), Some(2));

    let secs = entry.secs;
    r.leave_editor(entry);
    assert!(r.attached());
    assert!(r.status().playing);
    assert_parked(r.stream().parked, 2, secs);
}

#[test]
fn an_item_ending_under_a_preview_restores_the_parked_track_paused() {
    let mut r = rig();
    let secs = play_second_track(&mut r);
    let (item, mut p) = live();
    r.start(item, &mut p);
    r.pull(4_000);
    let entry = r.enter_editor();
    r.preview();
    r.handle(PlayerCmd::StreamEnd {
        id: ID,
        reason: StreamEndReason::Network,
    });
    assert!(r.sounding(), "the preview keeps the sink");
    r.leave_editor(entry);

    let status = r.status();
    assert_eq!(status.track_id, Some(2));
    assert!(!status.playing);
    assert!((status.position_secs - secs).abs() < SLACK);
}

#[test]
fn an_item_ending_while_the_library_is_displaced_comes_back_paused() {
    let mut r = rig();
    play_second_track(&mut r);
    let entry = r.enter_editor();
    r.preview();
    r.handle(PlayerCmd::Stop);
    let (item, mut p) = live();
    r.start(item, &mut p);
    r.handle(PlayerCmd::StreamEnd {
        id: ID,
        reason: StreamEndReason::Network,
    });
    assert_eq!(r.status().track_id, Some(2));
    assert!(!r.status().playing);

    let secs = entry.secs;
    r.leave_editor(entry);
    let status = r.status();
    assert_eq!(status.track_id, Some(2));
    assert!(!status.playing);
    assert!((status.position_secs - secs).abs() < SLACK);
}

#[test]
fn the_pending_restore_never_takes_a_later_restore() {
    // A local play drops it.
    let mut r = rig();
    play_second_track(&mut r);
    let (item, mut p) = live();
    r.start(item, &mut p);
    r.enter_editor();
    r.preview();
    r.handle(PlayerCmd::StreamEnd {
        id: ID,
        reason: StreamEndReason::Network,
    });
    let queue = r.library(3);
    r.handle(PlayerCmd::Play { queue, index: 0 });
    r.handle(PlayerCmd::RestoreLibrary {
        secs: 0.25,
        playing: true,
    });
    let status = r.status();
    assert_eq!(status.track_id, Some(1));
    assert!(status.playing);

    // A transport command drops it.
    let mut r = rig();
    play_second_track(&mut r);
    let (item, mut p) = live();
    r.start(item, &mut p);
    r.enter_editor();
    r.preview();
    r.handle(PlayerCmd::StreamEnd {
        id: ID,
        reason: StreamEndReason::Network,
    });
    r.handle(PlayerCmd::Stop);
    r.handle(PlayerCmd::Seek(0.0));
    r.handle(PlayerCmd::RestoreLibrary {
        secs: 0.25,
        playing: true,
    });
    let status = r.status();
    assert_eq!(status.track_id, Some(2));
    assert!(status.playing, "the ordinary restore ran");
}

// Plays track 2, then a stream past the track's own position. Returns the track's position.
fn stream_over_second_track(r: &mut Rig, p: &mut Producer, item: StreamItem) -> f64 {
    let secs = play_second_track(r);
    r.start(item, p);
    p.push(18);
    // The item plays well past where the track stood.
    for _ in 0..1_000 {
        if r.status().position_secs > secs + 4.0 * SLACK {
            break;
        }
        r.pull(500);
    }
    assert!(r.status().position_secs > secs + 4.0 * SLACK);
    secs
}

fn assert_parked_track_paused_at(r: &Rig, secs: f64) {
    let status = r.status();
    assert_eq!(status.track_id, Some(2));
    assert!(!status.playing);
    assert!(status.stream.is_none());
    assert!(r.sink().is_paused());
    assert!(
        (status.position_secs - secs).abs() < SLACK,
        "at {} for {secs}",
        status.position_secs
    );
}

#[test]
fn a_restore_after_a_user_stop_brings_the_parked_track_back_paused() {
    let mut r = rig();
    let (item, mut p) = live();
    let secs = stream_over_second_track(&mut r, &mut p, item);
    let entry = r.enter_editor();
    assert!(entry.playing);
    r.handle(PlayerCmd::Stop);
    r.leave_editor(entry);
    assert_parked_track_paused_at(&r, secs);
}

#[test]
fn a_restore_after_a_preview_then_a_user_stop_brings_the_parked_track_back_paused() {
    let mut r = rig();
    let (item, mut p) = live();
    let secs = stream_over_second_track(&mut r, &mut p, item);
    let entry = r.enter_editor();
    r.preview();
    r.handle(PlayerCmd::Stop);
    r.handle(PlayerCmd::Stop);
    assert!(p
        .signals()
        .contains(&StreamSignal::Ended(ID, StreamEndReason::User)));
    r.leave_editor(entry);
    assert_parked_track_paused_at(&r, secs);
}

#[test]
fn a_restore_after_a_user_stop_then_a_preview_brings_the_parked_track_back_paused() {
    let mut r = rig();
    let (item, mut p) = live();
    let secs = stream_over_second_track(&mut r, &mut p, item);
    let entry = r.enter_editor();
    r.handle(PlayerCmd::Stop);
    r.preview();
    assert!(r.sounding());
    r.leave_editor(entry);
    assert_parked_track_paused_at(&r, secs);
}

#[test]
fn a_restore_with_no_stream_uses_its_own_values() {
    let mut r = rig();
    play_second_track(&mut r);
    let entry = r.enter_editor();
    r.preview();
    r.leave_editor(entry);
    let status = r.status();
    assert_eq!(status.track_id, Some(2));
    assert!(status.playing);

    // The command's position wins over where the track stood.
    r.handle(PlayerCmd::Pause);
    r.preview();
    r.handle(PlayerCmd::Stop);
    r.handle(PlayerCmd::RestoreLibrary {
        secs: 4.0,
        playing: false,
    });
    let status = r.status();
    assert_eq!(status.track_id, Some(2));
    assert!(!status.playing);
    assert!((status.position_secs - 4.0).abs() < SLACK);
}

#[test]
fn an_item_buffering_on_entry_goes_on_after_a_preview() {
    let mut r = rig();
    let (item, mut p) = live();
    r.handle(PlayerCmd::StreamStart(item));
    let entry = r.enter_editor();
    assert!(!entry.playing);
    assert!(entry.had_track);
    r.preview();
    assert_eq!(r.stream().phase, StreamPhase::Paused);
    p.push(START_CHUNKS);
    r.leave_editor(entry);
    r.tick();
    assert!(r.attached());
    assert_eq!(r.stream().phase, StreamPhase::Playing);
}

#[test]
fn an_item_started_under_a_preview_goes_on_after_a_second_preview() {
    let mut r = rig();
    let entry = r.enter_editor();
    assert!(!entry.had_track);
    r.preview();
    let (item, mut p) = live();
    r.handle(PlayerCmd::StreamStart(item));
    p.push(START_CHUNKS);
    r.preview();
    assert_eq!(r.stream().phase, StreamPhase::Paused);
    // Nothing was loaded on entry, so the editor sends no restore.
    r.leave_editor(entry);
    r.tick();
    assert!(r.attached());
    assert_eq!(r.stream().phase, StreamPhase::Playing);
}

#[test]
fn a_user_paused_item_stays_paused_across_a_preview_that_ends_by_itself() {
    let mut r = rig();
    let (item, mut p) = live();
    r.start(item, &mut p);
    r.handle(PlayerCmd::Pause);
    r.preview();
    // The preview plays out to its end.
    for _ in 0..50 {
        if !r.sounding() {
            break;
        }
        r.pull(2_000);
        r.tick();
    }
    assert!(!r.sounding());
    r.tick();
    assert_eq!(r.stream().phase, StreamPhase::Paused);
    assert!(!r.attached());
    assert_eq!(r.status().track_id, Some(ID));
}

#[test]
fn a_track_started_after_the_preview_drops_the_displaced_record() {
    let mut r = rig();
    play_second_track(&mut r);
    r.enter_editor();
    r.preview();
    r.handle(PlayerCmd::Stop);
    r.handle(PlayerCmd::Next);
    assert_eq!(r.status().track_id, Some(3));
    r.handle(PlayerCmd::Stop);
    let (item, _p) = live();
    r.handle(PlayerCmd::StreamStart(item));
    assert_eq!(r.stream().parked, None);
}

#[test]
fn removing_the_displaced_track_drops_its_record() {
    let mut r = rig();
    play_second_track(&mut r);
    r.enter_editor();
    r.preview();
    r.handle(PlayerCmd::Stop);
    r.handle(PlayerCmd::RemoveQueueItem { index: 1 });
    let (item, _p) = live();
    r.handle(PlayerCmd::StreamStart(item));
    assert_eq!(r.stream().parked, None);
}

// ---- Producer gone, seeks, shutdown ----

#[test]
fn a_gone_producer_buffers_and_emits_no_spectrum() {
    let mut r = rig();
    let (item, mut p) = live();
    r.start(item, &mut p);
    r.pull_until_starved(&p.control);
    p.control.set_producer_done();
    r.tick();
    let status = r.status();
    assert_eq!(r.stream().phase, StreamPhase::Buffering);
    assert!(!status.playing);
    assert!(r.sink().is_paused());

    r.log.lock().unwrap().clear();
    for _ in 0..3 {
        r.tick();
    }
    assert!(!r.emitted("player:spectrum"));
    assert_eq!(r.stream().phase, StreamPhase::Buffering);
}

#[test]
fn a_resume_on_an_empty_queue_stays_buffering() {
    let mut r = rig();
    let feed = r.hub.attach(false).expect("attaches");
    let (item, mut p) = live();
    r.start(item, &mut p);
    r.pull_until_starved(&p.control);
    r.tick();
    r.handle(PlayerCmd::Pause);
    feed.events.try_iter().count();

    r.handle(PlayerCmd::Resume);
    r.tick();
    assert_eq!(r.stream().phase, StreamPhase::Buffering);
    assert!(r.sink().is_paused());
    assert_eq!(
        feed_events(&feed.events),
        vec![(FeedCause::Resume, Transport::Buffering)]
    );

    p.push(REBUFFER_CHUNKS);
    r.tick();
    assert_eq!(r.stream().phase, StreamPhase::Playing);
    assert_eq!(
        feed_events(&feed.events),
        vec![(FeedCause::Buffered, Transport::Playing)]
    );
}

// Seeks a seekable item at 30 s and returns the generation the producer must answer.
fn seek_to_30(r: &mut Rig, p: &mut Producer) -> u64 {
    r.handle(PlayerCmd::Seek(30.0));
    assert!(!r.attached());
    let (secs, generation) = p.control.take_seek().expect("a seek is requested");
    assert_eq!(secs, 30.0);
    generation
}

#[test]
fn a_seek_break_taken_by_the_cancelled_source_still_starts_the_next_run() {
    let mut r = rig();
    let (item, mut p) = finite(60.0);
    p.control.open_seeks();
    r.start(item, &mut p);
    r.pull(4_000);
    let generation = seek_to_30(&mut r, &mut p);
    p.queue.flush();
    p.queue
        .push_break(Seam::Seek(generation))
        .expect("queues the answer");
    p.control.answer_seek(generation);
    // The cancelled source read the answer before it saw the cancel.
    let reader = r.engine.seating.seat.as_ref().unwrap().reader.clone();
    assert!(matches!(
        reader.try_next(),
        Some(Segment::Break(Seam::Seek(g))) if g == generation
    ));
    p.push_value(REBUFFER_CHUNKS, 0.5);
    r.tick();

    assert!(r.attached());
    assert_eq!(r.stream().phase, StreamPhase::Playing);
    let heard = r.pull_until_starved(&p.control);
    assert_eq!(
        heard.iter().filter(|&&s| s == 0.5).count(),
        REBUFFER_CHUNKS * CHUNK * 2,
        "no chunk after the answer is lost"
    );
}

#[test]
fn no_pre_seek_audio_plays_after_the_break() {
    let mut r = rig();
    let (item, mut p) = finite(60.0);
    p.control.open_seeks();
    r.start(item, &mut p);
    let generation = seek_to_30(&mut r, &mut p);
    // Answered without a flush: what was queued before stays queued.
    p.queue
        .push_break(Seam::Seek(generation))
        .expect("queues the answer");
    p.control.answer_seek(generation);
    // The stale chunks still count against the queue's limit until the reader drops them.
    p.push_value(18, 0.5);
    r.tick();

    assert!(r.attached());
    let heard = r.pull_until_starved(&p.control);
    assert!(!heard.contains(&0.25));
    assert!(heard.contains(&0.5));
}

#[test]
fn a_second_seek_before_the_answer_waits_for_the_newest() {
    let mut r = rig();
    let (item, mut p) = finite(60.0);
    p.control.open_seeks();
    r.start(item, &mut p);
    r.handle(PlayerCmd::Seek(10.0));
    let first = p.control.requested();
    r.handle(PlayerCmd::Seek(20.0));
    let (secs, newest) = p.control.take_seek().expect("a seek is requested");
    assert_eq!(secs, 20.0);
    assert!(newest > first);

    // The first answer is stale: nothing starts.
    p.queue.push_break(Seam::Seek(first)).expect("queued");
    p.control.answer_seek(first);
    r.tick();
    assert!(!r.attached());

    p.queue.flush();
    p.queue.push_break(Seam::Seek(newest)).expect("queued");
    p.control.answer_seek(newest);
    p.push(REBUFFER_CHUNKS);
    r.tick();
    assert!(r.attached());
    assert!((r.engine.position_secs() - 20.0).abs() < SLACK);
}

#[test]
fn shutdown_cancels_a_seated_item() {
    let mut r = rig();
    let (item, mut p) = live();
    r.start(item, &mut p);
    assert!(!p.control.is_cancelled());
    drop(r);
    assert!(p.control.is_cancelled());
}

// ---- Transport ----

#[test]
fn next_without_skip_does_nothing() {
    let mut r = rig();
    play_second_track(&mut r);
    let (item, mut p) = live();
    r.start(item, &mut p);
    p.signals();
    r.handle(PlayerCmd::Next);
    r.handle(PlayerCmd::Prev);
    assert!(p.signals().is_empty());
    let status = r.status();
    assert_eq!(status.track_id, Some(ID));
    assert_eq!(status.queue_index, 1);
    assert_eq!(r.stream().phase, StreamPhase::Playing);
    assert!(r.attached());
}

#[test]
fn next_with_skip_signals_the_owner() {
    let mut r = rig();
    play_second_track(&mut r);
    let (item, mut p) = live();
    r.start(item, &mut p);
    p.signals();
    p.skip.set(true, false);
    r.handle(PlayerCmd::Next);
    r.handle(PlayerCmd::Prev);
    assert_eq!(p.signals(), vec![StreamSignal::Skip(ID, SkipDir::Next)]);
    assert_eq!(r.status().track_id, Some(ID));
    assert!(r.attached());
}

#[test]
fn live_seek_is_ignored() {
    let mut r = rig();
    let (item, mut p) = live();
    r.start(item, &mut p);
    r.pull(4_000);
    let position = r.engine.position_secs();
    r.handle(PlayerCmd::Seek(10.0));
    assert!(r.attached());
    assert_eq!(r.stream().phase, StreamPhase::Playing);
    assert!(!p.control.seek_pending());
    assert!((r.engine.position_secs() - position).abs() < SLACK);
}

#[test]
fn facts_make_a_finite_item_seekable_with_a_duration() {
    let mut r = rig();
    let (item, _p) = live();
    r.handle(PlayerCmd::StreamStart(item));
    assert!(r.stream().live && !r.stream().seekable);
    let facts = |id| PlayerCmd::StreamFacts {
        id,
        live: false,
        seekable: true,
        duration_secs: Some(42.0),
    };
    // A stale id changes nothing.
    r.handle(facts(ID - 1));
    assert!(r.stream().live && !r.stream().seekable);
    assert_eq!(r.status().duration_secs, 0.0);

    r.handle(facts(ID));
    let stream = r.stream();
    assert!(!stream.live && stream.seekable);
    assert_eq!(r.status().duration_secs, 42.0);
}

#[test]
fn an_epoch_drops_the_old_queue_unheard_and_plays_the_new_one() {
    let mut r = rig();
    let (seated, mut old) = live();
    r.start(seated, &mut old);
    r.handle(PlayerCmd::StreamPause { id: ID, pause: true });
    old.push_value(5, 0.5);

    // A stale id changes nothing and cancels what it brought.
    let (stale, _) = item(ID - 1, true, None);
    let stale_control = Arc::clone(&stale.control);
    r.handle(PlayerCmd::StreamEpoch {
        id: ID - 1,
        pcm: stale.pcm,
        control: stale.control,
    });
    assert!(stale_control.is_cancelled());
    assert!(r.attached());

    let (fresh, mut new) = live();
    r.handle(PlayerCmd::StreamEpoch {
        id: ID,
        pcm: fresh.pcm,
        control: Arc::clone(&fresh.control),
    });
    assert!(old.control.is_cancelled());
    assert!(!r.attached());
    assert_eq!(r.stream().phase, StreamPhase::Paused);

    r.handle(PlayerCmd::StreamPause { id: ID, pause: false });
    assert_eq!(r.stream().phase, StreamPhase::Buffering);
    new.push_value(REBUFFER_CHUNKS, 0.75);
    r.tick();
    assert!(r.attached());
    assert_eq!(r.stream().phase, StreamPhase::Playing);
    let heard = r.pull(REBUFFER_CHUNKS * CHUNK);
    assert!(heard.contains(&0.75));
    assert!(!heard.contains(&0.5) && !heard.contains(&0.25), "nothing from the old queue");
}

#[test]
fn an_epoch_while_playing_cuts_the_old_queue_at_once() {
    let mut r = rig();
    let (seated, mut old) = live();
    r.start(seated, &mut old);
    assert!(r.hears(0.25));
    old.push_value(5, 0.5);
    let (fresh, mut new) = live();
    r.handle(PlayerCmd::StreamEpoch {
        id: ID,
        pcm: fresh.pcm,
        control: Arc::clone(&fresh.control),
    });
    assert!(old.control.is_cancelled());
    assert!(!r.attached());
    assert_eq!(r.stream().phase, StreamPhase::Buffering);
    new.push_value(REBUFFER_CHUNKS, 0.75);
    r.tick();
    assert_eq!(r.stream().phase, StreamPhase::Playing);
    let heard = r.pull(REBUFFER_CHUNKS * CHUNK);
    assert!(heard.contains(&0.75));
    assert!(!heard.contains(&0.5), "nothing queued before the cut");
}

#[test]
fn a_late_length_lands_without_moving_the_play_head() {
    let mut r = rig();
    let (seated, mut p) = item(ID, false, None);
    r.start(seated, &mut p);
    r.pull(4_000);
    let before = r.status();
    assert_eq!(before.duration_secs, 0.0);
    r.handle(PlayerCmd::StreamFacts {
        id: ID,
        live: false,
        seekable: true,
        duration_secs: Some(42.0),
    });
    let after = r.status();
    assert_eq!(after.duration_secs, 42.0);
    assert!(r.attached());
    assert_eq!(r.stream().phase, StreamPhase::Playing);
    assert!((after.position_secs - before.position_secs).abs() < SLACK);
    assert_eq!(
        (after.start_seq, after.seek_seq),
        (before.start_seq, before.seek_seq)
    );
}

#[test]
fn finite_seek_reattaches() {
    let mut r = rig();
    let feed = r.hub.attach(false).expect("attaches");
    let (item, mut p) = finite(60.0);
    p.control.open_seeks();
    r.start(item, &mut p);
    r.pull(4_000);
    let epoch = r.tap.epoch();

    r.handle(PlayerCmd::Seek(30.0));
    assert!(!r.attached());
    assert_eq!(r.stream().phase, StreamPhase::Buffering);
    assert_eq!(r.status().position_secs, 30.0);

    // The decode thread's answer.
    let (secs, generation) = p.control.take_seek().expect("a seek is requested");
    assert_eq!(secs, 30.0);
    p.queue.flush();
    p.queue
        .push_break(Seam::Seek(generation))
        .expect("queues the answer");
    p.control.answer_seek(generation);
    p.push(REBUFFER_CHUNKS);
    r.tick();

    assert!(r.attached());
    assert_eq!(r.stream().phase, StreamPhase::Playing);
    assert!((r.engine.position_secs() - 30.0).abs() < SLACK);
    assert_eq!(r.tap.epoch(), epoch + 1);
    let causes: Vec<FeedCause> = feed_events(&feed.events).into_iter().map(|e| e.0).collect();
    assert_eq!(causes.last(), Some(&FeedCause::Seek));
    assert!(r.hears(0.25));
}

#[test]
fn rebind_reattaches_without_reconnect() {
    let mut r = rig();
    let feed = r.hub.attach(false).expect("attaches");
    let (item, mut p) = live();
    r.start(item, &mut p);
    r.pull(4_000);
    let position = r.engine.position_secs();
    let epoch = r.tap.epoch();

    let (sink, out) = Sink::new_idle();
    r.engine.sink = Some(sink);
    *r.output.out.lock().unwrap() = out;
    r.output.backlog.lock().unwrap().clear();
    r.call(|e| e.stream_rebound());

    assert!(!p.control.is_cancelled());
    assert!(r.attached());
    assert!(!r.sink().empty());
    assert_eq!(r.tap.epoch(), epoch + 1);
    assert!((r.engine.position_secs() - position).abs() < SLACK);
    let causes: Vec<FeedCause> = feed_events(&feed.events).into_iter().map(|e| e.0).collect();
    assert_eq!(causes.last(), Some(&FeedCause::Device));
    assert!(r.hears(0.25));
}

#[test]
fn no_preload_while_seated() {
    let mut r = rig();
    let queue = r.library(2);
    r.handle(PlayerCmd::Play { queue, index: 0 });
    let (item, mut p) = finite(2.0);
    r.start(item, &mut p);
    for _ in 0..3 {
        r.pull(2_000);
        r.tick();
    }
    assert!(r.engine.pending.is_none());
    assert!(r.engine.preload_tried.is_none());
}

#[test]
fn no_play_is_recorded_for_a_stream() {
    let mut r = rig();
    let (item, mut p) = finite(1.0);
    r.handle(PlayerCmd::StreamStart(item));
    p.push(10);
    p.queue.push_end().expect("queues the end");
    r.tick();
    for _ in 0..100 {
        if !r.attached() {
            break;
        }
        r.pull(1_000);
        r.tick();
    }
    assert!(!r.attached(), "the stream never reached its end");
    assert!(p
        .signals()
        .contains(&StreamSignal::Ended(ID, StreamEndReason::Finished)));
    assert!(!r.emitted("player:played"));
}

#[test]
fn feed_reports_stream_live_and_buffering() {
    let mut r = rig();
    let feed = r.hub.attach(false).expect("attaches");
    let (item, mut p) = live();
    r.handle(PlayerCmd::StreamStart(item));
    let seated: Vec<FeedEvent> = feed.events.try_iter().collect();
    assert_eq!(seated.len(), 1);
    assert_eq!(seated[0].cause, FeedCause::Buffering);
    assert_eq!(seated[0].state.transport, Transport::Buffering);
    assert_eq!(seated[0].state.source, FeedSource::Stream);
    assert!(seated[0].state.live);

    p.push(START_CHUNKS);
    r.tick();
    r.pull_until_starved(&p.control);
    r.tick();
    p.push(REBUFFER_CHUNKS);
    r.tick();
    let events: Vec<FeedEvent> = feed.events.try_iter().collect();
    let got: Vec<(FeedCause, Transport)> = events
        .iter()
        .map(|e| (e.cause, e.state.transport))
        .collect();
    assert_eq!(
        got,
        vec![
            (FeedCause::Start, Transport::Playing),
            (FeedCause::Buffering, Transport::Buffering),
            (FeedCause::Buffered, Transport::Playing),
        ]
    );
    assert!(events
        .iter()
        .all(|e| e.state.source == FeedSource::Stream && e.state.live));
    assert_eq!(events[0].state.sample_rate, RATE);

    // A library track reports itself as one.
    r.handle(PlayerCmd::Stop);
    let queue = r.library(1);
    r.handle(PlayerCmd::Play { queue, index: 0 });
    let last = feed.events.try_iter().last().expect("a start");
    assert_eq!(last.state.source, FeedSource::Track);
    assert!(!last.state.live);
}

#[test]
fn takeover_mutes_a_stream_and_the_tap_advances() {
    let mut r = rig();
    r.handle(PlayerCmd::SetOutputTakeover(true));
    let (item, mut p) = live();
    r.start(item, &mut p);
    assert_eq!(r.sink().volume(), 0.0);
    let heard = r.pull_until_starved(&p.control);
    assert!(heard.iter().all(|&s| s == 0.0), "nothing is heard");
    assert!(r.engine.position_secs() > 1.0);
    assert!(r.tap.write_cursor() > 0);
    assert!(tapped(&r.tap).iter().all(|&s| s == 0.25));
}

#[test]
fn status_carries_the_stream_phase() {
    let mut r = rig();
    let (item, mut p) = finite(42.0);
    r.handle(PlayerCmd::StreamStart(item));
    let json = serde_json::to_value(r.status()).expect("serializes");
    assert_eq!(json["stream"]["phase"], "connecting");
    assert_eq!(json["playing"], false);
    assert_eq!(json["track_id"], ID);
    assert_eq!(json["duration_secs"], 42.0);

    p.push(START_CHUNKS);
    r.tick();
    let json = serde_json::to_value(r.status()).expect("serializes");
    assert_eq!(json["stream"]["phase"], "playing");
    assert_eq!(json["playing"], true);

    r.handle(PlayerCmd::TogglePlay);
    let json = serde_json::to_value(r.status()).expect("serializes");
    assert_eq!(json["stream"]["phase"], "paused");
    assert_eq!(json["playing"], false);
    assert!(r.sink().is_paused());

    r.handle(PlayerCmd::StreamPause {
        id: ID,
        pause: false,
    });
    assert_eq!(r.stream().phase, StreamPhase::Playing);
    assert!(!r.sink().is_paused());
}

#[test]
fn every_set_volume_site_in_the_seat_goes_through_the_helper() {
    let seat = include_str!("../seat.rs");
    let seat = &seat[..seat.find("#[cfg(test)]").expect("the tests module")];
    let files = [
        seat,
        include_str!("run.rs"),
        include_str!("preview.rs"),
        include_str!("parked.rs"),
    ];
    let sites: Vec<&str> = files
        .iter()
        .flat_map(|file| file.lines())
        .map(str::trim_start)
        .filter(|line| line.contains(".set_volume("))
        .collect();
    assert_eq!(sites.len(), 2);
    assert!(sites
        .iter()
        .all(|line| *line == "sink.set_volume(self.output_volume());"));
}

// The longest a production file of the stream seat or the stream source may grow. This test file is
// exempt: many small cases around one shared rig read best together.
const LINE_CAP: usize = 500;

#[test]
fn the_seat_and_stream_source_files_stay_under_the_line_cap() {
    let files = [
        ("engine/seat.rs", include_str!("../seat.rs")),
        ("engine/seat/run.rs", include_str!("run.rs")),
        ("engine/seat/preview.rs", include_str!("preview.rs")),
        ("engine/seat/parked.rs", include_str!("parked.rs")),
        ("engine/events.rs", include_str!("../events.rs")),
        ("source/stream.rs", include_str!("../../source/stream.rs")),
    ];
    for (name, text) in files {
        let lines = text.lines().count();
        assert!(
            lines <= LINE_CAP,
            "{name} has {lines} lines, over {LINE_CAP}"
        );
    }
}

// ---- Status counters ----

#[test]
fn start_seq_bumps_on_start_gapless_and_load() {
    let mut r = rig();
    assert_eq!(r.status().start_seq, 0);

    let queue = r.library(2);
    r.handle(PlayerCmd::Play { queue, index: 0 });
    assert_eq!(r.status().start_seq, 1);

    // The preload takes over at the boundary.
    gapless_boundary(&mut r);
    assert_eq!(r.status().track_id, Some(2));
    assert_eq!(r.status().start_seq, 2);

    let queue = r.library(2);
    r.handle(PlayerCmd::Load {
        queue,
        index: 1,
        secs: 1.0,
    });
    assert_eq!(r.status().start_seq, 3);

    // Pause, resume, volume and a tick start nothing.
    r.handle(PlayerCmd::Resume);
    r.handle(PlayerCmd::SetVolume(0.5));
    r.handle(PlayerCmd::Pause);
    r.tick();
    let status = r.status();
    assert_eq!(status.start_seq, 3);
    assert_eq!(status.seek_seq, 1, "only the boundary setup seek counts");
}

#[test]
fn seek_seq_bumps_on_a_user_seek_only() {
    let mut r = rig();
    let queue = r.library(1);
    r.handle(PlayerCmd::Play { queue, index: 0 });
    let started = r.status().start_seq;

    r.handle(PlayerCmd::Seek(2.0));
    assert_eq!(r.status().seek_seq, 1);
    r.handle(PlayerCmd::Seek(3.0));
    assert_eq!(r.status().seek_seq, 2);
    assert_eq!(r.status().start_seq, started, "a seek is not a start");
    // The forced status a seek emits already carries the counter.
    let mirrored = r.engine.status.lock().unwrap().seek_seq;
    assert_eq!(mirrored, 2);

    // A seekable stream counts when the request reaches the producer.
    let (item, mut p) = finite(60.0);
    p.control.open_seeks();
    r.start(item, &mut p);
    r.handle(PlayerCmd::Seek(30.0));
    assert_eq!(r.status().seek_seq, 3);
}

#[test]
fn rebind_bumps_no_seek_seq() {
    let mut r = rig();
    let queue = r.library(1);
    r.handle(PlayerCmd::Play { queue, index: 0 });
    let before = r.status();

    // The library branch of a rebind re-seeks through `seek`, not the command.
    let secs = r.engine.position_secs();
    assert!(r.call(|e| e.seek(secs, false)));
    assert_eq!(r.status().seek_seq, before.seek_seq);

    let (item, mut p) = live();
    r.start(item, &mut p);
    let before = r.status();
    r.call(|e| e.stream_rebound());
    let after = r.status();
    assert_eq!(after.seek_seq, before.seek_seq);
    assert_eq!(after.start_seq, before.start_seq);
}

#[test]
fn a_failed_seek_bumps_nothing() {
    let mut r = rig();
    // Nothing seated.
    r.handle(PlayerCmd::Seek(1.0));
    assert_eq!(r.status().seek_seq, 0);

    let queue = r.library(1);
    let path = queue[0].path.clone();
    r.handle(PlayerCmd::Play { queue, index: 0 });
    std::fs::remove_file(path).expect("the track file goes");
    r.handle(PlayerCmd::Seek(1.0));
    assert_eq!(r.status().seek_seq, 0);
}

#[test]
fn a_live_stream_seek_bumps_nothing() {
    let mut r = rig();
    let (item, mut p) = live();
    r.start(item, &mut p);
    r.handle(PlayerCmd::Seek(10.0));
    assert_eq!(r.status().seek_seq, 0);
}

// Seeks the playing first track near its end, arms the preload and plays the boundary out. The
// next tick promotes the preload.
fn gapless_boundary(r: &mut Rig) {
    r.handle(PlayerCmd::Seek(9.5));
    r.tick();
    assert!(r.engine.pending.is_some(), "the preload is armed");
    for _ in 0..1_000 {
        r.pull(500);
        let ended = r.engine.cur_ended.as_ref().is_some_and(|e| e.load(Ordering::Relaxed));
        if ended {
            r.tick();
            return;
        }
    }
    panic!("the first track never ended");
}

fn start_seq(r: &Rig) -> u64 {
    r.status().start_seq
}

#[test]
fn repeat_one_replay_bumps_start_seq_once() {
    let mut r = rig();
    let queue = r.library(1);
    r.handle(PlayerCmd::Play { queue, index: 0 });
    r.handle(PlayerCmd::SetRepeat(RepeatMode::One));
    r.handle(PlayerCmd::Seek(9.5));
    let before = start_seq(&r);
    r.pull_until_drained();
    r.tick();
    assert_eq!(start_seq(&r), before + 1);
    assert_eq!(r.status().track_id, Some(1));
}

#[test]
fn a_restore_after_a_preview_bumps_start_seq_once() {
    let mut r = rig();
    let queue = r.library(1);
    r.handle(PlayerCmd::Play { queue, index: 0 });
    let before = start_seq(&r);
    r.preview();
    assert_eq!(start_seq(&r), before, "a preview start is no item start");
    r.handle(PlayerCmd::Stop);
    r.handle(PlayerCmd::RestoreLibrary {
        secs: 0.25,
        playing: true,
    });
    assert_eq!(start_seq(&r), before + 1);
}

#[test]
fn reseating_the_parked_track_bumps_start_seq_once() {
    let mut r = rig();
    play_second_track(&mut r);
    let (item, mut p) = live();
    r.start(item, &mut p);
    let before = start_seq(&r);
    r.pull_until_starved(&p.control);
    r.tick();
    p.push(REBUFFER_CHUNKS);
    p.queue.push_end().expect("queues the end");
    r.tick();
    r.pull_until_drained();
    r.tick();
    assert_eq!(r.status().track_id, Some(2));
    assert_eq!(start_seq(&r), before + 1);
}

#[test]
fn a_stream_cold_start_bumps_start_seq_once() {
    let mut r = rig();
    let (item, mut p) = live();
    r.start(item, &mut p);
    assert_eq!(start_seq(&r), 1);

    // A preview over the item and its release restart the run cold.
    p.push(REBUFFER_CHUNKS);
    r.preview();
    assert_eq!(start_seq(&r), 1);
    r.handle(PlayerCmd::Stop);
    assert!(r.attached());
    assert_eq!(start_seq(&r), 2);
}

#[test]
fn a_stream_seek_reattach_leaves_start_seq_flat() {
    let mut r = rig();
    let (item, mut p) = finite(60.0);
    p.control.open_seeks();
    r.start(item, &mut p);
    let before = start_seq(&r);
    let generation = seek_to_30(&mut r, &mut p);
    p.queue.flush();
    p.queue
        .push_break(Seam::Seek(generation))
        .expect("queues the answer");
    p.control.answer_seek(generation);
    p.push(REBUFFER_CHUNKS);
    r.tick();
    assert!(r.attached());
    assert_eq!(start_seq(&r), before);
    assert_eq!(r.status().seek_seq, 1);
}

// ---- Blocks ----

// Loose 1, the album 2-3-4 sent as one block, loose 5 and 6.
fn album_queue(r: &Rig) -> Vec<QueueTrack> {
    let mut queue = vec![r.track(1)];
    queue.extend(r.album(&[2, 3, 4]));
    queue.extend([r.track(5), r.track(6)]);
    queue
}

fn mirror(r: &Rig) -> QueueMirror {
    r.engine.queue_mirror.lock().unwrap().clone()
}

#[test]
fn shuffle_on_mid_block_pins_the_block_and_keeps_the_next_members_preload() {
    let mut r = rig();
    let queue = album_queue(&r);
    r.handle(PlayerCmd::Play { queue, index: 2 });
    // Paused near the end, so the preload for id 4 is armed and nothing plays out meanwhile.
    r.handle(PlayerCmd::Pause);
    r.handle(PlayerCmd::Seek(9.5));
    r.tick();
    assert_eq!(r.engine.pending.as_ref().map(|p| p.id), Some(4));
    let started = r.status().start_seq;

    r.handle(PlayerCmd::SetShuffle(true));
    assert_eq!(r.queue_ids()[..3], [2, 3, 4]);
    let status = r.status();
    assert_eq!(status.queue_index, 1);
    assert_eq!(status.track_id, Some(3));
    assert_eq!(status.start_seq, started, "the sink is untouched");
    let pending = r.engine.pending.as_ref().expect("the preload survives");
    assert_eq!((pending.slot, pending.id), (2, 4));
    assert_eq!(mirror(&r).blocks, vec![[0, 3]]);
}

#[test]
fn load_with_spans_keeps_the_block_for_a_later_shuffle() {
    let mut r = rig();
    let queue = album_queue(&r);
    r.handle(PlayerCmd::Load {
        queue,
        index: 2,
        secs: 1.0,
    });
    assert_eq!(mirror(&r).blocks, vec![[1, 3]]);
    r.handle(PlayerCmd::SetShuffle(true));
    assert_eq!(r.queue_ids()[..3], [2, 3, 4]);
    assert_eq!(r.status().queue_index, 1);
    assert_eq!(r.status().track_id, Some(3));
    r.handle(PlayerCmd::SetShuffle(false));
    assert_eq!(r.queue_ids(), vec![1, 2, 3, 4, 5, 6]);
    assert_eq!(r.status().queue_index, 2);
}

#[test]
fn the_parked_queue_keeps_blocks() {
    // Insert next lands after the parked track's block.
    let mut r = rig();
    let mut queue = r.album(&[1, 2, 3]);
    queue.push(r.track(4));
    r.handle(PlayerCmd::Play { queue, index: 0 });
    let (item, mut p) = live();
    r.start(item, &mut p);
    let track = r.track(9);
    r.handle(PlayerCmd::InsertNext(vec![track]));
    assert_eq!(r.queue_ids(), vec![1, 2, 3, 9, 4]);
    assert_eq!(r.stream().parked.map(|p| p.track_id), Some(1));
    assert_eq!(r.status().queue_index, 0);

    // Clear empties the mirror, blocks included.
    r.handle(PlayerCmd::ClearParked);
    assert_eq!(mirror(&r), QueueMirror::default());
    // An empty queue shuffles without a panic.
    r.handle(PlayerCmd::SetShuffle(true));
    r.handle(PlayerCmd::SetShuffle(false));
    assert!(r.queue_ids().is_empty());

    // The boot restore into an empty parked slot keeps its blocks.
    let mut r = rig();
    let (item, _p) = live();
    r.handle(PlayerCmd::StreamStart(item));
    let mut queue = r.album(&[1, 2, 3]);
    queue.push(r.track(4));
    r.handle(PlayerCmd::Load {
        queue,
        index: 1,
        secs: 2.0,
    });
    assert_eq!(mirror(&r).blocks, vec![[0, 3]]);
    assert_eq!(r.stream().parked.map(|p| p.track_id), Some(2));
    let track = r.track(9);
    r.handle(PlayerCmd::InsertNext(vec![track]));
    assert_eq!(r.queue_ids(), vec![1, 2, 3, 9, 4]);
}

#[test]
fn an_album_queued_twice_reseats_on_the_playing_copy() {
    let mut r = rig();
    let first = r.album(&[1, 2]);
    r.handle(PlayerCmd::Play {
        queue: first,
        index: 0,
    });
    let second = r.album(&[1, 2]);
    r.handle(PlayerCmd::Enqueue(second));
    assert_eq!(mirror(&r).blocks, vec![[0, 2], [2, 2]], "two intakes are two blocks");
    r.handle(PlayerCmd::Jump(2));
    r.handle(PlayerCmd::SetShuffle(true));
    r.handle(PlayerCmd::SetShuffle(false));
    assert_eq!(r.status().queue_index, 2);
    assert_eq!(r.status().track_id, Some(1));

    // Removing the other copy of the playing id leaves playback alone.
    let started = r.status().start_seq;
    r.handle(PlayerCmd::RemoveQueueItem { index: 0 });
    let status = r.status();
    assert_eq!((status.track_id, status.queue_index), (Some(1), 1));
    assert_eq!(status.start_seq, started);
}

#[test]
fn removing_another_loose_copy_of_the_playing_track_plays_on() {
    let mut r = rig();
    let queue = vec![r.track(1), r.track(2), r.track(1), r.track(3), r.track(1)];
    r.handle(PlayerCmd::Play { queue, index: 2 });
    let started = r.status().start_seq;
    // The copy before the cursor, then the copy after it.
    r.handle(PlayerCmd::RemoveQueueItem { index: 0 });
    assert_eq!(r.status().queue_index, 1);
    r.handle(PlayerCmd::RemoveQueueItem { index: 3 });
    let status = r.status();
    assert_eq!(r.queue_ids(), vec![2, 1, 3]);
    assert_eq!((status.track_id, status.queue_index), (Some(1), 1));
    assert_eq!(status.start_seq, started, "nothing was skipped");
}

#[test]
fn moving_an_unrelated_row_keeps_the_cursor_on_its_row() {
    // The later loose copy of id 1 plays, with an earlier copy ahead of it.
    let mut r = rig();
    let queue = vec![r.track(1), r.track(2), r.track(3), r.track(1)];
    r.handle(PlayerCmd::Play { queue, index: 3 });
    // Id 2 moves from before the cursor to after it, then back to the front.
    r.handle(PlayerCmd::MoveQueueItem { from: 1, to: 3 });
    assert_eq!(r.queue_ids(), vec![1, 3, 1, 2]);
    assert_eq!(r.status().queue_index, 2);
    r.handle(PlayerCmd::MoveQueueItem { from: 3, to: 0 });
    assert_eq!(r.queue_ids(), vec![2, 1, 3, 1]);
    assert_eq!(r.status().queue_index, 3);
    assert_eq!(r.status().track_id, Some(1));
}

#[test]
fn moving_the_playing_row_keeps_the_cursor_on_it() {
    // After each move: the cursor holds the playing row, the mirror matches and nothing restarted.
    fn assert_on(r: &Rig, id: i64, started: u64, at: &str) {
        let status = r.status();
        assert_eq!(r.engine.queue[status.queue_index].id, id, "{at}");
        assert_eq!(status.track_id, Some(id), "{at}");
        assert_eq!(status.start_seq, started, "{at}");
        let want = QueueMirror {
            ids: r.queue_ids(),
            blocks: block_spans(&r.engine.queue),
        };
        assert_eq!(mirror(r), want, "{at}");
    }

    // A loose row, shuffle off: later, earlier, and dropped inside a block, where it lands after.
    let mut r = rig();
    let queue = album_queue(&r);
    r.handle(PlayerCmd::Play { queue, index: 0 });
    let started = r.status().start_seq;
    r.handle(PlayerCmd::MoveQueueItem { from: 0, to: 5 });
    assert_eq!(r.queue_ids(), vec![2, 3, 4, 5, 6, 1]);
    assert_on(&r, 1, started, "later");
    r.handle(PlayerCmd::MoveQueueItem { from: 5, to: 0 });
    assert_eq!(r.queue_ids(), vec![1, 2, 3, 4, 5, 6]);
    assert_on(&r, 1, started, "earlier");
    r.handle(PlayerCmd::MoveQueueItem { from: 0, to: 2 });
    assert_eq!(r.queue_ids(), vec![2, 3, 4, 1, 5, 6]);
    assert_on(&r, 1, started, "into a block");

    // A member, shuffle off: out of its block, then back in.
    let mut r = rig();
    let queue = album_queue(&r);
    r.handle(PlayerCmd::Play { queue, index: 2 });
    let started = r.status().start_seq;
    r.handle(PlayerCmd::MoveQueueItem { from: 2, to: 5 });
    assert_eq!(r.queue_ids(), vec![1, 2, 4, 5, 6, 3]);
    assert_eq!(mirror(&r).blocks, vec![[1, 2]]);
    assert_on(&r, 3, started, "out of its block");
    r.handle(PlayerCmd::MoveQueueItem { from: 5, to: 2 });
    assert_eq!(r.queue_ids(), vec![1, 2, 3, 4, 5, 6]);
    assert_eq!(mirror(&r).blocks, vec![[1, 3]]);
    assert_on(&r, 3, started, "back into its block");

    // The same member under shuffle: out to a later slot, back in at the block's start.
    r.handle(PlayerCmd::SetShuffle(true));
    assert_on(&r, 3, started, "shuffled");
    r.handle(PlayerCmd::MoveQueueItem { from: 1, to: 4 });
    assert_eq!(r.status().queue_index, 4);
    assert_eq!(mirror(&r).blocks, vec![[0, 2]]);
    assert_on(&r, 3, started, "out under shuffle");
    r.handle(PlayerCmd::MoveQueueItem { from: 4, to: 0 });
    assert_eq!(r.status().queue_index, 0);
    assert_eq!(mirror(&r).blocks, vec![[0, 3]]);
    assert_on(&r, 3, started, "back in under shuffle");
    r.handle(PlayerCmd::SetShuffle(false));
    assert_eq!(r.queue_ids(), vec![1, 2, 3, 4, 5, 6]);
    assert_on(&r, 3, started, "shuffle off");
}

#[test]
fn the_mirror_matches_the_queue_after_every_command() {
    let mut r = rig();
    let queue = album_queue(&r);
    let album = r.album(&[7, 8]);
    let next = vec![r.track(9)];
    let reload = album_queue(&r);
    // Each command, and whether it changes the queue.
    let commands = vec![
        (PlayerCmd::Play { queue, index: 2 }, true),
        (PlayerCmd::Enqueue(album), true),
        (PlayerCmd::InsertNext(next), true),
        (PlayerCmd::MoveQueueItem { from: 0, to: 6 }, true),
        (PlayerCmd::RemoveQueueItem { index: 1 }, true),
        (PlayerCmd::SetShuffle(true), true),
        (PlayerCmd::MoveQueueItem { from: 0, to: 4 }, true),
        (PlayerCmd::SetShuffle(false), true),
        (PlayerCmd::SetRepeat(RepeatMode::All), false),
        (
            PlayerCmd::Load {
                queue: reload,
                index: 3,
                secs: 0.0,
            },
            true,
        ),
    ];
    for (cmd, changes_queue) in commands {
        r.log.lock().unwrap().clear();
        r.handle(cmd);
        let want = QueueMirror {
            ids: r.queue_ids(),
            blocks: block_spans(&r.engine.queue),
        };
        assert_eq!(mirror(&r), want);
        let log = r.log.lock().unwrap();
        let queue_events: Vec<&(String, serde_json::Value)> = log
            .iter()
            .filter(|(e, _)| e.starts_with("player:queue"))
            .collect();
        if !changes_queue {
            assert!(queue_events.is_empty());
            continue;
        }
        let [(ids_event, ids), (state_event, state)] = queue_events.as_slice() else {
            panic!("a queue change emits the pair once: {queue_events:?}");
        };
        assert_eq!(ids_event, "player:queue");
        assert_eq!(*ids, serde_json::to_value(&want.ids).unwrap());
        assert_eq!(state_event, "player:queue_state");
        assert_eq!(*state, serde_json::to_value(&want).unwrap());
    }
    assert_eq!(mirror(&r).blocks, vec![[1, 3]]);
    let tokens: Vec<Option<u64>> = r.copies()[1..4].iter().map(|c| c.1).collect();
    assert!(tokens[0].is_some() && tokens.iter().all(|t| *t == tokens[0]));
}

// Opened files decoded in helpers, on the same rig.
mod opened_files;
