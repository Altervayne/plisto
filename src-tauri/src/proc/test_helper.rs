/*
 * The test binary doubles as the helper. The container tests launch it with the helper's real argv,
 * which the test harness would refuse as unknown options, so a CRT initializer catches
 * `--plisto-decode-helper` first, runs the helper mode, and exits the process. It reads argv only:
 * a mode file in a data folder would be unreadable from inside the container.
 *
 * `--plisto-decode-helper probe <name> [argument]` runs one probe instead, which tries one thing the
 * container must refuse and reports the outcome through its exit code. A panic is caught and
 * reported too: one cannot unwind out of a CRT initializer, and uncaught it would abort the process.
 */

// -- Library Imports --
use std::ffi::OsString;
use std::fs::File;
use std::io;
use std::net::{SocketAddr, TcpStream};
use std::os::windows::ffi::OsStrExt;
use std::process::{self, Command, Stdio};
use std::time::Duration;

use windows::core::PCWSTR;
use windows::Win32::Foundation::{ERROR_ACCESS_DENIED, ERROR_NOT_ENOUGH_QUOTA, ERROR_SUCCESS};
use windows::Win32::Networking::WinSock::{WSAStartup, WSADATA};
use windows::Win32::System::Registry::{
    RegCloseKey, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, KEY_READ,
};

// -- Local Imports --
use super::helper::{self, DECODE_HELPER_FLAG};

pub const PROBE: &str = "probe";
/// The probed action succeeded.
pub const ALLOWED: i32 = 10;
/// The probed action was refused with access denied.
pub const DENIED: i32 = 11;
/// The probed action failed some other way.
pub const FAILED: i32 = 12;
/// The probe panicked.
pub const PANICKED: i32 = 13;
/// `WSAStartup` failed: there is no socket stack to connect with.
pub const NO_SOCKET_STACK: i32 = 14;
/// The probe could not name its own executable.
pub const NO_EXE: i32 = 15;
/// The Winsock version std asks for.
const WINSOCK_2_2: u16 = 0x202;
const CONNECT_WAIT: Duration = Duration::from_secs(3);

#[used]
#[link_section = ".CRT$XCU"]
static HELPER_HOOK: extern "C" fn() = helper_hook;

extern "C" fn helper_hook() {
    let args: Vec<OsString> = std::env::args_os().collect();
    if !matches!(args.get(1), Some(flag) if flag == DECODE_HELPER_FLAG) {
        return;
    }
    let code = if args.get(2).is_some_and(|a| a == PROBE) {
        let name = args.get(3).and_then(|a| a.to_str()).unwrap_or_default();
        std::panic::catch_unwind(|| probe(name, args.get(4))).unwrap_or(PANICKED)
    } else {
        helper::mode_from_args(args).map_or(FAILED, helper::run)
    };
    process::exit(code);
}

fn probe(name: &str, argument: Option<&OsString>) -> i32 {
    match name {
        "open-file" => match argument {
            Some(path) => outcome(File::open(path).map(drop)),
            None => FAILED,
        },
        "connect" => match argument
            .and_then(|a| a.to_str())
            .and_then(|a| a.parse::<SocketAddr>().ok())
        {
            Some(address) => {
                if !socket_stack_starts() {
                    return NO_SOCKET_STACK;
                }
                outcome(TcpStream::connect_timeout(&address, CONNECT_WAIT).map(drop))
            }
            None => FAILED,
        },
        "registry" => {
            let Some(subkey) = argument else {
                return FAILED;
            };
            let subkey: Vec<u16> = subkey.encode_wide().chain([0]).collect();
            let mut key = HKEY::default();
            // SAFETY: a NUL-terminated name and a live out-pointer; an opened key is closed at once.
            let opened = unsafe {
                RegOpenKeyExW(
                    HKEY_CURRENT_USER,
                    PCWSTR(subkey.as_ptr()),
                    0,
                    KEY_READ,
                    &mut key,
                )
            };
            if opened == ERROR_SUCCESS {
                // SAFETY: the key was just opened and is closed once.
                let _ = unsafe { RegCloseKey(key) };
                ALLOWED
            } else if opened == ERROR_ACCESS_DENIED {
                DENIED
            } else {
                FAILED
            }
        }
        "spawn" => {
            let Ok(exe) = std::env::current_exe() else {
                return NO_EXE;
            };
            let started = Command::new(exe)
                .arg(DECODE_HELPER_FLAG)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn();
            match started {
                Ok(mut child) => {
                    let _ = child.kill();
                    ALLOWED
                }
                // The job's one-process limit refuses the creation with this error.
                Err(e) if e.raw_os_error() == Some(ERROR_NOT_ENOUGH_QUOTA.0 as i32) => DENIED,
                Err(_) => FAILED,
            }
        }
        _ => FAILED,
    }
}

/// Starts Winsock the way std does on its first socket call. The started stack stays for that call.
fn socket_stack_starts() -> bool {
    let mut data = WSADATA::default();
    // SAFETY: `data` is a live, writable WSADATA.
    unsafe { WSAStartup(WINSOCK_2_2, &mut data) == 0 }
}

fn outcome(result: io::Result<()>) -> i32 {
    match result {
        Ok(()) => ALLOWED,
        Err(e) if e.kind() == io::ErrorKind::PermissionDenied => DENIED,
        Err(_) => FAILED,
    }
}
