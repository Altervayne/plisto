/*
 * The session marker and the safe-mode flag. A launch writes `.session` stamped with the app version and
 * pid, and a clean exit removes it, so a marker still present at the next launch means the last run did
 * not exit cleanly. A marker from another app version is not a crash: the updater replaces the
 * binary without passing through the exit handler, so the leftover is expected and ignored. The
 * `.safe-mode` flag is a plain file whose presence asks the next launch to start no plugin.
 */

// -- Library Imports --
use std::fs;
use std::io::{self, Read};
use std::path::Path;

use serde::{Deserialize, Serialize};

// -- Local Imports --
use super::paths::{safe_mode_file, session_file, state_dir};

const MAX_MARKER_BYTES: u64 = 4096;

#[derive(Serialize, Deserialize)]
struct Marker {
    app_version: String,
    pid: u32,
}

/// What the previous run left behind.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct BootState {
    /// The safe-mode flag is set: start no plugin.
    pub safe_mode: bool,
    /// The previous run of this version did not exit cleanly.
    pub unclean: bool,
}

enum Previous {
    None,
    /// Written by a different app version.
    Stale,
    Current,
    /// Present but not a marker; counted as a crash.
    Unreadable,
}

fn read_marker(app_data: &Path, app_version: &str) -> Previous {
    let file = match fs::File::open(session_file(app_data)) {
        Ok(file) => file,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Previous::None,
        Err(_) => return Previous::Unreadable,
    };
    let mut bytes = Vec::new();
    if file.take(MAX_MARKER_BYTES).read_to_end(&mut bytes).is_err() {
        return Previous::Unreadable;
    }
    match serde_json::from_slice::<Marker>(&bytes) {
        Ok(marker) if marker.app_version == app_version => Previous::Current,
        Ok(_) => Previous::Stale,
        Err(_) => Previous::Unreadable,
    }
}

/// Reads the marker and the flag. Call before `stamp`, which replaces the marker.
pub fn boot_state(app_data: &Path, app_version: &str) -> BootState {
    BootState {
        safe_mode: safe_mode_file(app_data).is_file(),
        unclean: matches!(
            read_marker(app_data, app_version),
            Previous::Current | Previous::Unreadable
        ),
    }
}

/// Writes this run's marker.
pub fn stamp(app_data: &Path, app_version: &str, pid: u32) -> io::Result<()> {
    fs::create_dir_all(state_dir(app_data))?;
    let marker = Marker {
        app_version: app_version.to_string(),
        pid,
    };
    fs::write(
        session_file(app_data),
        serde_json::to_vec(&marker).map_err(io::Error::other)?,
    )
}

/// Removes the marker: a clean exit.
pub fn clear(app_data: &Path) {
    let _ = fs::remove_file(session_file(app_data));
}

/// Sets or removes the safe-mode flag.
pub fn set_safe_mode(app_data: &Path, on: bool) -> io::Result<()> {
    if on {
        fs::create_dir_all(state_dir(app_data))?;
        fs::write(safe_mode_file(app_data), b"")
    } else {
        match fs::remove_file(safe_mode_file(app_data)) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct AppData(PathBuf);

    impl AppData {
        fn new() -> AppData {
            static N: AtomicUsize = AtomicUsize::new(0);
            AppData(std::env::temp_dir().join(format!(
                "plisto-session-test-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            )))
        }
    }

    impl Drop for AppData {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_first_launch_is_clean() {
        let d = AppData::new();
        assert_eq!(boot_state(&d.0, "2.7.0"), BootState::default());
    }

    #[test]
    fn a_marker_left_by_the_same_version_is_a_crash() {
        let d = AppData::new();
        stamp(&d.0, "2.7.0", 1234).unwrap();
        assert!(boot_state(&d.0, "2.7.0").unclean);
    }

    #[test]
    fn a_marker_from_another_version_is_not_a_crash() {
        let d = AppData::new();
        stamp(&d.0, "2.7.0", 1234).unwrap();
        let state = boot_state(&d.0, "2.7.1");
        assert!(!state.unclean && !state.safe_mode);
        // Older after a downgrade, too.
        assert!(!boot_state(&d.0, "2.6.9").unclean);
    }

    #[test]
    fn the_marker_records_version_and_pid() {
        let d = AppData::new();
        stamp(&d.0, "2.7.0", 4321).unwrap();
        let text = fs::read_to_string(session_file(&d.0)).unwrap();
        let marker: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(marker["app_version"], "2.7.0");
        assert_eq!(marker["pid"], 4321);
    }

    #[test]
    fn a_clean_exit_leaves_no_crash_behind() {
        let d = AppData::new();
        stamp(&d.0, "2.7.0", 1).unwrap();
        clear(&d.0);
        assert!(!session_file(&d.0).exists());
        assert!(!boot_state(&d.0, "2.7.0").unclean);
        // Clearing twice, or with nothing there, is fine.
        clear(&d.0);
    }

    #[test]
    fn an_unreadable_marker_counts_as_a_crash() {
        let d = AppData::new();
        fs::create_dir_all(state_dir(&d.0)).unwrap();
        for bytes in [&b""[..], b"garbage", b"{\"app_version\":3}", b"\xff\xfe"] {
            fs::write(session_file(&d.0), bytes).unwrap();
            assert!(boot_state(&d.0, "2.7.0").unclean, "{bytes:?}");
        }
        // A directory in the marker's place cannot be read either.
        fs::remove_file(session_file(&d.0)).unwrap();
        fs::create_dir(session_file(&d.0)).unwrap();
        assert!(boot_state(&d.0, "2.7.0").unclean);
    }

    #[test]
    fn the_safe_mode_flag_round_trips() {
        let d = AppData::new();
        assert!(!boot_state(&d.0, "2.7.0").safe_mode);
        set_safe_mode(&d.0, true).unwrap();
        assert!(boot_state(&d.0, "2.7.0").safe_mode);
        set_safe_mode(&d.0, true).unwrap();
        set_safe_mode(&d.0, false).unwrap();
        assert!(!boot_state(&d.0, "2.7.0").safe_mode);
        set_safe_mode(&d.0, false).unwrap();
    }

    #[test]
    fn the_flag_and_the_marker_are_independent() {
        let d = AppData::new();
        set_safe_mode(&d.0, true).unwrap();
        stamp(&d.0, "2.7.0", 1).unwrap();
        let state = boot_state(&d.0, "2.7.0");
        assert!(state.safe_mode && state.unclean);
        clear(&d.0);
        let state = boot_state(&d.0, "2.7.0");
        assert!(state.safe_mode && !state.unclean);
    }
}
