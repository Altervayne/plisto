/*
 * Starts a native plugin's executable. The process is created suspended, put in its own job, and only
 * then resumed, so not one instruction of plugin code runs outside the job. It gets no console window,
 * its working folder is its own plugin folder, its stdin and stdout are the protocol pipes, and its
 * stderr goes to a log in its data folder, truncated at every launch.
 */

// -- Library Imports --
use std::ffi::OsString;
use std::fs;
use std::io;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{self, Command, Stdio};

use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
};
use windows::Win32::System::Threading::{
    OpenThread, ResumeThread, CREATE_NO_WINDOW, CREATE_SUSPENDED, THREAD_SUSPEND_RESUME,
};

// -- Local Imports --
use super::job::Job;
use super::protocol::PROTOCOL_VERSION;

const STDERR_LOG: &str = "stderr.log";
const WEBVIEW2_DIR: &str = "webview2";
// WebView2 otherwise puts its profile beside the executable, inside the plugin's code folder, which an
// update replaces.
const WEBVIEW2_ENV: &str = "WEBVIEW2_USER_DATA_FOLDER";

/// Everything needed to start one native plugin.
#[derive(Clone, Debug)]
pub struct LaunchSpec {
    pub exe: PathBuf,
    pub plugin_dir: PathBuf,
    pub data_dir: PathBuf,
    /// The audio tap mapping's name, when the plugin reads the tap.
    pub tap: Option<String>,
}

/// The manifest entry (forward slashes, already validated) as a path inside the plugin folder.
pub fn entry_path(plugin_dir: &Path, entry: &str) -> PathBuf {
    let mut path = plugin_dir.to_path_buf();
    path.extend(entry.split('/'));
    path
}

pub fn stderr_log(data_dir: &Path) -> PathBuf {
    data_dir.join(STDERR_LOG)
}

/// `--plisto-protocol 1 --plisto-data <dir> --plisto-tap <name|none>`.
pub fn args(spec: &LaunchSpec) -> Vec<OsString> {
    vec![
        "--plisto-protocol".into(),
        PROTOCOL_VERSION.to_string().into(),
        "--plisto-data".into(),
        spec.data_dir.clone().into_os_string(),
        "--plisto-tap".into(),
        spec.tap.as_deref().unwrap_or("none").into(),
    ]
}

/// Starts the plugin inside a new job. The returned child has piped stdin and stdout; on any error
/// nothing is left running.
pub fn launch(spec: &LaunchSpec) -> io::Result<(process::Child, Job)> {
    fs::create_dir_all(&spec.data_dir)?;
    let stderr = fs::File::create(stderr_log(&spec.data_dir))?;
    let job = Job::new()?;
    let mut child = Command::new(&spec.exe)
        .args(args(spec))
        .current_dir(&spec.plugin_dir)
        .env(WEBVIEW2_ENV, spec.data_dir.join(WEBVIEW2_DIR))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(stderr)
        .creation_flags((CREATE_NO_WINDOW | CREATE_SUSPENDED).0)
        .spawn()?;
    if let Err(e) = job.assign(&child).and_then(|()| resume(child.id())) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(e);
    }
    Ok((child, job))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_entry_resolves_inside_the_plugin_folder() {
        let dir = Path::new("plugins").join("com.example.demo");
        assert_eq!(
            entry_path(&dir, "bin/tool.exe"),
            dir.join("bin").join("tool.exe")
        );
    }

    #[test]
    fn argv_carries_protocol_data_and_tap() {
        let mut spec = LaunchSpec {
            exe: PathBuf::from("tool.exe"),
            plugin_dir: PathBuf::from("p"),
            data_dir: PathBuf::from("d"),
            tap: None,
        };
        let expected: Vec<OsString> = [
            "--plisto-protocol",
            "1",
            "--plisto-data",
            "d",
            "--plisto-tap",
            "none",
        ]
        .iter()
        .map(OsString::from)
        .collect();
        assert_eq!(args(&spec), expected);
        spec.tap = Some("Local\\plisto-tap-1-2".into());
        assert_eq!(args(&spec)[5], OsString::from("Local\\plisto-tap-1-2"));
    }
}
