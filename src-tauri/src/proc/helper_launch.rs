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
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

// -- Local Imports --
use super::acl::ensure_container_access;
use super::contained::{self, Contained, Isolation};
use super::container::{AppContainer, SetupError, SetupStep};
use super::helper::READY;
use super::job::Job;

/// The memory one helper process may commit.
pub const HELPER_MEMORY_MAX: usize = 256 * 1024 * 1024;
/// The CPU one helper may use, in percent of one core.
const HELPER_CPU_PERCENT: u32 = 100;

/// A helper and the job that owns it. Dropping it closes the job, which ends the helper.
pub struct Helper {
    pub process: Contained,
    pub job: Job,
}

/// Opens the profile `name` and grants it `exe`.
pub fn prepare(name: &str, exe: &Path) -> Result<AppContainer, SetupError> {
    let container = AppContainer::open(name).map_err(SetupError::at(SetupStep::Profile))?;
    ensure_container_access(exe, container.sid()).map_err(SetupError::at(SetupStep::Access))?;
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
/// read runs on its own thread, so a helper that never answers costs the timeout and no more; that
/// thread ends when the pipe breaks.
///
/// Tell that a helper ended from `Contained::wait_timeout`, never from its stdout closing: a
/// concurrent std spawn elsewhere in Plisto can inherit the pipe ends and hold them open.
pub fn await_ready(stdout: File, timeout: Duration) -> io::Result<File> {
    let (sent, received) = mpsc::channel();
    thread::spawn(move || {
        let mut stdout = stdout;
        let mut first = [0u8; READY.len()];
        let read = stdout.read_exact(&mut first).and_then(|()| {
            if first == READY {
                Ok(())
            } else {
                Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "the helper's first frame is not Ready",
                ))
            }
        });
        let _ = sent.send(read.map(|()| stdout));
    });
    received.recv_timeout(timeout).unwrap_or_else(|_| {
        Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "the helper sent no Ready in time",
        ))
    })
}

#[cfg(debug_assertions)]
pub use probe::start_probe;

/// A debug-build switch that keeps one echo helper alive long enough to look at it in Task Manager.
#[cfg(debug_assertions)]
mod probe {
    use std::time::Instant;

    use super::*;
    use crate::proc::helper::DECODE_HELPER_FLAG;
    use crate::proc::session::DECODE_HELPER;

    /// Set to any value to start the probe.
    const PROBE_ENV: &str = "PLISTO_DECODE_HELPER_PROBE";
    const PROBE_READY_WAIT: Duration = Duration::from_secs(10);
    const PROBE_HOLD: Duration = Duration::from_secs(60);

    /// With `PLISTO_DECODE_HELPER_PROBE` set, starts one echo helper on a background thread, writes
    /// the setup time and the time from spawn to `Ready` to stderr, and keeps the helper for a minute.
    pub fn start_probe() {
        if std::env::var_os(PROBE_ENV).is_none() {
            return;
        }
        thread::spawn(|| {
            if let Err(e) = run() {
                eprintln!("decode helper probe: {e}");
            }
        });
    }

    fn run() -> Result<(), SetupError> {
        let exe = std::env::current_exe().map_err(SetupError::at(SetupStep::Launch))?;
        let setup = Instant::now();
        DECODE_HELPER.container(&exe)?;
        let setup = setup.elapsed();
        let spawned = Instant::now();
        let (mut helper, stdout) = DECODE_HELPER.launch(
            &exe,
            &[OsStr::new(DECODE_HELPER_FLAG)],
            HELPER_MEMORY_MAX,
            PROBE_READY_WAIT,
        )?;
        eprintln!(
            "decode helper probe: pid {}, container setup {} ms, Ready {} ms after spawn; kept for {} s",
            helper.process.id(),
            setup.as_millis(),
            spawned.elapsed().as_millis(),
            PROBE_HOLD.as_secs(),
        );
        thread::sleep(PROBE_HOLD);
        // Closing its stdin ends the echo on its own; the job is the backstop.
        drop((helper.process.stdin.take(), stdout));
        let Helper { process, job } = helper;
        let ended = process.wait_timeout(PROBE_READY_WAIT);
        drop(job);
        eprintln!("decode helper probe: helper ended, exit code {ended:?}");
        Ok(())
    }
}
