/*
 * tap-meter: a reference native plugin for Plisto. It speaks protocol v1 on stdin and stdout, follows
 * the audio tap in shared memory, and reports its state and peak levels through `status`.
 *
 * Two threads do the work. The reader thread owns stdin and does nothing slow: it answers `ping` at once,
 * keeps the last playback `feed` event and notes whether the page is open. The reporter thread polls the
 * tap and writes `status` and `log`. Both write frames through the stdout lock, which keeps each frame
 * whole.
 */

mod args;
mod meter;
mod protocol;
mod status;
mod tap;
#[cfg(test)]
mod test_ring;

// -- Library Imports --
use std::io;
use std::process::{self, ExitCode};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};

// -- Local Imports --
use args::Config;
use meter::Levels;
use protocol::{
    decode, read_frame, write_message, ChildMessage, Decoded, HostMessage, LogLevel, HOST_KINDS,
    PROTOCOL_VERSION,
};
use status::{Gate, TapState};
use tap::{Event, Follower, Mapping};

// How often the tap is polled. The ring holds seconds of audio, so this is far inside the overrun limit.
const POLL: Duration = Duration::from_millis(20);
// How often a status line is considered for sending; the gate holds it to one a second.
const REPORT_EVERY: Duration = Duration::from_millis(250);
// Lines per run that report discontinuities and feed events, so a seek-heavy session cannot flood the log.
const NOISY_LOG_LINES: u32 = 40;
const CRASH_EXIT_CODE: i32 = 3;

/// The fields of a `feed` event this plugin uses. The event carries more; unknown fields are ignored.
#[derive(Default, Deserialize)]
struct Feed {
    #[serde(default)]
    cause: String,
    #[serde(default)]
    transport: String,
}

#[derive(Default)]
struct Shared {
    feed: Mutex<Option<Feed>>,
    stop: AtomicBool,
    /// Whether the plugin's page is shown. Nothing reads it yet.
    page_open: AtomicBool,
}

/// Writes one frame. Plisto going away ends the process, since there is nobody to talk to.
fn send(message: &ChildMessage) {
    if write_message(&mut io::stdout().lock(), message).is_err() {
        process::exit(0);
    }
}

fn log(level: LogLevel, text: String) {
    eprintln!("tap-meter: {level:?}: {text}");
    send(&ChildMessage::Log { level, text });
}

fn send_status(line: status::Line) {
    send(&ChildMessage::Status {
        state: line.state,
        text: line.text,
    });
}

/// A cap on log lines that can repeat without bound.
struct LogBudget(u32);

impl LogBudget {
    fn log(&mut self, level: LogLevel, text: String) {
        match self.0 {
            0 => {}
            1 => log(
                LogLevel::Info,
                "further discontinuities are not logged".into(),
            ),
            _ => log(level, text),
        }
        self.0 = self.0.saturating_sub(1);
    }
}

/// Reads the host's messages until `shutdown` or the end of input.
fn serve(config: &Config, shared: &Shared, ready: mpsc::Sender<()>) {
    let mut input = io::stdin().lock();
    let mut pings = 0u32;
    let mut stalled_until: Option<Instant> = None;
    loop {
        let body = match read_frame(&mut input) {
            Ok(Some(body)) => body,
            Ok(None) => return,
            Err(e) => {
                eprintln!("tap-meter: input ended: {e}");
                return;
            }
        };
        match decode::<HostMessage>(&body, HOST_KINDS) {
            Decoded::Message(HostMessage::Hello {
                plisto_version,
                id,
                granted,
                ..
            }) => {
                send(&ChildMessage::Ready {
                    protocol: PROTOCOL_VERSION,
                });
                eprintln!("tap-meter: {id} on Plisto {plisto_version}, granted {granted:?}");
                let _ = ready.send(());
            }
            Decoded::Message(HostMessage::Ping { seq }) => {
                pings += 1;
                if let (2, Some(length)) = (pings, config.stall) {
                    stalled_until = Some(Instant::now() + length);
                }
                // A stalled plugin stays silent; the host sees no `pong` until the stall is over.
                if stalled_until.is_none_or(|end| Instant::now() >= end) {
                    send(&ChildMessage::Pong { seq });
                }
            }
            Decoded::Message(HostMessage::Shutdown) => return,
            // Answered so a caller never waits; the plugin has no methods yet.
            Decoded::Message(HostMessage::Call { seq, .. }) => send(&ChildMessage::Result {
                seq,
                ok: false,
                result: None,
                error: Some(json!({ "message": "unsupported" })),
            }),
            Decoded::Message(HostMessage::Feed { event, .. }) => keep_feed(shared, event),
            Decoded::Message(HostMessage::Page { open }) => {
                shared.page_open.store(open, Ordering::Relaxed);
            }
            Decoded::Message(HostMessage::TakeoverState { held, reason }) => {
                eprintln!("tap-meter: takeover held={held} ({reason:?})");
            }
            Decoded::Message(HostMessage::HostResult { .. } | HostMessage::SidebarInput { .. }) => {
            }
            Decoded::Unknown(kind) => eprintln!("tap-meter: ignored message type '{kind}'"),
            Decoded::Malformed(why) => eprintln!("tap-meter: ignored a malformed frame: {why}"),
        }
    }
}

fn keep_feed(shared: &Shared, event: Value) {
    if let Ok(feed) = serde_json::from_value::<Feed>(event) {
        if let Ok(mut last) = shared.feed.lock() {
            *last = Some(feed);
        }
    }
}

/// Follows the tap and reports levels, until `shared.stop` is set.
fn report(config: &Config, shared: &Shared) {
    let mut tap: Option<(Mapping, Follower)> = None;
    let mut open_failed = false;
    let mut gate = Gate::default();
    let mut levels = Levels::default();
    let mut overruns = 0u64;
    let mut epoch: Option<u32> = None;
    let mut budget = LogBudget(NOISY_LOG_LINES);
    let mut last_feed_cause = String::new();
    let mut next_report = Instant::now();

    while !shared.stop.load(Ordering::Relaxed) {
        if let (Some(name), None) = (&config.tap, &tap) {
            match Mapping::open(name) {
                Ok(map) => {
                    log(LogLevel::Info, format!("tap opened: {name}"));
                    let follower = Follower::live(&map);
                    tap = Some((map, follower));
                }
                Err(e) if !open_failed => {
                    open_failed = true;
                    log(
                        LogLevel::Warn,
                        format!("cannot open tap {name}: {e}; retrying"),
                    );
                }
                Err(_) => {}
            }
        }
        if let Some((map, follower)) = &mut tap {
            follower.poll(map, &mut |event| match event {
                Event::Segment(s) if epoch != Some(s.epoch) => {
                    epoch = Some(s.epoch);
                    levels.reset();
                    budget.log(
                        LogLevel::Info,
                        format!("epoch {}: {} Hz, {} ch", s.epoch, s.rate, s.channels),
                    );
                }
                Event::Segment(_) => {}
                Event::Samples {
                    segment,
                    first,
                    data,
                } => levels.add(&segment, first, data),
                Event::Overrun => {
                    overruns += 1;
                    epoch = None;
                    levels.reset();
                    budget.log(
                        LogLevel::Warn,
                        format!("overrun {overruns}: resynced to the live position"),
                    );
                }
            });
        }

        let transport = match shared.feed.lock() {
            Ok(guard) => guard
                .as_ref()
                .map(|f| (f.transport.clone(), f.cause.clone())),
            Err(_) => None,
        };
        if let Some((_, cause)) = &transport {
            if *cause != last_feed_cause {
                budget.log(LogLevel::Debug, format!("feed: {cause}"));
                last_feed_cause = cause.clone();
            }
        }

        if Instant::now() >= next_report {
            next_report += REPORT_EVERY;
            let state = match (&config.tap, &tap) {
                (None, _) => TapState::Missing,
                (Some(_), None) => TapState::Closed,
                (Some(_), Some(_)) => TapState::Open,
            };
            let window = levels.take();
            let current = status::line(state, transport.as_ref().map(|t| t.0.as_str()), &window);
            if let Some(line) = gate.offer(current, Instant::now()) {
                send_status(line);
            }
        }
        thread::sleep(POLL);
    }
}

/// Exits abruptly after `after`, unless the plugin is stopped first.
fn crash_after(after: Duration, shared: &Shared) {
    let deadline = Instant::now() + after;
    while Instant::now() < deadline {
        if shared.stop.load(Ordering::Relaxed) {
            return;
        }
        thread::sleep(POLL);
    }
    eprintln!("tap-meter: crashing on purpose");
    process::exit(CRASH_EXIT_CODE);
}

fn main() -> ExitCode {
    let config = args::load();
    for warning in &config.warnings {
        eprintln!("tap-meter: {warning}");
    }
    if config.protocol.is_some_and(|p| p != PROTOCOL_VERSION) {
        eprintln!(
            "tap-meter: Plisto speaks protocol {:?}, this plugin speaks 1",
            config.protocol
        );
        return ExitCode::from(2);
    }

    let shared = Shared::default();
    let (ready_tx, ready_rx) = mpsc::channel();
    thread::scope(|scope| {
        let (config, shared) = (&config, &shared);
        let reader = thread::Builder::new()
            .name("reader".into())
            .spawn_scoped(scope, move || serve(config, shared, ready_tx))
            .expect("starts the reader thread");
        // The channel closes unanswered when the input ends before `hello`.
        let greeted = ready_rx.recv().is_ok();
        if greeted {
            scope.spawn(move || report(config, shared));
            if let Some(after) = config.crash_after {
                scope.spawn(move || crash_after(after, shared));
            }
            if config.takeover {
                send(&ChildMessage::Takeover { hold: true });
            }
        }
        let _ = reader.join();
        shared.stop.store(true, Ordering::Relaxed);
        if greeted && config.takeover {
            send(&ChildMessage::Takeover { hold: false });
        }
    });
    ExitCode::SUCCESS
}
