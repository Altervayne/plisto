/*
 * Starts a process inside an AppContainer and a job, through a raw `CreateProcessW`: std's `Command`
 * cannot name an AppContainer. The process is created suspended and put in its job by the same call,
 * so not one instruction of it runs outside the job. Its stdin and stdout are two anonymous pipes,
 * its stderr is a null handle, its environment holds only `SystemRoot`, `SystemDrive` and
 * `LOCALAPPDATA`, and its mitigation policy forbids dynamic code, extension points, remote and
 * low-label images and non-system fonts, and makes the use of a bad handle fatal.
 *
 * An explicit handle list makes the two pipe ends the only handles the child inherits, whatever else
 * in Plisto is inheritable. The ends are inheritable only while the spawn lock is held, so a launch
 * through `spawn_in_job` never picks them up. A std spawn that skips the lock can still inherit
 * them in that window, so a caller tells that the process ended from `wait_timeout`, never from its
 * pipe closing alone.
 */

// -- Library Imports --
use std::ffi::{c_void, OsStr};
use std::fs::File;
use std::io;
use std::marker::PhantomData;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::Path;
use std::ptr;
use std::time::Duration;

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows::Win32::Security::{PSID, SECURITY_CAPABILITIES};
use windows::Win32::System::Pipes::CreatePipe;
use windows::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess,
    InitializeProcThreadAttributeList, ResumeThread, TerminateProcess, UpdateProcThreadAttribute,
    WaitForSingleObject, BELOW_NORMAL_PRIORITY_CLASS, CREATE_NO_WINDOW, CREATE_SUSPENDED,
    CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT, LPPROC_THREAD_ATTRIBUTE_LIST,
    PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY,
    PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROC_THREAD_ATTRIBUTE_JOB_LIST,
    PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
    STARTF_USESTDHANDLES, STARTUPINFOEXW,
};

#[cfg(debug_assertions)]
use windows::Win32::System::Threading::{STARTF_TITLEISAPPID, STARTUPINFOW};

// -- Local Imports --
use super::job::Job;
use super::spawn::spawn_lock;

// The `_ALWAYS_ON` bits of the process creation mitigation policy, from winbase.h.
const STRICT_HANDLE_CHECKS: u64 = 1 << 24;
const EXTENSION_POINT_DISABLE: u64 = 1 << 32;
const PROHIBIT_DYNAMIC_CODE: u64 = 1 << 36;
const FONT_DISABLE: u64 = 1 << 48;
const IMAGE_LOAD_NO_REMOTE: u64 = 1 << 52;
const IMAGE_LOAD_NO_LOW_LABEL: u64 = 1 << 56;
const MITIGATIONS: u64 = STRICT_HANDLE_CHECKS
    | EXTENSION_POINT_DISABLE
    | PROHIBIT_DYNAMIC_CODE
    | FONT_DISABLE
    | IMAGE_LOAD_NO_REMOTE
    | IMAGE_LOAD_NO_LOW_LABEL;
// Handle list, security capabilities, job list, mitigation policy and the app packages policy.
const ATTRIBUTE_COUNT: u32 = 5;
// The app packages policy value that leaves ALL APPLICATION PACKAGES out of the token.
const ALL_APPLICATION_PACKAGES_OPT_OUT: u32 = 1;

/// Which kind of AppContainer token the process gets.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Isolation {
    /// Less privileged: the token leaves out ALL APPLICATION PACKAGES, so the process reads only what
    /// grants its own SID or ALL RESTRICTED APPLICATION PACKAGES. The user's registry keys grant
    /// every app package read, so only this mode keeps them out of reach.
    LessPrivileged,
    /// The token holds ALL APPLICATION PACKAGES.
    Plain,
}
// An AppContainer launch whose environment lacks `LOCALAPPDATA` fails with ERROR_ENVVAR_NOT_FOUND.
const ENVIRONMENT: [&str; 3] = ["SystemRoot", "SystemDrive", "LOCALAPPDATA"];
// Exit code given to a child whose threads could not be resumed.
const NOT_STARTED_EXIT_CODE: u32 = 1;

/// A process started in an AppContainer. Dropping it closes Plisto's handles only; the process ends
/// when it exits or its job closes.
pub struct Contained {
    process: OwnedHandle,
    pid: u32,
    /// The write end of the child's stdin.
    pub stdin: Option<File>,
    /// The read end of the child's stdout.
    pub stdout: Option<File>,
}

impl Contained {
    pub fn id(&self) -> u32 {
        self.pid
    }

    /// The exit code once the process has exited within `timeout`, else None.
    pub fn wait_timeout(&self, timeout: Duration) -> io::Result<Option<u32>> {
        let millis = u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX - 1);
        // SAFETY: the process handle stays open while self lives.
        match unsafe { WaitForSingleObject(self.handle(), millis) } {
            WAIT_OBJECT_0 => {
                let mut code = 0u32;
                // SAFETY: same open handle, and `code` is a live u32.
                unsafe { GetExitCodeProcess(self.handle(), &mut code) }?;
                Ok(Some(code))
            }
            WAIT_TIMEOUT => Ok(None),
            _ => Err(io::Error::last_os_error()),
        }
    }

    /// The process handle, owned by self.
    pub(super) fn handle(&self) -> HANDLE {
        HANDLE(self.process.as_raw_handle())
    }
}

/// Starts `exe` with `args` in the AppContainer `container`, inside `job`, with no capabilities. On
/// any error nothing is left running.
pub fn spawn(
    exe: &Path,
    args: &[&OsStr],
    job: &Job,
    container: PSID,
    isolation: Isolation,
) -> io::Result<Contained> {
    let (child_in, main_in) = pipe()?;
    let (main_out, child_out) = pipe()?;
    let application = wide(exe.as_os_str());
    let mut command_line = command_line(exe.as_os_str(), args);
    let environment = environment_block();
    let folder = wide(exe.parent().unwrap_or(exe).as_os_str());

    let inherited = [raw(&child_in), raw(&child_out)];
    let capabilities = SECURITY_CAPABILITIES {
        AppContainerSid: container,
        Capabilities: ptr::null_mut(),
        CapabilityCount: 0,
        Reserved: 0,
    };
    let jobs = [job.handle()];
    let mut attributes = AttributeList::new(ATTRIBUTE_COUNT)?;
    attributes.set(PROC_THREAD_ATTRIBUTE_HANDLE_LIST, &inherited)?;
    attributes.set(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, &capabilities)?;
    attributes.set(PROC_THREAD_ATTRIBUTE_JOB_LIST, &jobs)?;
    attributes.set(PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY, &MITIGATIONS)?;
    if isolation == Isolation::LessPrivileged {
        attributes.set(
            PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY,
            &ALL_APPLICATION_PACKAGES_OPT_OUT,
        )?;
    }

    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = inherited[0];
    startup.StartupInfo.hStdOutput = inherited[1];
    startup.StartupInfo.hStdError = HANDLE::default();
    startup.lpAttributeList = attributes.raw();
    let flags = EXTENDED_STARTUPINFO_PRESENT
        | CREATE_SUSPENDED
        | CREATE_NO_WINDOW
        | BELOW_NORMAL_PRIORITY_CLASS
        | CREATE_UNICODE_ENVIRONMENT;

    let mut info = PROCESS_INFORMATION::default();
    let created = {
        let _lock = spawn_lock();
        let created = inheritable(&child_in)
            .and_then(|()| inheritable(&child_out))
            .and_then(|()| {
                // SAFETY: every string is NUL-terminated and outlives the call, the command line is
                // writable, the environment block ends in two NULs, and the attribute list and every
                // value it points at live until after the call.
                unsafe {
                    CreateProcessW(
                        PCWSTR(application.as_ptr()),
                        PWSTR(command_line.as_mut_ptr()),
                        None,
                        None,
                        true,
                        flags,
                        Some(environment.as_ptr().cast()),
                        PCWSTR(folder.as_ptr()),
                        &startup.StartupInfo,
                        &mut info,
                    )
                }
                .map_err(io::Error::from)
            });
        // Closed before the lock is released, so the inheritable ends never outlive it.
        drop((child_in, child_out));
        created
    };
    created?;
    // SAFETY: CreateProcessW succeeded, so both handles are open and owned by this call alone.
    let (process, thread) = unsafe {
        (
            OwnedHandle::from_raw_handle(info.hProcess.0),
            OwnedHandle::from_raw_handle(info.hThread.0),
        )
    };
    // SAFETY: the thread handle is open and carries resume rights.
    if unsafe { ResumeThread(HANDLE(thread.as_raw_handle())) } == u32::MAX {
        let error = io::Error::last_os_error();
        // SAFETY: the process handle is open and carries terminate rights.
        let _ = unsafe { TerminateProcess(HANDLE(process.as_raw_handle()), NOT_STARTED_EXIT_CODE) };
        return Err(error);
    }
    Ok(Contained {
        process,
        pid: info.dwProcessId,
        stdin: Some(File::from(main_in)),
        stdout: Some(File::from(main_out)),
    })
}

/// Starts `exe` with no job and no container, naming `app_id` as the process's AppUserModelID through
/// the startup title. Only for the debug probe that compares how Task Manager groups processes.
#[cfg(debug_assertions)]
pub fn spawn_titled(exe: &Path, args: &[&OsStr], app_id: &OsStr) -> io::Result<Contained> {
    let (child_in, main_in) = pipe()?;
    let (main_out, child_out) = pipe()?;
    let application = wide(exe.as_os_str());
    let mut command_line = command_line(exe.as_os_str(), args);
    let mut title = wide(app_id);
    let startup = STARTUPINFOW {
        cb: std::mem::size_of::<STARTUPINFOW>() as u32,
        dwFlags: STARTF_USESTDHANDLES | STARTF_TITLEISAPPID,
        lpTitle: PWSTR(title.as_mut_ptr()),
        hStdInput: raw(&child_in),
        hStdOutput: raw(&child_out),
        hStdError: HANDLE::default(),
        ..Default::default()
    };

    let mut info = PROCESS_INFORMATION::default();
    let created = {
        let _lock = spawn_lock();
        let created = inheritable(&child_in)
            .and_then(|()| inheritable(&child_out))
            .and_then(|()| {
                // SAFETY: every string is NUL-terminated and outlives the call, the command line is
                // writable, and the startup info holds two open handles.
                unsafe {
                    CreateProcessW(
                        PCWSTR(application.as_ptr()),
                        PWSTR(command_line.as_mut_ptr()),
                        None,
                        None,
                        true,
                        CREATE_NO_WINDOW,
                        None,
                        PCWSTR::null(),
                        &startup,
                        &mut info,
                    )
                }
                .map_err(io::Error::from)
            });
        // Closed before the lock is released, so the inheritable ends never outlive it.
        drop((child_in, child_out));
        created
    };
    created?;
    // SAFETY: CreateProcessW succeeded, so both handles are open and owned by this call alone.
    let (process, thread) = unsafe {
        (
            OwnedHandle::from_raw_handle(info.hProcess.0),
            OwnedHandle::from_raw_handle(info.hThread.0),
        )
    };
    drop(thread);
    Ok(Contained {
        process,
        pid: info.dwProcessId,
        stdin: Some(File::from(main_in)),
        stdout: Some(File::from(main_out)),
    })
}

/// An anonymous pipe, read end first. Neither end is inheritable.
fn pipe() -> io::Result<(OwnedHandle, OwnedHandle)> {
    let mut read = HANDLE::default();
    let mut write = HANDLE::default();
    // SAFETY: both out-pointers are live locals; on success each handle is owned at once.
    unsafe { CreatePipe(&mut read, &mut write, None, 0) }?;
    // SAFETY: both handles were just created and nothing else owns them.
    Ok(unsafe {
        (
            OwnedHandle::from_raw_handle(read.0),
            OwnedHandle::from_raw_handle(write.0),
        )
    })
}

fn raw(handle: &OwnedHandle) -> HANDLE {
    HANDLE(handle.as_raw_handle())
}

fn inheritable(handle: &OwnedHandle) -> io::Result<()> {
    // SAFETY: the handle is open while `handle` lives.
    unsafe { SetHandleInformation(raw(handle), HANDLE_FLAG_INHERIT.0, HANDLE_FLAG_INHERIT) }
        .map_err(io::Error::from)
}

fn wide(text: &OsStr) -> Vec<u16> {
    text.encode_wide().chain([0]).collect()
}

/// `"exe" arg...`, NUL-terminated, quoted so the child's argv reads back the same arguments.
fn command_line(exe: &OsStr, args: &[&OsStr]) -> Vec<u16> {
    let quote = u16::from(b'"');
    // A path holds no quote, and argv[0] is read up to the closing quote with no escapes.
    let mut line = vec![quote];
    line.extend(exe.encode_wide());
    line.push(quote);
    for arg in args {
        line.push(u16::from(b' '));
        push_argument(&mut line, arg);
    }
    line.push(0);
    line
}

// The rules the Microsoft C runtime parses argv by: backslashes are literal unless they precede a
// quote, so those before a quote, and before the closing quote, are doubled.
fn push_argument(line: &mut Vec<u16>, arg: &OsStr) {
    let [quote, backslash, space, tab] = b"\"\\ \t".map(u16::from);
    let units: Vec<u16> = arg.encode_wide().collect();
    if !units.is_empty() && !units.iter().any(|&c| c == quote || c == space || c == tab) {
        line.extend(units);
        return;
    }
    line.push(quote);
    let mut backslashes = 0;
    for c in units {
        if c == backslash {
            backslashes += 1;
            continue;
        }
        let doubled = if c == quote {
            backslashes * 2 + 1
        } else {
            backslashes
        };
        line.extend(std::iter::repeat_n(backslash, doubled));
        line.push(c);
        backslashes = 0;
    }
    line.extend(std::iter::repeat_n(backslash, backslashes * 2));
    line.push(quote);
}

/// `name=value` pairs, each NUL-terminated, then one more NUL.
fn environment_block() -> Vec<u16> {
    let mut block = Vec::new();
    for name in ENVIRONMENT {
        if let Some(value) = std::env::var_os(name) {
            block.extend(OsStr::new(name).encode_wide());
            block.push(u16::from(b'='));
            block.extend(value.encode_wide());
            block.push(0);
        }
    }
    // An empty block is still two NULs.
    if block.is_empty() {
        block.push(0);
    }
    block.push(0);
    block
}

/// A process creation attribute list. Every value set on it must outlive it, which `'a` enforces.
struct AttributeList<'a> {
    buffer: Vec<u64>,
    values: PhantomData<&'a ()>,
}

impl<'a> AttributeList<'a> {
    fn new(count: u32) -> io::Result<AttributeList<'a>> {
        let mut size = 0usize;
        // SAFETY: a null list asks only for the size, which the call writes to `size`; the expected
        // insufficient-buffer error is ignored.
        let _ = unsafe {
            InitializeProcThreadAttributeList(
                LPPROC_THREAD_ATTRIBUTE_LIST(ptr::null_mut()),
                count,
                0,
                &mut size,
            )
        };
        let mut buffer = vec![0u64; size.div_ceil(8)];
        let list = LPPROC_THREAD_ATTRIBUTE_LIST(buffer.as_mut_ptr().cast());
        // SAFETY: the buffer holds at least `size` bytes, aligned for the list.
        unsafe { InitializeProcThreadAttributeList(list, count, 0, &mut size) }?;
        Ok(AttributeList {
            buffer,
            values: PhantomData,
        })
    }

    fn raw(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        LPPROC_THREAD_ATTRIBUTE_LIST(self.buffer.as_mut_ptr().cast())
    }

    fn set<T: ?Sized>(&mut self, attribute: u32, value: &'a T) -> io::Result<()> {
        // SAFETY: the list is initialized, and `value` outlives it, so the pointer it keeps stays
        // valid until the list is deleted.
        unsafe {
            UpdateProcThreadAttribute(
                self.raw(),
                0,
                attribute as usize,
                Some(value as *const T as *const c_void),
                std::mem::size_of_val(value),
                None,
                None,
            )
        }
        .map_err(io::Error::from)
    }
}

impl Drop for AttributeList<'_> {
    fn drop(&mut self) {
        // SAFETY: the list was initialized in `new` and is deleted exactly once, here.
        unsafe { DeleteProcThreadAttributeList(self.raw()) };
    }
}

#[cfg(test)]
mod tests {
    use std::ffi::{c_void, OsString};

    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::UI::Shell::CommandLineToArgvW;

    use super::*;

    #[test]
    fn the_command_line_parses_back_to_the_same_arguments() {
        let args = [
            "plain",
            "with space",
            "",
            "quote\"inside",
            "trailing\\",
            "back\\\\\"slash",
            r"C:\Users\a b\",
        ];
        let exe = r"C:\Program Files\Plisto\plisto.exe";
        let os: Vec<OsString> = args.iter().map(OsString::from).collect();
        let refs: Vec<&OsStr> = os.iter().map(OsString::as_os_str).collect();
        let line = command_line(OsStr::new(exe), &refs);
        let mut count = 0;
        // SAFETY: `line` is NUL-terminated; the returned array is freed once below.
        let argv = unsafe { CommandLineToArgvW(PCWSTR(line.as_ptr()), &mut count) };
        assert!(!argv.is_null());
        // SAFETY: the array holds `count` NUL-terminated strings.
        let parsed: Vec<String> = (0..count as usize)
            .map(|i| unsafe { (*argv.add(i)).to_string() }.unwrap())
            .collect();
        // SAFETY: the array came from CommandLineToArgvW and is freed once.
        unsafe { LocalFree(HLOCAL(argv as *mut c_void)) };
        assert_eq!(parsed[0], exe);
        assert_eq!(parsed[1..], args);
    }
}
