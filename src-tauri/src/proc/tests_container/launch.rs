/*
 * The launch itself: Ready and echo in both container kinds, the time to Ready, the job, handle
 * inheritance, the profile, and the session's choice of isolation.
 */

// -- Library Imports --
use std::ffi::OsStr;
use std::io::Write;
use std::time::{Duration, Instant};

use windows::core::PCWSTR;
use windows::Win32::Foundation::{
    CloseHandle, CompareObjectHandles, DuplicateHandle, DUPLICATE_SAME_ACCESS, HANDLE,
};
use windows::Win32::Security::{EqualSid, SECURITY_ATTRIBUTES};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Module32FirstW, Module32NextW, MODULEENTRY32W, TH32CS_SNAPMODULE,
};
use windows::Win32::System::Threading::{CreateEventW, GetCurrentProcess};

// -- Local Imports --
use super::*;
use crate::proc::session::{after_launch, Fallback, Next, Outcome, Session};

// What "quickly" means for a helper reaching Ready.
const QUICK: Duration = Duration::from_secs(5);
const LAUNCHES_TIMED: usize = 20;

fn module_names(pid: u32) -> Vec<String> {
    // SAFETY: plain flags; the snapshot handle is closed below.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPMODULE, pid) }.unwrap();
    let mut entry = MODULEENTRY32W {
        dwSize: std::mem::size_of::<MODULEENTRY32W>() as u32,
        ..Default::default()
    };
    let mut names = Vec::new();
    // SAFETY: `entry` is a live struct with `dwSize` set, and the snapshot is open.
    let mut more = unsafe { Module32FirstW(snapshot, &mut entry) }.is_ok();
    while more {
        let len = entry.szModule.iter().position(|&c| c == 0).unwrap_or(0);
        names.push(String::from_utf16_lossy(&entry.szModule[..len]));
        // SAFETY: same struct and open snapshot.
        more = unsafe { Module32NextW(snapshot, &mut entry) }.is_ok();
    }
    // SAFETY: the snapshot was opened above and is closed once.
    let _ = unsafe { CloseHandle(snapshot) };
    names
}

#[test]
fn contained_helper_reaches_ready() {
    echoes_in(Isolation::LessPrivileged);
}

#[test]
fn contained_helper_reaches_ready_in_the_plain_container() {
    echoes_in(Isolation::Plain);
}

fn echoes_in(isolation: Isolation) {
    let f = fixture_in(isolation);
    let (mut helper, stdout) = ready_echo(&f);
    // An Eof frame and a Seek frame, as main would send them.
    let mut frames = vec![0x03, 0, 0, 0, 0, 0x05, 16, 0, 0, 0];
    frames.extend([7u8; 16]);
    let mut stdin = helper.process.stdin.take().unwrap();
    stdin.write_all(&frames).unwrap();
    assert_eq!(read_within(stdout, frames.len()), frames);
    drop(stdin);
    assert_eq!(helper.process.wait_timeout(WAIT).unwrap(), Some(0));
}

#[test]
fn the_helper_reaches_ready_inside_the_container_quickly() {
    let f = fixture();
    let mut times = Vec::new();
    for _ in 0..LAUNCHES_TIMED {
        let spawned = Instant::now();
        let (helper, _stdout) = ready_echo(&f);
        times.push(spawned.elapsed());
        if times.len() == 1 {
            let modules = module_names(helper.process.id());
            eprintln!(
                "decode helper: {} modules: {}",
                modules.len(),
                modules.join(", ")
            );
        }
    }
    let (fastest, slowest) = (*times.iter().min().unwrap(), *times.iter().max().unwrap());
    eprintln!(
        "decode helper: Ready {} to {} ms after spawn over {LAUNCHES_TIMED} launches",
        fastest.as_millis(),
        slowest.as_millis()
    );
    assert!(slowest < QUICK, "Ready took {slowest:?}");
}

#[test]
fn contained_helper_dies_when_its_job_closes() {
    let f = fixture();
    let (helper, _stdout) = ready_echo(&f);
    // Its stdin stays open, so the echo never ends on its own.
    let Helper { process, job } = helper;
    assert_eq!(process.wait_timeout(Duration::ZERO).unwrap(), None);
    drop(job);
    assert!(process.wait_timeout(WAIT).unwrap().is_some());
}

#[test]
fn the_helper_inherits_no_handle_but_its_pipes() {
    let f = fixture();
    let inherit = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        bInheritHandle: true.into(),
        ..Default::default()
    };
    // SAFETY: the attributes are live; the event is closed at the end of the test.
    let event = unsafe { CreateEventW(Some(&inherit), true, false, PCWSTR::null()) }.unwrap();
    let (helper, _stdout) = ready_echo(&f);
    // An inherited handle keeps its value in the child, so the value is looked up there.
    let mut copy = HANDLE::default();
    // SAFETY: the process handle carries duplicate rights, and `copy` is a live out-pointer.
    let found = unsafe {
        DuplicateHandle(
            helper.process.handle(),
            event,
            GetCurrentProcess(),
            &mut copy,
            0,
            false,
            DUPLICATE_SAME_ACCESS,
        )
    };
    if found.is_ok() {
        // SAFETY: both handles are open in this process.
        let same = unsafe { CompareObjectHandles(copy, event) }.as_bool();
        // SAFETY: the copy was just made and is closed once.
        let _ = unsafe { CloseHandle(copy) };
        assert!(!same, "the helper inherited an unlisted handle");
    }
    // SAFETY: the event was created above and is closed once.
    let _ = unsafe { CloseHandle(event) };
}

#[test]
fn profile_create_is_idempotent() {
    let f = fixture();
    let again = AppContainer::open(TEST_PROFILE).unwrap();
    // SAFETY: both SIDs live until the end of the test.
    assert!(unsafe { EqualSid(f.container.sid(), again.sid()) }.is_ok());
    container::delete(TEST_PROFILE).unwrap();
    let recreated = AppContainer::open(TEST_PROFILE).unwrap();
    // SAFETY: as above.
    assert!(unsafe { EqualSid(f.container.sid(), recreated.sid()) }.is_ok());
}

#[test]
fn a_launch_fails_once_its_profile_is_deleted() {
    for isolation in [Isolation::LessPrivileged, Isolation::Plain] {
        let f = fixture_in(isolation);
        container::delete(TEST_PROFILE).unwrap();
        let argv = [OsStr::new(DECODE_HELPER_FLAG)];
        assert!(launch(&f.container, isolation, &f.exe, &argv, HELPER_MEMORY_MAX).is_err());
    }
}

#[test]
fn a_session_heals_a_profile_deleted_under_it() {
    let f = fixture();
    let session = Session::new(TEST_PROFILE);
    let echo = [OsStr::new(DECODE_HELPER_FLAG)];
    let first = session.launch(&f.exe, &echo, HELPER_MEMORY_MAX, WAIT);
    drop(first.unwrap());
    assert_eq!(session.settled(), Some(Isolation::LessPrivileged));
    container::delete(TEST_PROFILE).unwrap();
    let second = session.launch(&f.exe, &echo, HELPER_MEMORY_MAX, WAIT);
    assert!(second.is_ok(), "{:?}", second.err());
    assert_eq!(session.settled(), Some(Isolation::LessPrivileged));
}

#[test]
fn the_fallback_decision_covers_every_case() {
    use Isolation::{LessPrivileged as Less, Plain};
    use Outcome::{Ended, Ready, TimedOut};
    let retry = |settle, reason| Next::RetryPlain { settle, reason };
    // The first launches of a session.
    assert_eq!(
        after_launch(Less, Ready, None, 0, false),
        Next::Settle(Less)
    );
    assert_eq!(
        after_launch(Less, Ended, None, 0, false),
        retry(true, Fallback::Ended)
    );
    assert_eq!(
        after_launch(Less, TimedOut, None, 0, false),
        retry(false, Fallback::TimedOut)
    );
    assert_eq!(
        after_launch(Less, TimedOut, None, 1, false),
        retry(true, Fallback::TimedOut)
    );
    // The plain retry: it settles only when the retry said so, and a failure is never retried.
    assert_eq!(
        after_launch(Plain, Ready, None, 0, true),
        Next::Settle(Plain)
    );
    assert_eq!(after_launch(Plain, Ready, None, 0, false), Next::Keep);
    assert_eq!(after_launch(Plain, Ended, None, 0, true), Next::Fail);
    assert_eq!(after_launch(Plain, TimedOut, None, 1, false), Next::Fail);
    // A settled session never switches isolation.
    for settled in [Less, Plain] {
        assert_eq!(
            after_launch(settled, Ready, Some(settled), 0, false),
            Next::Keep
        );
        assert_eq!(
            after_launch(settled, Ended, Some(settled), 0, false),
            Next::Fail
        );
        assert_eq!(
            after_launch(settled, TimedOut, Some(settled), 1, false),
            Next::Fail
        );
    }
}
