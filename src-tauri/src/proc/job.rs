/*
 * A Job Object that owns a child's process tree. It is created with kill-on-close, so the moment its
 * only handle closes (Plisto drops it, exits, or is killed) every process in it dies, including
 * anything the child started. Breakaway is not allowed, so a grandchild cannot leave it.
 * The other limits are off until set. All the process limits share one structure, so each setter
 * reads it back first and never clears a limit set before it. Setters take `&mut self`: limits are
 * set while the job has one owner, before it is shared.
 */

// -- Library Imports --
use std::io;
use std::num::NonZeroU32;
use std::os::windows::io::AsRawHandle;
use std::process;
use std::time::Duration;

use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
    JobObjectBasicUIRestrictions, JobObjectCpuRateControlInformation,
    JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
    TerminateJobObject, JOBOBJECTINFOCLASS, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
    JOBOBJECT_BASIC_UI_RESTRICTIONS, JOBOBJECT_CPU_RATE_CONTROL_INFORMATION,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_CPU_RATE_CONTROL_ENABLE,
    JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP, JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
    JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOB_OBJECT_LIMIT_PROCESS_MEMORY, JOB_OBJECT_UILIMIT_DESKTOP,
    JOB_OBJECT_UILIMIT_DISPLAYSETTINGS, JOB_OBJECT_UILIMIT_EXITWINDOWS,
    JOB_OBJECT_UILIMIT_GLOBALATOMS, JOB_OBJECT_UILIMIT_HANDLES, JOB_OBJECT_UILIMIT_READCLIPBOARD,
    JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS, JOB_OBJECT_UILIMIT_WRITECLIPBOARD,
};
use windows::Win32::System::Threading::{GetActiveProcessorCount, ALL_PROCESSOR_GROUPS};

/// Exit code given to processes the job terminates.
const KILLED_EXIT_CODE: u32 = 1;
/// `CpuRate` for the whole machine: it counts in hundredths of a percent.
const FULL_MACHINE_RATE: u32 = 10_000;
/// Job accounting times count in 100-nanosecond ticks.
const NANOS_PER_TICK: u64 = 100;

/// A job information structure, tied to the class Windows reads or writes it as.
pub(super) trait JobInfo: Default {
    const CLASS: JOBOBJECTINFOCLASS;
}

impl JobInfo for JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    const CLASS: JOBOBJECTINFOCLASS = JobObjectExtendedLimitInformation;
}

impl JobInfo for JOBOBJECT_CPU_RATE_CONTROL_INFORMATION {
    const CLASS: JOBOBJECTINFOCLASS = JobObjectCpuRateControlInformation;
}

impl JobInfo for JOBOBJECT_BASIC_UI_RESTRICTIONS {
    const CLASS: JOBOBJECTINFOCLASS = JobObjectBasicUIRestrictions;
}

impl JobInfo for JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
    const CLASS: JOBOBJECTINFOCLASS = JobObjectBasicAccountingInformation;
}

pub struct Job(HANDLE);

// A job handle is a process-wide kernel handle, usable from any thread.
unsafe impl Send for Job {}
unsafe impl Sync for Job {}

/// The `CpuRate` that caps a job at `percent_of_one_core` of one logical processor on a machine with
/// `processors` of them. Rounded up, so the cap is never below the share asked for.
#[allow(dead_code)]
pub(super) fn cpu_rate(percent_of_one_core: u32, processors: NonZeroU32) -> u32 {
    percent_of_one_core
        .saturating_mul(100)
        .div_ceil(processors.get())
        .clamp(1, FULL_MACHINE_RATE)
}

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
        job.set(&info)?;
        Ok(job)
    }

    pub fn assign(&self, process: &process::Child) -> io::Result<()> {
        let handle = HANDLE(process.as_raw_handle());
        // Safety: the process handle stays open while `process` lives, and the job handle while self.
        unsafe { AssignProcessToJobObject(self.0, handle) }.map_err(io::Error::from)
    }

    /// The job's handle, for a launch that puts a process in the job as it creates it. It stays owned
    /// by self.
    pub(super) fn handle(&self) -> HANDLE {
        self.0
    }

    /// Kills every process in the job. The job stays usable and empty.
    pub fn terminate(&self) -> io::Result<()> {
        // Safety: the job handle stays open while self lives.
        unsafe { TerminateJobObject(self.0, KILLED_EXIT_CODE) }.map_err(io::Error::from)
    }

    /// Sets one information class of the job.
    fn set<T: JobInfo>(&self, info: &T) -> io::Result<()> {
        // Safety: `info` is a live, fully initialized T, the structure Windows defines for its class,
        // and the size passed is its own.
        unsafe {
            SetInformationJobObject(
                self.0,
                T::CLASS,
                info as *const T as *const core::ffi::c_void,
                std::mem::size_of::<T>() as u32,
            )
        }
        .map_err(io::Error::from)
    }
}

// The plugin host sets none of these limits and reads none of these values.
#[allow(dead_code)]
impl Job {
    /// Caps the memory each process in the job can commit, in bytes. An allocation past it fails.
    pub fn set_process_memory(&mut self, bytes: usize) -> io::Result<()> {
        self.update_limits(|info| {
            info.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_PROCESS_MEMORY;
            info.ProcessMemoryLimit = bytes;
        })
    }

    /// Caps how many processes the job holds at once. A process created past it is terminated.
    pub fn set_active_processes(&mut self, count: u32) -> io::Result<()> {
        self.update_limits(|info| {
            info.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
            info.BasicLimitInformation.ActiveProcessLimit = count;
        })
    }

    /// Hard-caps the job's CPU use at `percent_of_one_core` percent of one logical processor (100 is
    /// one full core), whatever the machine's processor count. Fails where a parent job already
    /// controls the rate, or when the processor count cannot be read.
    pub fn set_cpu_cap(&mut self, percent_of_one_core: u32) -> io::Result<()> {
        // Safety: a plain query with no pointer arguments.
        let processors = unsafe { GetActiveProcessorCount(ALL_PROCESSOR_GROUPS) };
        let processors = NonZeroU32::new(processors).ok_or_else(io::Error::last_os_error)?;
        let mut info = JOBOBJECT_CPU_RATE_CONTROL_INFORMATION {
            ControlFlags: JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP,
            ..Default::default()
        };
        info.Anonymous.CpuRate = cpu_rate(percent_of_one_core, processors);
        self.set(&info)
    }

    /// Keeps the job's processes off the desktop, the display settings, shutdown, global atoms, the
    /// clipboard, system parameters and user handles of processes outside the job.
    pub fn restrict_ui(&mut self) -> io::Result<()> {
        let info = JOBOBJECT_BASIC_UI_RESTRICTIONS {
            UIRestrictionsClass: JOB_OBJECT_UILIMIT_DESKTOP
                | JOB_OBJECT_UILIMIT_DISPLAYSETTINGS
                | JOB_OBJECT_UILIMIT_EXITWINDOWS
                | JOB_OBJECT_UILIMIT_GLOBALATOMS
                | JOB_OBJECT_UILIMIT_HANDLES
                | JOB_OBJECT_UILIMIT_READCLIPBOARD
                | JOB_OBJECT_UILIMIT_WRITECLIPBOARD
                | JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS,
        };
        self.set(&info)
    }

    /// User plus kernel CPU time of every process the job has held, ended ones included.
    pub fn cpu_time(&self) -> io::Result<Duration> {
        let info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = self.query()?;
        let ticks = info.TotalUserTime.max(0) as u64 + info.TotalKernelTime.max(0) as u64;
        Ok(Duration::from_nanos(ticks.saturating_mul(NANOS_PER_TICK)))
    }

    /// The most memory any one process in the job has committed, in bytes.
    pub fn peak_process_memory(&self) -> io::Result<usize> {
        let info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = self.query()?;
        Ok(info.PeakProcessMemoryUsed)
    }

    fn update_limits(
        &mut self,
        change: impl FnOnce(&mut JOBOBJECT_EXTENDED_LIMIT_INFORMATION),
    ) -> io::Result<()> {
        let mut info = self.query()?;
        change(&mut info);
        self.set(&info)
    }

    /// One information class of the job.
    pub(super) fn query<T: JobInfo>(&self) -> io::Result<T> {
        let mut info = T::default();
        // Safety: `info` is a live, writable T, the structure Windows defines for its class, and the
        // size passed is its own.
        unsafe {
            QueryInformationJobObject(
                self.0,
                T::CLASS,
                &mut info as *mut T as *mut core::ffi::c_void,
                std::mem::size_of::<T>() as u32,
                None,
            )
        }
        .map_err(io::Error::from)?;
        Ok(info)
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        // Safety: the handle is owned by this Job and closed exactly once, here.
        let _ = unsafe { CloseHandle(self.0) };
    }
}
