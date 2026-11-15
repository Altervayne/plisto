/*
 * Tests for the job and the spawn. Every limit is read back from Windows rather than trusted. A child
 * is the test binary itself, run as the native plugin test child: the mode named in the `test-mode`
 * file of its data folder, or a sleep when there is none, until its job kills it.
 */

// -- Library Imports --
use std::fs;
use std::num::NonZeroU32;
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use std::process::{self, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use windows::Win32::Foundation::{HANDLE, WAIT_OBJECT_0};
use windows::Win32::System::JobObjects::{
    JOBOBJECT_BASIC_UI_RESTRICTIONS, JOBOBJECT_CPU_RATE_CONTROL_INFORMATION,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_CPU_RATE_CONTROL_ENABLE,
    JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP, JOB_OBJECT_LIMIT, JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
    JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOB_OBJECT_LIMIT_PROCESS_MEMORY, JOB_OBJECT_UILIMIT, JOB_OBJECT_UILIMIT_NONE,
};
use windows::Win32::System::Threading::{
    GetActiveProcessorCount, GetExitCodeProcess, WaitForSingleObject, ALL_PROCESSOR_GROUPS,
};

// -- Local Imports --
use super::job::{cpu_rate, Job};
use super::spawn::{spawn_in_job, spawn_lock};

// Upper bound for a child to start or to end.
const SLOW: Duration = Duration::from_secs(60);
// How long a spawn behind a held lock is watched for not finishing.
const HELD: Duration = Duration::from_millis(300);
const POLL: Duration = Duration::from_millis(10);
// CPU time a busy child is left to build up before it is compared with the wall clock.
const BUSY: Duration = Duration::from_millis(200);
const DEFAULTS: JOB_OBJECT_LIMIT = JOB_OBJECT_LIMIT(
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.0 | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION.0,
);
const MIB: usize = 1024 * 1024;
const GIB: usize = 1024 * MIB;

fn limits(job: &Job) -> JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    job.query().unwrap()
}

fn n(count: u32) -> NonZeroU32 {
    NonZeroU32::new(count).unwrap()
}

fn data_dir(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("plisto-proc-test-{}-{name}", process::id()))
}

/// The test binary as a child that runs the mode named in `data`, or sleeps when there is none.
fn test_child(data: &Path) -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args(["--plisto-protocol", "1", "--plisto-data"])
        .arg(data)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

fn sleeper() -> Command {
    test_child(&data_dir("none"))
}

/// The child's exit code once it has exited within `timeout`.
fn exit_within(child: &process::Child, timeout: Duration) -> Option<u32> {
    let handle = HANDLE(child.as_raw_handle());
    // Safety: the process handle stays open while `child` lives.
    if unsafe { WaitForSingleObject(handle, timeout.as_millis() as u32) } != WAIT_OBJECT_0 {
        return None;
    }
    let mut code = 0u32;
    // Safety: same open handle, and `code` is a live u32.
    unsafe { GetExitCodeProcess(handle, &mut code) }.ok()?;
    Some(code)
}

#[test]
fn a_new_job_has_only_kill_on_close_and_die_on_exception() {
    let job = Job::new().unwrap();
    assert_eq!(limits(&job).BasicLimitInformation.LimitFlags, DEFAULTS);
    let ui: JOBOBJECT_BASIC_UI_RESTRICTIONS = job.query().unwrap();
    assert_eq!(ui.UIRestrictionsClass, JOB_OBJECT_UILIMIT_NONE);
    let cpu: JOBOBJECT_CPU_RATE_CONTROL_INFORMATION = job.query().unwrap();
    assert_eq!(cpu.ControlFlags.0, 0);
}

#[test]
fn each_process_limit_is_added_to_the_ones_already_set() {
    let mut job = Job::new().unwrap();
    job.set_process_memory(256 * MIB).unwrap();
    let info = limits(&job);
    assert_eq!(
        info.BasicLimitInformation.LimitFlags,
        DEFAULTS | JOB_OBJECT_LIMIT_PROCESS_MEMORY
    );
    assert_eq!(info.ProcessMemoryLimit, 256 * MIB);
    job.set_active_processes(1).unwrap();
    let info = limits(&job);
    assert_eq!(
        info.BasicLimitInformation.LimitFlags,
        DEFAULTS | JOB_OBJECT_LIMIT_PROCESS_MEMORY | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
    );
    assert_eq!(info.BasicLimitInformation.ActiveProcessLimit, 1);
    assert_eq!(info.ProcessMemoryLimit, 256 * MIB);
}

#[test]
fn the_cpu_cap_reads_back_as_a_hard_cap_of_one_core() {
    let mut job = Job::new().unwrap();
    job.set_cpu_cap(100).unwrap();
    let cpu: JOBOBJECT_CPU_RATE_CONTROL_INFORMATION = job.query().unwrap();
    assert_eq!(
        cpu.ControlFlags,
        JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP
    );
    // Safety: a plain query with no pointer arguments.
    let processors = n(unsafe { GetActiveProcessorCount(ALL_PROCESSOR_GROUPS) });
    // Safety: the flags select `CpuRate` as the union's live field.
    assert_eq!(unsafe { cpu.Anonymous.CpuRate }, cpu_rate(100, processors));
    assert_eq!(limits(&job).BasicLimitInformation.LimitFlags, DEFAULTS);
}

#[test]
fn the_ui_restrictions_read_back_whole() {
    let mut job = Job::new().unwrap();
    job.restrict_ui().unwrap();
    let ui: JOBOBJECT_BASIC_UI_RESTRICTIONS = job.query().unwrap();
    // Desktop, display settings, exit windows, global atoms, handles, both clipboard directions and
    // system parameters: every bit from 1 to 128.
    assert_eq!(ui.UIRestrictionsClass, JOB_OBJECT_UILIMIT(0xFF));
    assert_eq!(limits(&job).BasicLimitInformation.LimitFlags, DEFAULTS);
}

#[test]
fn one_core_converts_to_the_machine_wide_rate() {
    assert_eq!(cpu_rate(100, n(1)), 10_000);
    assert_eq!(cpu_rate(100, n(8)), 1_250);
    // 156.25, rounded up so the cap is never under one core.
    assert_eq!(cpu_rate(100, n(64)), 157);
    assert_eq!(cpu_rate(50, n(8)), 625);
    assert_eq!(cpu_rate(400, n(2)), 10_000);
    assert_eq!(cpu_rate(0, n(8)), 1);
}

#[test]
fn a_spawn_waits_for_the_spawn_lock() {
    let held = spawn_lock();
    let (done, finished) = mpsc::channel();
    let spawner = thread::spawn(move || {
        let job = Job::new().unwrap();
        let child = spawn_in_job(&mut sleeper(), &job);
        done.send(()).unwrap();
        (child, job)
    });
    assert!(finished.recv_timeout(HELD).is_err());
    drop(held);
    finished.recv_timeout(SLOW).unwrap();
    let (child, job) = spawner.join().unwrap();
    let mut child = child.unwrap();
    job.terminate().unwrap();
    child.wait().unwrap();
}

#[test]
fn a_poisoned_spawn_lock_still_spawns() {
    let _ = thread::spawn(|| {
        let _held = spawn_lock();
        panic!("poisons the spawn lock");
    })
    .join();
    let job = Job::new().unwrap();
    let mut child = spawn_in_job(&mut sleeper(), &job).unwrap();
    assert_eq!(exit_within(&child, Duration::ZERO), None);
    drop(job);
    child.wait().unwrap();
}

#[test]
fn a_child_over_the_memory_cap_dies() {
    let mut job = Job::new().unwrap();
    // Under what the child commits to start, so it dies before any code of its own runs.
    job.set_process_memory(MIB).unwrap();
    let mut child = spawn_in_job(&mut sleeper(), &job).unwrap();
    let code = exit_within(&child, SLOW).expect("a capped child keeps running");
    assert_ne!(code, 0);
    child.wait().unwrap();
}

#[test]
fn the_peak_memory_of_a_running_child_reads_in_bytes() {
    let job = Job::new().unwrap();
    let mut child = spawn_in_job(&mut sleeper(), &job).unwrap();
    // A started process commits well over a mebibyte; read in pages or kilobytes, or from a limit
    // field that is unset here, the value stays under it.
    let start = Instant::now();
    while job.peak_process_memory().unwrap() < MIB {
        assert!(start.elapsed() < SLOW, "peak never reached a mebibyte");
        thread::sleep(POLL);
    }
    assert!(job.peak_process_memory().unwrap() < GIB);
    drop(job);
    child.wait().unwrap();
}

#[test]
fn the_cpu_time_of_a_busy_child_tracks_the_wall_clock() {
    let data = data_dir("busy");
    fs::create_dir_all(&data).unwrap();
    fs::write(data.join("test-mode"), "flood-stdout").unwrap();
    let job = Job::new().unwrap();
    let start = Instant::now();
    let mut child = spawn_in_job(&mut test_child(&data), &job).unwrap();
    let mut used = job.cpu_time().unwrap();
    while used < BUSY {
        assert!(start.elapsed() < SLOW, "only {used:?} of CPU time counted");
        thread::sleep(POLL);
        used = job.cpu_time().unwrap();
    }
    // The child runs one busy thread, so its CPU time cannot run far ahead of the wall clock. A
    // wrong tick unit would put it a factor of ten or more off.
    let wall = start.elapsed();
    assert!(used <= wall * 2, "{used:?} of CPU time in {wall:?}");
    drop(job);
    child.wait().unwrap();
    let _ = fs::remove_dir_all(&data);
}
