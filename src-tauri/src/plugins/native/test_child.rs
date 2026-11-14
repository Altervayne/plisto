/*
 * The test binary doubles as a native plugin. The host tests launch it through the real launch path,
 * with the real argv, which the test harness would refuse as unknown options. So the switch happens
 * before the harness starts: a CRT initializer looks for `--plisto-protocol`, which the harness never
 * receives, runs the behavior named in `<data dir>/test-mode`, and exits the process.
 */

// -- Library Imports --
use std::fs;
use std::io::{self, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{self, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::json;

// -- Local Imports --
use super::protocol::{
    decode, read_frame, write_message, ChildMessage, Decoded, HostMessage, LogLevel,
    ReportedState, HOST_KINDS, PROTOCOL_VERSION,
};

/// The file in the data folder that names the behavior, optionally followed by `:<number>` for the
/// modes that take one.
pub const MODE_FILE: &str = "test-mode";
/// The file in the data folder where `echo` notes each launch.
pub const LAUNCHES_FILE: &str = "launches";
/// The file in the data folder whose presence ends a `stall-until-file` stall.
pub const RESUME_FILE: &str = "resume";
const CRASH_CODE: i32 = 3;
const FLOOD_TEXT_BYTES: usize = 60_000;
const DEFAULT_PAGE_EVENTS_PER_SEC: u64 = 50;
const DEFAULT_STALL_MS: u64 = 3_000;

#[used]
#[link_section = ".CRT$XCU"]
static CHILD_HOOK: extern "C" fn() = child_hook;

extern "C" fn child_hook() {
    let args: Vec<String> = std::env::args().collect();
    if !args.iter().any(|a| a == "--plisto-protocol") {
        return;
    }
    let data = args
        .iter()
        .position(|a| a == "--plisto-data")
        .and_then(|at| args.get(at + 1))
        .map(PathBuf::from)
        .unwrap_or_default();
    let mode = fs::read_to_string(data.join(MODE_FILE)).unwrap_or_default();
    let (mode, param) = match mode.trim().split_once(':') {
        Some((mode, param)) => (mode, param.parse().ok()),
        None => (mode.trim(), None),
    };
    run(mode, param, &data, &args);
    process::exit(0);
}

fn send(message: &ChildMessage) {
    if write_message(&mut io::stdout().lock(), message).is_err() {
        process::exit(0);
    }
}

/// Writes a frame whose body is not a message the codec would produce.
fn send_raw(json: &str) {
    let mut out = io::stdout().lock();
    if write!(out, "{}\n{json}\n", json.len())
        .and_then(|()| out.flush())
        .is_err()
    {
        process::exit(0);
    }
}

fn next(input: &mut BufReader<io::Stdin>) -> Option<HostMessage> {
    loop {
        match read_frame(input) {
            Ok(Some(body)) => match decode::<HostMessage>(&body, HOST_KINDS) {
                Decoded::Message(m) => return Some(m),
                _ => continue,
            },
            _ => return None,
        }
    }
}

fn sleep_forever() -> ! {
    loop {
        thread::sleep(Duration::from_secs(3600));
    }
}

fn ready() {
    send(&ChildMessage::Ready {
        protocol: PROTOCOL_VERSION,
    });
}

/// Answers pings and calls until `shutdown` or the end of input.
fn serve(input: &mut BufReader<io::Stdin>) {
    while let Some(message) = next(input) {
        match message {
            HostMessage::Ping { seq } => send(&ChildMessage::Pong { seq }),
            HostMessage::Call { seq, args, .. } => send(&ChildMessage::Result {
                seq,
                ok: true,
                result: Some(args),
                error: None,
            }),
            HostMessage::HostResult { .. } => log_host_result(&message),
            HostMessage::Shutdown => return,
            _ => {}
        }
    }
}

/// The host's answer to a `host_call`, written to the stderr log for the test to read.
fn log_host_result(message: &HostMessage) {
    eprintln!(
        "host_result={}",
        serde_json::to_string(message).unwrap_or_default()
    );
}

/// Like `serve`, but ignores pings for `stall` after the first one, then answers them again.
fn serve_stalling(input: &mut BufReader<io::Stdin>, stall: Duration) {
    let mut first_ping = None;
    while let Some(message) = next(input) {
        match message {
            HostMessage::Ping { seq } => {
                let since = *first_ping.get_or_insert_with(Instant::now);
                if since.elapsed() >= stall {
                    send(&ChildMessage::Pong { seq });
                }
            }
            HostMessage::Shutdown => return,
            _ => {}
        }
    }
}

/// Adds a line to `LAUNCHES_FILE`, so a test can count how many times the plugin was launched.
fn note_launch(data: &Path) {
    let launches = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(data.join(LAUNCHES_FILE));
    if let Ok(mut file) = launches {
        let _ = writeln!(file, "launch");
    }
}

/// Like `serve`, but ignores pings until `resume` exists.
fn serve_until_resumed(input: &mut BufReader<io::Stdin>, resume: &Path) {
    while let Some(message) = next(input) {
        match message {
            HostMessage::Ping { seq } if resume.exists() => send(&ChildMessage::Pong { seq }),
            HostMessage::Shutdown => return,
            _ => {}
        }
    }
}

/// Starts a sleeping process that shares this one's stdout, so the output stays open after it exits.
fn spawn_helper_on_stdout(data: &Path) {
    let dir = data.join("helper");
    let _ = fs::create_dir_all(&dir);
    let _ = fs::write(dir.join(MODE_FILE), "sleep");
    let exe = std::env::current_exe().unwrap_or_default();
    let spawned = Command::new(exe)
        .args(["--plisto-protocol", "1", "--plisto-data"])
        .arg(&dir)
        .args(["--plisto-tap", "none"])
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .spawn();
    if spawned.is_err() {
        process::exit(CRASH_CODE);
    }
}

fn spawn_grandchild(data: &Path) -> u32 {
    let dir = data.join("grandchild");
    let _ = fs::create_dir_all(&dir);
    let _ = fs::write(dir.join(MODE_FILE), "sleep");
    let exe = std::env::current_exe().unwrap_or_default();
    match Command::new(exe)
        .args(["--plisto-protocol", "1", "--plisto-data"])
        .arg(&dir)
        .args(["--plisto-tap", "none"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .spawn()
    {
        Ok(child) => child.id(),
        Err(_) => process::exit(CRASH_CODE),
    }
}

fn run(mode: &str, param: Option<u64>, data: &Path, args: &[String]) {
    let mut input = BufReader::new(io::stdin());
    match mode {
        "echo" => {
            note_launch(data);
            let cwd = std::env::current_dir().unwrap_or_default();
            let webview2 = std::env::var("WEBVIEW2_USER_DATA_FOLDER").unwrap_or_default();
            eprintln!("args={:?}", &args[1..]);
            eprintln!("cwd={}", cwd.display());
            eprintln!("webview2={webview2}");
            if !matches!(next(&mut input), Some(HostMessage::Hello { .. })) {
                process::exit(CRASH_CODE);
            }
            ready();
            serve(&mut input);
        }
        "crash" => {
            next(&mut input);
            process::exit(CRASH_CODE);
        }
        "hang" => {
            next(&mut input);
            sleep_forever();
        }
        "ignore-stdin" => {
            ready();
            sleep_forever();
        }
        "spawn-grandchild" => {
            next(&mut input);
            let pid = spawn_grandchild(data);
            ready();
            send(&ChildMessage::Log {
                level: LogLevel::Info,
                text: format!("grandchild={pid}"),
            });
            serve(&mut input);
        }
        "flood-stdout" => {
            next(&mut input);
            ready();
            let text = "x".repeat(FLOOD_TEXT_BYTES);
            loop {
                send(&ChildMessage::Log {
                    level: LogLevel::Info,
                    text: text.clone(),
                });
            }
        }
        "status-flood" => {
            next(&mut input);
            ready();
            let mut on = true;
            loop {
                let state = if on {
                    ReportedState::On
                } else {
                    ReportedState::Warn
                };
                send(&ChildMessage::Status { state, text: None });
                on = !on;
            }
        }
        "bad-status" => {
            next(&mut input);
            ready();
            send_raw(r#"{"type":"status","state":"bogus"}"#);
            let long = "x".repeat(61);
            send_raw(&format!(r#"{{"type":"status","state":"on","text":"{long}"}}"#));
            send_raw(r#"{"type":"status","state":"on","text":"bell\u0007"}"#);
            send(&ChildMessage::Status {
                state: ReportedState::Idle,
                text: Some("fine".into()),
            });
            serve(&mut input);
        }
        "host-call" => {
            next(&mut input);
            ready();
            send(&ChildMessage::HostCall {
                seq: 1,
                method: "library.stats".into(),
                args: json!({}),
            });
            serve(&mut input);
        }
        "page-events" => {
            next(&mut input);
            ready();
            let rate = param.unwrap_or(DEFAULT_PAGE_EVENTS_PER_SEC).max(1);
            let gap = Duration::from_millis(1000 / rate);
            let mut n = 0u64;
            loop {
                send(&ChildMessage::PageEvent {
                    topic: "levels".into(),
                    data: json!({ "n": n }),
                });
                thread::sleep(gap);
                n += 1;
            }
        }
        "takeover" => {
            next(&mut input);
            ready();
            send(&ChildMessage::Takeover { hold: true });
            serve(&mut input);
        }
        "stall-pongs" => {
            next(&mut input);
            ready();
            serve_stalling(&mut input, Duration::from_millis(param.unwrap_or(DEFAULT_STALL_MS)));
        }
        "stall-until-file" => {
            next(&mut input);
            ready();
            serve_until_resumed(&mut input, &data.join(RESUME_FILE));
        }
        "exit-leaving-helper" => {
            next(&mut input);
            ready();
            spawn_helper_on_stdout(data);
            process::exit(CRASH_CODE);
        }
        "broken-frame" => {
            next(&mut input);
            ready();
            thread::sleep(Duration::from_millis(param.unwrap_or(0)));
            let mut out = io::stdout().lock();
            let _ = out.write_all(b"abc\n").and_then(|()| out.flush());
            drop(out);
            sleep_forever();
        }
        _ => sleep_forever(),
    }
}
