/*
 * The main process's side of one helper: the container setup, the job a helper runs in, the launch,
 * and the wait for its `Ready`. Which isolation a launch uses, and what a session keeps between
 * launches, is `session`'s.
 */

// -- Library Imports --
use std::ffi::OsStr;
use std::fs::File;
use std::io::{self, Read};
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

// -- Local Imports --
use super::acl::ensure_container_access;
use super::contained::{self, Contained, Isolation};
use super::container::{AppContainer, Cancelled, SetupError, SetupStep};
use super::helper::READY;
use super::job::Job;
use super::pipe;

/// The CPU one helper may use, in percent of one core.
const HELPER_CPU_PERCENT: u32 = 100;
/// How often the wait for `Ready` checks whether it was cancelled.
const CANCEL_POLL: Duration = Duration::from_millis(5);

/// A helper and the job that owns it. Dropping it closes the job, which ends the helper.
pub struct Helper {
    pub process: Contained,
    pub job: Job,
}

/// Opens the profile `name` and grants it `exe`. A cancel ends a wait on another process's setup.
pub fn prepare(name: &str, exe: &Path, cancelled: Cancelled) -> Result<AppContainer, SetupError> {
    let container =
        AppContainer::open(name, cancelled).map_err(SetupError::at(SetupStep::Profile))?;
    ensure_container_access(exe, container.sid(), cancelled)
        .map_err(SetupError::at(SetupStep::Access))?;
    Ok(container)
}

/// A job for one helper: kill on close, one process, `memory` bytes, one core at most, no UI.
pub fn helper_job(memory: usize) -> io::Result<Job> {
    let mut job = Job::new()?;
    job.set_process_memory(memory)?;
    job.set_active_processes(1)?;
    job.set_cpu_cap(HELPER_CPU_PERCENT)?;
    job.restrict_ui()?;
    Ok(job)
}

/// Starts `exe` with `args` in `container`, in a new helper job.
pub fn launch(
    container: &AppContainer,
    isolation: Isolation,
    exe: &Path,
    args: &[&OsStr],
    memory: usize,
) -> Result<Helper, SetupError> {
    let launched = helper_job(memory).and_then(|job| {
        let process = contained::spawn(exe, args, &job, container.sid(), isolation)?;
        Ok(Helper { process, job })
    });
    launched.map_err(SetupError::at(SetupStep::Launch))
}

/// Waits up to `timeout` for `Ready` on the helper's stdout, and hands the pipe back after it. The
/// pipe is read only once bytes wait in it, so the wait never outlasts the timeout, a cancel or the
/// helper's exit, and leaves no thread behind. `cancelled` is checked every `CANCEL_POLL`, and ends
/// the wait with `Interrupted`.
///
/// That the helper ended is read from `process`, never from its stdout closing alone: a concurrent
/// std spawn elsewhere in Plisto can inherit the pipe ends and hold them open.
pub fn await_ready(
    mut stdout: File,
    process: &Contained,
    timeout: Duration,
    cancelled: Cancelled,
) -> io::Result<File> {
    let deadline = Instant::now() + timeout;
    let mut first = [0u8; READY.len()];
    let mut got = 0;
    loop {
        if cancelled() {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "the launch was cancelled",
            ));
        }
        // Read before the pipe: an exit seen here means the pipe holds all the helper wrote.
        let exited = matches!(process.wait_timeout(Duration::ZERO), Ok(Some(_)));
        match pipe::waiting(&stdout) {
            Some(0) if exited => return Err(ended()),
            Some(0) => {}
            Some(waiting) => {
                let len = (waiting as usize).min(READY.len() - got);
                got += stdout.read(&mut first[got..got + len])?;
                if got == READY.len() {
                    return if first == READY {
                        Ok(stdout)
                    } else {
                        Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "the helper's first frame is not Ready",
                        ))
                    };
                }
                continue;
            }
            None => return Err(ended()),
        }
        if Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "the helper sent no Ready in time",
            ));
        }
        thread::sleep(CANCEL_POLL);
    }
}

fn ended() -> io::Error {
    io::Error::new(
        io::ErrorKind::BrokenPipe,
        "the helper ended before its Ready",
    )
}
