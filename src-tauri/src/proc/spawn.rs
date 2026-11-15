/*
 * Starts a child inside a job. The process is created suspended, put in the job, and only then
 * resumed, so not one instruction of it runs outside the job.
 * A child created through std inherits every inheritable handle in Plisto. A launcher that marks a
 * handle inheritable for its own child holds the spawn lock until the handle is no longer
 * inheritable, and every spawn here takes the same lock, so no child picks up another's handles.
 */

// -- Library Imports --
use std::io;
use std::os::windows::process::CommandExt;
use std::process::{self, Command};
use std::sync::{Mutex, MutexGuard, PoisonError};

use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
};
use windows::Win32::System::Threading::{
    OpenThread, ResumeThread, CREATE_NO_WINDOW, CREATE_SUSPENDED, THREAD_SUSPEND_RESUME,
};

// -- Local Imports --
use super::job::Job;

static SPAWN_LOCK: Mutex<()> = Mutex::new(());

/// Holds the process-wide spawn lock until the guard drops.
pub fn spawn_lock() -> MutexGuard<'static, ()> {
    // The lock guards no data, so a panic while it was held leaves nothing to repair.
    SPAWN_LOCK.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Starts `command` inside `job`, with no console window. Its creation flags are replaced. On any
/// error nothing is left running.
pub fn spawn_in_job(command: &mut Command, job: &Job) -> io::Result<process::Child> {
    let spawned = {
        let _lock = spawn_lock();
        command
            .creation_flags((CREATE_NO_WINDOW | CREATE_SUSPENDED).0)
            .spawn()
    };
    let mut child = spawned?;
    if let Err(e) = job.assign(&child).and_then(|()| resume(child.id())) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(e);
    }
    Ok(child)
}

/// Closes a handle when dropped.
struct Owned(HANDLE);

impl Drop for Owned {
    fn drop(&mut self) {
        // Safety: the handle is owned by this wrapper and closed exactly once, here.
        let _ = unsafe { CloseHandle(self.0) };
    }
}

/// Resumes the threads of a process created suspended. Std keeps no handle to the main thread, so
/// the process's threads are found through a thread snapshot.
fn resume(pid: u32) -> io::Result<()> {
    // Safety: plain flags; the returned handle is owned by `Owned` at once.
    let snapshot =
        Owned(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) }.map_err(io::Error::from)?);
    let mut entry = THREADENTRY32 {
        dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
        ..Default::default()
    };
    let mut resumed = 0;
    // Safety: `entry` is a live struct with `dwSize` set, and the snapshot handle is open.
    let mut more = unsafe { Thread32First(snapshot.0, &mut entry) }.is_ok();
    while more {
        if entry.th32OwnerProcessID == pid {
            let thread = Owned(
                // Safety: plain arguments; the returned handle is owned by `Owned` at once.
                unsafe { OpenThread(THREAD_SUSPEND_RESUME, false, entry.th32ThreadID) }
                    .map_err(io::Error::from)?,
            );
            // Safety: the thread handle is open and was opened with resume rights.
            if unsafe { ResumeThread(thread.0) } == u32::MAX {
                return Err(io::Error::last_os_error());
            }
            resumed += 1;
        }
        // Safety: same struct and open snapshot as `Thread32First`.
        more = unsafe { Thread32Next(snapshot.0, &mut entry) }.is_ok();
    }
    if resumed == 0 {
        return Err(io::Error::other("the new process has no thread to resume"));
    }
    Ok(())
}
