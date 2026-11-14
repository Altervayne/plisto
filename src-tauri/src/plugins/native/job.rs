/*
 * A Job Object that owns one native plugin's process tree. It is created with kill-on-close, so the
 * moment its only handle closes (Plisto drops it, exits, or is killed) every process in it dies,
 * including anything the plugin started. Breakaway is not allowed, so a grandchild cannot leave it.
 */

// -- Library Imports --
use std::io;
use std::os::windows::io::AsRawHandle;
use std::process;

use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

/// Exit code given to processes the job terminates.
const KILLED_EXIT_CODE: u32 = 1;

pub struct Job(HANDLE);

// A job handle is a process-wide kernel handle, usable from any thread.
unsafe impl Send for Job {}
unsafe impl Sync for Job {}

impl Job {
    /// A new, unnamed, non-inheritable job with kill-on-close. A crash inside it ends the process
    /// instead of raising an error dialog no one can see.
    pub fn new() -> io::Result<Job> {
        // Safety: no attributes and no name; the returned handle is owned by the Job made next.
        let handle = unsafe { CreateJobObjectW(None, PCWSTR::null()) }.map_err(io::Error::from)?;
        let job = Job(handle);
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
        // Safety: `info` is a live, fully initialized struct and the size passed is its own.
        unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        }
        .map_err(io::Error::from)?;
        Ok(job)
    }

    pub fn assign(&self, process: &process::Child) -> io::Result<()> {
        let handle = HANDLE(process.as_raw_handle());
        // Safety: `info` is a live, fully initialized struct and the size passed is its own.
        unsafe { AssignProcessToJobObject(self.0, handle) }.map_err(io::Error::from)
    }

    /// Kills every process in the job. The job stays usable and empty.
    pub fn terminate(&self) -> io::Result<()> {
        // Safety: `info` is a live, fully initialized struct and the size passed is its own.
        unsafe { TerminateJobObject(self.0, KILLED_EXIT_CODE) }.map_err(io::Error::from)
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        // Safety: the handle is owned by this Job and closed exactly once, here.
        let _ = unsafe { CloseHandle(self.0) };
    }
}
