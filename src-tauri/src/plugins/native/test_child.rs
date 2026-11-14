/*
 * The test binary doubles as a native plugin. The host tests launch it through the real launch path,
 * with the real argv, which the test harness would refuse as unknown options. So the switch happens
 * before the harness starts: a CRT initializer looks for `--plisto-protocol`, which the harness never
 * receives, runs the behavior named in `<data dir>/test-mode`, and exits the process.
 */

// -- Library Imports --
use std::fs;
use std::io::{self, BufReader};
use std::path::{Path, PathBuf};
use std::process::{self, Command, Stdio};
use std::thread;
use std::time::Duration;

// -- Local Imports --
use super::protocol::{
    decode, read_frame, write_message, ChildMessage, Decoded, HostMessage, HOST_KINDS,
    PROTOCOL_VERSION,
};

/// The file in the data folder that names the behavior.
pub const MODE_FILE: &str = "test-mode";
const CRASH_CODE: i32 = 3;
const FLOOD_TEXT_BYTES: usize = 60_000;

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
    run(mode.trim(), &data, &args);
    process::exit(0);
}

fn send(message: &ChildMessage) {
    if write_message(&mut io::stdout().lock(), message).is_err() {
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
            HostMessage::Shutdown => return,
            _ => {}
        }
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

fn run(mode: &str, data: &Path, args: &[String]) {
    let mut input = BufReader::new(io::stdin());
    match mode {
        "echo" => {
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
            send(&ChildMessage::Status {
                state: "grandchild".into(),
                text: Some(pid.to_string()),
            });
            serve(&mut input);
        }
        "flood-stdout" => {
            next(&mut input);
            ready();
            let text = "x".repeat(FLOOD_TEXT_BYTES);
            loop {
                send(&ChildMessage::Log {
                    level: None,
                    text: text.clone(),
                });
            }
        }
        _ => sleep_forever(),
    }
}
