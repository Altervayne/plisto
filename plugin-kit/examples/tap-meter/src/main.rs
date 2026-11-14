/*
 * tap-meter: a reference native plugin for Plisto. It speaks protocol v1 on stdin and stdout, follows
 * the audio tap in shared memory, reports its state and peak levels through `status`, feeds level
 * meters to its page, answers its page's calls, drives its sidebar items and can hold Plisto's output.
 *
 * Two threads do the work. The reader thread owns stdin and does nothing slow: it answers `ping` at once
 * and hands every other message to the session, which only computes the frames to send; API calls go
 * out as `host_call` and are never waited on. The reporter thread polls the tap and writes `status`,
 * `page_event` and `log`. Both write frames through the stdout lock, which keeps each frame whole.
 */

mod args;
mod feed;
mod meter;
mod page;
mod protocol;
mod session;
mod status;
mod takeover;
mod tap;
#[cfg(test)]
mod test_ring;

// -- Library Imports --
use std::io;
use std::process::{self, ExitCode};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

// -- Local Imports --
use args::Config;
use feed::Epochs;
use meter::Levels;
use page::{LevelEvents, LEVELS_TOPIC};
use protocol::{
    decode, read_frame, write_message, ChildMessage, Decoded, HostMessage, LogLevel, HOST_KINDS,
    PROTOCOL_VERSION,
};
use session::{Options, Session};
use status::{Gate, TapState};
use tap::{Event, Follower, Mapping};

// How often the tap is polled. The ring holds seconds of audio, so this is far inside the overrun limit.
const POLL: Duration = Duration::from_millis(20);
// How often a status line is considered for sending; the gate holds it to one a second.
const REPORT_EVERY: Duration = Duration::from_millis(250);
// Lines per run that report discontinuities, so a seek-heavy session cannot flood the log.
const NOISY_LOG_LINES: u32 = 200;
const CRASH_EXIT_CODE: i32 = 3;

struct Shared {
    session: Mutex<Session>,
    stop: AtomicBool,
}

impl Shared {
    // A panic elsewhere never stops the plugin from answering.
    fn session(&self) -> MutexGuard<'_, Session> {
        self.session.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Writes one frame. Plisto going away ends the process, since there is nobody to talk to.
fn send(message: &ChildMessage) {
    if write_message(&mut io::stdout().lock(), message).is_err() {
        process::exit(0);
    }
}

/// Sends frames in order, echoing each log line to standard error.
fn send_all(messages: Vec<ChildMessage>) {
    for message in messages {
        if let ChildMessage::Log { level, text } = &message {
            eprintln!("tap-meter: {level:?}: {text}");
        }
        send(&message);
    }
}

fn log(level: LogLevel, text: impl Into<String>) {
    send_all(vec![session::log(level, text)]);
}

/// A cap on log lines that can repeat without bound.
struct LogBudget(u32);

impl LogBudget {
    fn log(&mut self, level: LogLevel, text: String) {
        match self.0 {
            0 => {}
            1 => log(LogLevel::Info, "further tap lines are not logged"),
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
        let stalled = stalled_until.is_some_and(|end| Instant::now() < end);
        match decode::<HostMessage>(&body, HOST_KINDS) {
            Decoded::Message(HostMessage::Ping { seq }) => {
                pings += 1;
                if let (2, Some(length)) = (pings, config.stall) {
                    stalled_until = Some(Instant::now() + length);
                    eprintln!("tap-meter: stalling for {length:?}");
                }
                // A stalled plugin stays silent; the host sees no `pong` until the stall is over.
                if stalled_until.is_none_or(|end| Instant::now() >= end) {
                    send(&ChildMessage::Pong { seq });
                }
            }
            Decoded::Message(HostMessage::Shutdown) => return,
            // A hung program answers nothing, so its page's call runs into Plisto's timeout.
            Decoded::Message(HostMessage::Call { seq, .. }) if stalled => {
                eprintln!("tap-meter: stalled, call {seq} left unanswered");
            }
            Decoded::Message(message) => {
                let hello = matches!(message, HostMessage::Hello { .. });
                let out = shared.session().handle(message);
                send_all(out);
                if hello {
                    let _ = ready.send(());
                }
            }
            Decoded::Unknown(kind) => eprintln!("tap-meter: ignored message type '{kind}'"),
            Decoded::Malformed(why) => eprintln!("tap-meter: ignored a malformed frame: {why}"),
        }
    }
}

/// Follows the tap, reports levels and feeds the page, until `shared.stop` is set.
fn report(config: &Config, shared: &Shared) {
    let mut tap: Option<(Mapping, Follower)> = None;
    let mut open_failed = false;
    let mut gate = Gate::default();
    let mut levels = Levels::default();
    let mut page_levels = Levels::default();
    let mut level_events = LevelEvents::default();
    let mut overruns = 0u64;
    let mut epochs = Epochs::default();
    let mut budget = LogBudget(NOISY_LOG_LINES);
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
                Event::Segment(s) => {
                    let (discontinuity, line) = epochs.record(&s);
                    if discontinuity {
                        levels.reset();
                        page_levels.reset();
                    }
                    budget.log(LogLevel::Info, line);
                }
                Event::Samples {
                    segment,
                    first,
                    data,
                } => {
                    levels.add(&segment, first, data);
                    page_levels.add(&segment, first, data);
                }
                Event::Overrun => {
                    overruns += 1;
                    epochs.reset();
                    levels.reset();
                    page_levels.reset();
                    budget.log(
                        LogLevel::Warn,
                        format!("overrun {overruns}: resynced to the live position"),
                    );
                }
            });
        }

        let (page_open, transport, held) = {
            let session = shared.session();
            let transport = session.transport().map(str::to_string);
            (session.page_open(), transport, session.holds_output())
        };
        let now = Instant::now();
        let step = level_events.tick(page_open, now);
        match step.changed {
            Some(true) => {
                page_levels.reset();
                log(
                    LogLevel::Info,
                    "page open: sending levels 10 times a second",
                );
            }
            Some(false) => log(LogLevel::Info, "page closed: levels stopped"),
            None => {}
        }
        if step.send {
            send(&ChildMessage::PageEvent {
                topic: LEVELS_TOPIC.into(),
                data: page::levels_data(&page_levels.take(), transport.as_deref()),
            });
        }

        if now >= next_report {
            next_report += REPORT_EVERY;
            let state = match (&config.tap, &tap) {
                (None, _) => TapState::Missing,
                (Some(_), None) => TapState::Closed,
                (Some(_), Some(_)) => TapState::Open,
            };
            let window = levels.take();
            let current = status::line(state, transport.as_deref(), &window, held);
            if let Some(line) = gate.offer(current, now) {
                send(&ChildMessage::Status {
                    state: line.state,
                    text: line.text.clone(),
                });
                let mirrored = shared.session().status_sent(&line);
                send_all(mirrored);
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

    let shared = Shared {
        session: Mutex::new(Session::new(Options {
            takeover: config.takeover,
            prompt_unprompted: config.prompt_unprompted,
        })),
        stop: AtomicBool::new(false),
    };
    let (ready_tx, ready_rx) = mpsc::channel();
    thread::scope(|scope| {
        let (config, shared) = (&config, &shared);
        let reader = thread::Builder::new()
            .name("reader".into())
            .spawn_scoped(scope, move || serve(config, shared, ready_tx))
            .expect("starts the reader thread");
        // The channel closes unanswered when the input ends before `hello`.
        if ready_rx.recv().is_ok() {
            scope.spawn(move || report(config, shared));
            if let Some(after) = config.crash_after {
                scope.spawn(move || crash_after(after, shared));
            }
        }
        let _ = reader.join();
        shared.stop.store(true, Ordering::Relaxed);
        if let Some(release) = shared.session().release_on_exit() {
            send(&release);
        }
    });
    ExitCode::SUCCESS
}
