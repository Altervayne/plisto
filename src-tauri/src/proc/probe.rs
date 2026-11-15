/*
 * A debug-build switch that keeps echo helpers alive long enough to compare them in Task Manager: one
 * in its AppContainer, one with no container at all, or both at once. The uncontained helper is a
 * full-trust process, so it only ever echoes, and its job ends it with the probe.
 *
 * The `matrix` mode compares ways of getting a helper listed under the app's row: plain children, a
 * helper that sets its own AppUserModelID, and a child created with the id as its startup title.
 * Helpers outside a job end when their stdin closes, which the app's death does too.
 */

// -- Library Imports --
use std::ffi::{c_void, OsStr, OsString};
use std::fs::File;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::OwnedHandle;
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use windows::core::PCWSTR;
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::System::Threading::CREATE_NO_WINDOW;
use windows::Win32::UI::Shell::{
    GetCurrentProcessExplicitAppUserModelID, SetCurrentProcessExplicitAppUserModelID,
};

// -- Local Imports --
use super::contained::{spawn_titled, Isolation};
use super::container::{SetupError, SetupStep};
use super::helper::DECODE_HELPER_FLAG;
use super::helper_launch::{await_ready, helper_job, Helper, HELPER_MEMORY_MAX};
use super::session::DECODE_HELPER;
use super::spawn::{spawn_in_job, spawn_lock};

/// The variable that starts the probe. `uncontained`, `both` and `matrix` pick the kind; any other
/// value starts the contained helper.
const PROBE_ENV: &str = "PLISTO_DECODE_HELPER_PROBE";
const PROBE_READY_WAIT: Duration = Duration::from_secs(10);
const PROBE_HOLD: Duration = Duration::from_secs(60);
/// The extra helper argument, after the helper flag, that names the AppUserModelID the helper sets
/// on itself.
const APP_ID_ARG: &str = "--plisto-probe-appid=";

/// Which helpers a probe run starts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    Contained,
    Uncontained,
    Both,
    Matrix,
}

/// The mode `PLISTO_DECODE_HELPER_PROBE` asks for, or None when it is unset.
fn mode_from_value(value: Option<&OsStr>) -> Option<Mode> {
    Some(match value? {
        v if v == "uncontained" => Mode::Uncontained,
        v if v == "both" => Mode::Both,
        v if v == "matrix" => Mode::Matrix,
        _ => Mode::Contained,
    })
}

/// The AppUserModelID a helper is told to set on itself, from its arguments after the helper flag.
pub fn app_id_from_args(args: impl IntoIterator<Item = OsString>) -> Option<OsString> {
    args.into_iter()
        .skip(2)
        .find_map(|arg| arg.to_str()?.strip_prefix(APP_ID_ARG).map(OsString::from))
}

fn app_id_argument(id: &str) -> OsString {
    OsString::from(format!("{APP_ID_ARG}{id}"))
}

/// Sets the explicit AppUserModelID of this process.
pub fn set_app_id(id: &OsStr) -> io::Result<()> {
    let id: Vec<u16> = id.encode_wide().chain([0]).collect();
    // SAFETY: the string is NUL-terminated and outlives the call.
    unsafe { SetCurrentProcessExplicitAppUserModelID(PCWSTR(id.as_ptr())) }.map_err(io::Error::from)
}

/// The explicit AppUserModelID of this process, or None when it has none.
fn current_app_id() -> Option<String> {
    // SAFETY: on success the call hands back a NUL-terminated string from the COM allocator.
    let id = unsafe { GetCurrentProcessExplicitAppUserModelID() }.ok()?;
    // SAFETY: the string is valid until freed, once, just below.
    let text = unsafe { id.to_string() }.ok();
    // SAFETY: the buffer came from the COM allocator and is not used again.
    unsafe { CoTaskMemFree(Some(id.0 as *const c_void)) };
    text
}

/// With `PLISTO_DECODE_HELPER_PROBE` set, starts the echo helpers it names, each on its own
/// background thread, and keeps them for a minute. Each writes one line to stderr when it is up and
/// one when it ends. `app_identifier` is the AppUserModelID the matrix mode falls back to.
pub fn start_probe(app_identifier: &str) {
    let Some(mode) = mode_from_value(std::env::var_os(PROBE_ENV).as_deref()) else {
        return;
    };
    if mode == Mode::Matrix {
        let fallback = app_identifier.to_owned();
        thread::spawn(move || run_matrix(&fallback));
        return;
    }
    if mode != Mode::Uncontained {
        report_failure("contained", thread::spawn(run_contained));
    }
    if mode != Mode::Contained {
        report_failure("uncontained", thread::spawn(|| run_uncontained("uncontained")));
    }
}

type Run = Box<dyn FnOnce() -> io::Result<()> + Send>;

/// Both phases of the matrix. Phase 2 starts once every helper of phase 1 has ended.
fn run_matrix(fallback_id: &str) {
    let own = current_app_id();
    eprintln!(
        "decode helper probe: app explicit AppUserModelID: {}",
        own.as_deref().unwrap_or("none")
    );
    let id = own.clone().unwrap_or_else(|| fallback_id.to_owned());

    run_group(vec![
        ("plain", plain("plain", None)),
        ("job", Box::new(|| run_uncontained("job"))),
        ("own-appid", plain("own-appid", Some(id.clone()))),
    ]);

    eprintln!("decode helper probe: phase 2, app AppUserModelID set to {id}");
    if own.is_none() {
        if let Err(e) = set_app_id(OsStr::new(&id)) {
            eprintln!("decode helper probe: setting the app AppUserModelID: {e}");
        }
    }
    let titled = id.clone();
    run_group(vec![
        ("plain-2", plain("plain-2", None)),
        ("own-appid-2", plain("own-appid-2", Some(id))),
        ("title-appid", Box::new(move || run_titled("title-appid", &titled))),
    ]);
}

fn plain(label: &'static str, helper_id: Option<String>) -> Run {
    Box::new(move || run_plain(label, helper_id.as_deref()))
}

/// Runs every helper on a thread of its own and returns when all have ended.
fn run_group(helpers: Vec<(&'static str, Run)>) {
    let running: Vec<_> = helpers
        .into_iter()
        .map(|(label, run)| (label, thread::spawn(run)))
        .collect();
    for (label, run) in running {
        if let Ok(Err(e)) = run.join() {
            eprintln!("decode helper probe: {label}: {e}");
        }
    }
}

fn report_ready(label: &str, pid: u32, spawned: Instant) {
    eprintln!(
        "decode helper probe: {label}, pid {pid}, Ready {} ms after spawn; kept for {} s",
        spawned.elapsed().as_millis(),
        PROBE_HOLD.as_secs(),
    );
}

fn report_ended(label: &str, pid: u32, ended: &impl std::fmt::Debug) {
    eprintln!("decode helper probe: {label} helper ended, pid {pid}, exit code {ended:?}");
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

fn run_uncontained(label: &str) -> io::Result<()> {
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
    report_ready(label, child.id(), spawned);
    thread::sleep(PROBE_HOLD);
    drop((stdin, stdout));
    // The echo ends when its stdin closes; the job is the backstop.
    drop(job);
    let ended = child.wait().map(|status| status.code());
    report_ended(label, child.id(), &ended);
    Ok(())
}

/// A helper started through a bare std `Command`: no job, no container. `helper_id` is the
/// AppUserModelID the helper sets on itself. Nothing but its stdin closing ends it, which the app
/// dying does too.
fn run_plain(label: &str, helper_id: Option<&str>) -> io::Result<()> {
    let exe = std::env::current_exe()?;
    let mut command = Command::new(&exe);
    command.arg(DECODE_HELPER_FLAG);
    if let Some(id) = helper_id {
        command.arg(app_id_argument(id));
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW.0);
    let spawned = Instant::now();
    let mut child = {
        let _lock = spawn_lock();
        command.spawn()?
    };
    let pid = child.id();
    let stdin = child.stdin.take();
    let stdout = child.stdout.take().expect("a piped child has its stdout");
    let stdout = match await_ready(File::from(OwnedHandle::from(stdout)), PROBE_READY_WAIT) {
        Ok(stdout) => stdout,
        Err(e) => {
            drop(stdin);
            let _ = child.kill();
            let _ = child.wait();
            return Err(e);
        }
    };
    report_ready(label, pid, spawned);
    thread::sleep(PROBE_HOLD);
    drop((stdin, stdout));
    let ended = child.wait().map(|status| status.code());
    report_ended(label, pid, &ended);
    Ok(())
}

/// A helper started through `CreateProcessW` with `app_id` as its startup title and no job. It ends
/// the same way as a plain one.
fn run_titled(label: &str, app_id: &str) -> io::Result<()> {
    let exe = std::env::current_exe()?;
    let spawned = Instant::now();
    let mut helper = spawn_titled(
        &exe,
        &[OsStr::new(DECODE_HELPER_FLAG)],
        OsStr::new(app_id),
    )?;
    let pid = helper.id();
    let stdin = helper.stdin.take();
    let stdout = helper.stdout.take().expect("a started helper has its stdout");
    let stdout = match await_ready(stdout, PROBE_READY_WAIT) {
        Ok(stdout) => stdout,
        Err(e) => {
            // Closing its stdin ends the echo.
            drop(stdin);
            let _ = helper.wait_timeout(PROBE_READY_WAIT);
            return Err(e);
        }
    };
    report_ready(label, pid, spawned);
    thread::sleep(PROBE_HOLD);
    drop((stdin, stdout));
    let ended = helper.wait_timeout(PROBE_READY_WAIT);
    report_ended(label, pid, &ended);
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
        assert_eq!(mode("matrix"), Some(Mode::Matrix));
        assert_eq!(mode("Both"), Some(Mode::Contained));
        assert_eq!(mode("Matrix"), Some(Mode::Contained));
    }

    fn argv(args: &[&str]) -> Vec<OsString> {
        args.iter().map(OsString::from).collect()
    }

    #[test]
    fn the_app_id_argument_follows_the_helper_flag() {
        let with_id = argv(&["plisto.exe", DECODE_HELPER_FLAG, "--plisto-probe-appid=a.b.c"]);
        assert_eq!(app_id_from_args(with_id), Some(OsString::from("a.b.c")));
        assert_eq!(app_id_from_args(argv(&["plisto.exe", DECODE_HELPER_FLAG])), None);
        // Only arguments after the mode flag count.
        let early = argv(&["plisto.exe", "--plisto-probe-appid=x"]);
        assert_eq!(app_id_from_args(early), None);
        let built = [OsString::new(), OsString::new(), app_id_argument("id with space")];
        assert_eq!(app_id_from_args(built), Some(OsString::from("id with space")));
    }
}
