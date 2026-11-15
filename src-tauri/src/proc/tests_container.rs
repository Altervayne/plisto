/*
 * Tests that prove the AppContainer launch. The helper is the test binary itself, caught by the
 * `test_helper` hook, launched in its own test profile after the binary is granted to it. The tests
 * share one profile, so they run one at a time; each removes the grant and deletes the profile when
 * it ends. Every wait is bounded: a helper that never answers fails its test, it does not hang it.
 */

// -- Library Imports --
use std::ffi::OsStr;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::Duration;

use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Security::Authorization::REVOKE_ACCESS;
use windows::Win32::Security::{GetTokenInformation, TOKEN_INFORMATION_CLASS, TOKEN_QUERY};
use windows::Win32::System::Threading::OpenProcessToken;

// -- Local Imports --
use super::acl::set_entry;
use super::contained::Isolation;
use super::container::{self, AppContainer, NEVER};
use super::helper::{DECODE_HELPER_FLAG, ECHO};
use super::helper_launch::{await_ready, launch, prepare, Helper};
use super::test_helper::PROBE;
use crate::audio::stream::HELPER_MEMORY_MAX;

// -- Module Declarations --
mod access;
mod launch;
mod walls;

const TEST_PROFILE: &str = "Plisto.DecodeHelper.Tests";
// Upper bound for a helper to answer or to end.
const WAIT: Duration = Duration::from_secs(10);

static CONTAINER_TESTS: Mutex<()> = Mutex::new(());

/// The test profile, set up with the test binary granted to it. Dropping it removes the grant and
/// deletes the profile.
struct Fixture {
    container: AppContainer,
    isolation: Isolation,
    exe: PathBuf,
    _serial: MutexGuard<'static, ()>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = set_entry(&self.exe, self.container.sid(), REVOKE_ACCESS);
        let _ = container::delete(TEST_PROFILE);
    }
}

/// The fixture for the decode helper's default isolation.
fn fixture() -> Fixture {
    fixture_in(Isolation::LessPrivileged)
}

fn fixture_in(isolation: Isolation) -> Fixture {
    let serial = CONTAINER_TESTS
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    let exe = std::env::current_exe().unwrap();
    target_dir(&exe);
    let container = prepare(TEST_PROFILE, &exe, NEVER).unwrap();
    Fixture {
        container,
        isolation,
        exe,
        _serial: serial,
    }
}

/// The build's `target` folder above the test binary. Panics when there is none, so no test grants
/// anything outside it.
fn target_dir(exe: &Path) -> PathBuf {
    exe.ancestors()
        .find(|dir| dir.file_name() == Some(OsStr::new("target")))
        .expect("the test binary runs from a target folder")
        .to_path_buf()
}

/// A file, or a folder with everything in it, removed when dropped, failed test or not.
struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = if self.0.is_dir() {
            fs::remove_dir_all(&self.0)
        } else {
            fs::remove_file(&self.0)
        };
    }
}

fn start(f: &Fixture, args: &[&OsStr]) -> Helper {
    let mut argv = vec![OsStr::new(DECODE_HELPER_FLAG)];
    argv.extend_from_slice(args);
    launch(&f.container, f.isolation, &f.exe, &argv, HELPER_MEMORY_MAX).unwrap()
}

/// Runs one probe in the container and returns its exit code.
fn probe(f: &Fixture, name: &str, argument: Option<&OsStr>) -> i32 {
    let mut args = vec![OsStr::new(PROBE), OsStr::new(name)];
    args.extend(argument);
    let helper = start(f, &args);
    helper
        .process
        .wait_timeout(WAIT)
        .unwrap()
        .expect("the probe never ended") as i32
}

/// Starts the echo helper and waits for its Ready.
fn ready_echo(f: &Fixture) -> (Helper, fs::File) {
    let mut helper = start(f, &[OsStr::new(ECHO)]);
    let stdout = helper.process.stdout.take().unwrap();
    let stdout = await_ready(stdout, WAIT, &|| false).unwrap();
    (helper, stdout)
}

/// Reads exactly `len` bytes within `WAIT`.
fn read_within(mut from: fs::File, len: usize) -> Vec<u8> {
    let (sent, received) = mpsc::channel();
    thread::spawn(move || {
        let mut bytes = vec![0u8; len];
        let _ = sent.send(from.read_exact(&mut bytes).map(|()| bytes));
    });
    received
        .recv_timeout(WAIT)
        .expect("the helper never echoed")
        .unwrap()
}

/// Reads one token information class of a process, in a buffer aligned for any token structure.
fn token_info<T>(process: HANDLE, class: TOKEN_INFORMATION_CLASS) -> Vec<u64> {
    let mut token = HANDLE::default();
    // SAFETY: the process handle is open and `token` is a live out-pointer.
    unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) }.unwrap();
    let mut needed = 0u32;
    // SAFETY: a size query with no buffer.
    let _ = unsafe { GetTokenInformation(token, class, None, 0, &mut needed) };
    let bytes = (needed as usize).max(std::mem::size_of::<T>());
    let mut buffer = vec![0u64; bytes.div_ceil(8)];
    // SAFETY: the buffer holds at least `bytes` bytes; the token is closed after.
    let read = unsafe {
        GetTokenInformation(
            token,
            class,
            Some(buffer.as_mut_ptr().cast()),
            bytes as u32,
            &mut needed,
        )
    };
    // SAFETY: the token was opened above and is closed once.
    let _ = unsafe { CloseHandle(token) };
    read.unwrap();
    buffer
}
