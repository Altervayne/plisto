/*
 * Starts a native plugin's executable in its own job, through the suspended spawn, so not one
 * instruction of plugin code runs outside the job. It gets no console window, its working folder is
 * its own plugin folder, its stdin and stdout are the protocol pipes, and its stderr goes to a log in
 * its data folder, truncated at every launch.
 */

// -- Library Imports --
use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{self, Command, Stdio};

// -- Local Imports --
use super::protocol::PROTOCOL_VERSION;
use crate::proc::job::Job;
use crate::proc::spawn::spawn_in_job;

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
    let child = spawn_in_job(
        Command::new(&spec.exe)
            .args(args(spec))
            .current_dir(&spec.plugin_dir)
            .env(WEBVIEW2_ENV, spec.data_dir.join(WEBVIEW2_DIR))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(stderr),
        &job,
    )?;
    Ok((child, job))
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
