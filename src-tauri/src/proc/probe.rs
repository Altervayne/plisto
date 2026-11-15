/*
 * A debug-build switch that keeps echo helpers alive long enough to compare them in Task Manager: one
 * in its AppContainer, one with no container at all, or both at once. The uncontained helper is a
 * full-trust process, so it only ever echoes, and its job ends it with the probe.
 */

// -- Library Imports --
use std::ffi::OsStr;
use std::fs::File;
use std::io;
use std::os::windows::io::OwnedHandle;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

// -- Local Imports --
use super::contained::Isolation;
use super::container::{SetupError, SetupStep};
use super::helper::DECODE_HELPER_FLAG;
use super::helper_launch::{await_ready, helper_job, Helper, HELPER_MEMORY_MAX};
use super::session::DECODE_HELPER;
use super::spawn::spawn_in_job;

/// The variable that starts the probe. `uncontained` and `both` pick the kind; any other value starts
/// the contained helper.
const PROBE_ENV: &str = "PLISTO_DECODE_HELPER_PROBE";
const PROBE_READY_WAIT: Duration = Duration::from_secs(10);
const PROBE_HOLD: Duration = Duration::from_secs(60);

/// Which helpers a probe run starts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    Contained,
    Uncontained,
    Both,
}

/// The mode `PLISTO_DECODE_HELPER_PROBE` asks for, or None when it is unset.
fn mode_from_value(value: Option<&OsStr>) -> Option<Mode> {
    Some(match value? {
        v if v == "uncontained" => Mode::Uncontained,
        v if v == "both" => Mode::Both,
        _ => Mode::Contained,
    })
}

/// With `PLISTO_DECODE_HELPER_PROBE` set, starts the echo helpers it names, each on its own
/// background thread, and keeps them for a minute. Each writes one line to stderr when it is up and
/// one when it ends.
pub fn start_probe() {
    let Some(mode) = mode_from_value(std::env::var_os(PROBE_ENV).as_deref()) else {
        return;
    };
    if mode != Mode::Uncontained {
        report_failure("contained", thread::spawn(run_contained));
    }
    if mode != Mode::Contained {
        report_failure("uncontained", thread::spawn(run_uncontained));
    }
}

/// Writes the error of a probe thread that fails, from a thread of its own.
fn report_failure<E: std::fmt::Display + Send + 'static>(
    kind: &'static str,
    run: thread::JoinHandle<Result<(), E>>,
) {
    thread::spawn(move || {
        if let Ok(Err(e)) = run.join() {
            eprintln!("decode helper probe: {kind}: {e}");
        }
    });
}

fn run_contained() -> Result<(), SetupError> {
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
    let isolation = match DECODE_HELPER.settled() {
        Some(Isolation::LessPrivileged) => "less privileged",
        Some(Isolation::Plain) => "plain",
        None => "not settled",
    };
    eprintln!(
        "decode helper probe: contained, pid {}, Ready {} ms after spawn (container setup {} ms, {isolation}); kept for {} s",
        helper.process.id(),
        spawned.elapsed().as_millis(),
        setup.as_millis(),
        PROBE_HOLD.as_secs(),
    );
    thread::sleep(PROBE_HOLD);
    // Closing its stdin ends the echo on its own; the job is the backstop.
    drop((helper.process.stdin.take(), stdout));
    let Helper { process, job } = helper;
    let ended = process.wait_timeout(PROBE_READY_WAIT);
    drop(job);
    eprintln!("decode helper probe: contained helper ended, exit code {ended:?}");
    Ok(())
}

fn run_uncontained() -> io::Result<()> {
    let exe = std::env::current_exe()?;
    let job = helper_job(HELPER_MEMORY_MAX)?;
    let mut command = Command::new(&exe);
    command
        .arg(DECODE_HELPER_FLAG)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let spawned = Instant::now();
    let mut child = spawn_in_job(&mut command, &job)?;
    let stdin = child.stdin.take();
    let stdout = child.stdout.take().expect("a piped child has its stdout");
    let stdout = match await_ready(File::from(OwnedHandle::from(stdout)), PROBE_READY_WAIT) {
        Ok(stdout) => stdout,
        Err(e) => {
            // Closing the job ends the child.
            drop(job);
            let _ = child.wait();
            return Err(e);
        }
    };
    eprintln!(
        "decode helper probe: uncontained, pid {}, Ready {} ms after spawn; kept for {} s",
        child.id(),
        spawned.elapsed().as_millis(),
        PROBE_HOLD.as_secs(),
    );
    thread::sleep(PROBE_HOLD);
    drop((stdin, stdout));
    // The echo ends when its stdin closes; the job is the backstop.
    drop(job);
    let ended = child.wait().map(|status| status.code());
    eprintln!("decode helper probe: uncontained helper ended, exit code {ended:?}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;

    use super::*;

    fn mode(value: &str) -> Option<Mode> {
        mode_from_value(Some(&OsString::from(value)))
    }

    #[test]
    fn the_probe_value_picks_the_helpers() {
        assert_eq!(mode_from_value(None), None);
        assert_eq!(mode("1"), Some(Mode::Contained));
        assert_eq!(mode(""), Some(Mode::Contained));
        assert_eq!(mode("uncontained"), Some(Mode::Uncontained));
        assert_eq!(mode("both"), Some(Mode::Both));
        assert_eq!(mode("Both"), Some(Mode::Contained));
    }
}
