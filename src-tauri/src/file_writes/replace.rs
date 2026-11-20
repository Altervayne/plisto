/*
 * Replacing a library file with its finished temp through `ReplaceFileW`, with a backup name. The
 * replaced file keeps its creation time, ACL and streams, and the original survives under the backup
 * name. A handle opened with share-delete, as the player's are, follows the original to that name and
 * keeps reading valid bytes. Every path goes in verbatim, so a path past MAX_PATH works.
 */

// -- Library Imports --
use std::fs::OpenOptions;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::path::{Component, Path, Prefix};
use std::thread;
use std::time::Duration;

use windows::core::PCWSTR;
use windows::Win32::Foundation::{
    ERROR_ACCESS_DENIED, ERROR_SHARING_VIOLATION, ERROR_UNABLE_TO_MOVE_REPLACEMENT,
    ERROR_UNABLE_TO_MOVE_REPLACEMENT_2, ERROR_UNABLE_TO_REMOVE_REPLACED, WIN32_ERROR,
};
use windows::Win32::Storage::FileSystem::{ReplaceFileW, REPLACE_FILE_FLAGS};

// Antivirus or an indexer can hold a fresh file for a moment, so a held file is retried briefly.
const ATTEMPTS: u32 = 3;
const RETRY_DELAY: Duration = Duration::from_millis(100);
const HELD_CODES: [WIN32_ERROR; 2] = [ERROR_ACCESS_DENIED, ERROR_SHARING_VIOLATION];

/// What a replace left on disk. S is the source, T the temp and B the backup name.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReplaceOutcome {
    /// S holds the new bytes, B holds the original, and T no longer exists.
    Replaced,
    /// Errors 1175 and 1176: nothing moved. S is the original, T is still under its own name, and
    /// nothing is under B.
    NothingMoved { code: u32 },
    /// Error 1177: S no longer exists. The original is under B, and the new bytes are still under T,
    /// which may now carry the original's attributes and streams.
    OriginalAtBackup,
    /// Any other error, held errors included once the retries run out. The call documents no state
    /// for these, so the caller reads the disk before acting.
    Failed { code: u32 },
}

/// Replaces `source` with `temp`, keeping the original under `backup`. All three must sit on one
/// volume. A held file is retried only while all three names still read as before the call. Err means
/// a path could not be made absolute, and nothing was tried.
pub fn replace(source: &Path, temp: &Path, backup: &Path) -> io::Result<ReplaceOutcome> {
    let (s, t, b) = (verbatim(source)?, verbatim(temp)?, verbatim(backup)?);
    let mut attempt = 1;
    loop {
        // SAFETY: the three names are NUL-terminated and outlive the call; both reserved pointers are
        // null.
        let result = unsafe {
            ReplaceFileW(
                PCWSTR(s.as_ptr()),
                PCWSTR(t.as_ptr()),
                PCWSTR(b.as_ptr()),
                REPLACE_FILE_FLAGS(0),
                None,
                None,
            )
        };
        let code = match result {
            Ok(()) => return Ok(ReplaceOutcome::Replaced),
            Err(e) => win32_code(&e),
        };
        let held = HELD_CODES.iter().any(|c| c.0 == code);
        if held && attempt < ATTEMPTS && untouched(source, temp, backup) {
            attempt += 1;
            thread::sleep(RETRY_DELAY);
            continue;
        }
        return Ok(outcome(code));
    }
}

fn outcome(code: u32) -> ReplaceOutcome {
    match WIN32_ERROR(code) {
        ERROR_UNABLE_TO_REMOVE_REPLACED | ERROR_UNABLE_TO_MOVE_REPLACEMENT => {
            ReplaceOutcome::NothingMoved { code }
        }
        ERROR_UNABLE_TO_MOVE_REPLACEMENT_2 => ReplaceOutcome::OriginalAtBackup,
        _ => ReplaceOutcome::Failed { code },
    }
}

fn untouched(source: &Path, temp: &Path, backup: &Path) -> bool {
    source.is_file() && temp.is_file() && !backup.exists()
}

/// Flushes a file's data and metadata to the disk. A held file is retried like the replace. The flush
/// needs write access, so a read-only file fails here; callers check `is_read_only` first.
// Unused until a command writes a music file in place.
#[allow(dead_code)]
pub fn sync_path(path: &Path) -> io::Result<()> {
    let mut attempt = 1;
    loop {
        match OpenOptions::new()
            .write(true)
            .open(path)
            .and_then(|f| f.sync_all())
        {
            Ok(()) => return Ok(()),
            Err(e) if attempt < ATTEMPTS && is_held(&e) => {
                attempt += 1;
                thread::sleep(RETRY_DELAY);
            }
            Err(e) => return Err(e),
        }
    }
}

fn is_held(e: &io::Error) -> bool {
    e.raw_os_error()
        .is_some_and(|code| HELD_CODES.iter().any(|c| c.0 as i32 == code))
}

/// The Win32 error code inside a `windows` error, or its raw HRESULT when it carries none.
pub(super) fn win32_code(e: &windows::core::Error) -> u32 {
    WIN32_ERROR::from_error(e).map_or(e.code().0 as u32, |c| c.0)
}

pub(super) fn os_error(e: windows::core::Error) -> io::Error {
    io::Error::from_raw_os_error(win32_code(&e) as i32)
}

/// The path as verbatim UTF-16 with no terminator. A verbatim path skips the Win32 normalization and
/// its MAX_PATH limit, so the path is made absolute and normalized first.
pub(super) fn verbatim_units(path: &Path) -> io::Result<Vec<u16>> {
    let full = std::path::absolute(path)?;
    let wide = full.as_os_str().encode_wide();
    let kind = match full.components().next() {
        Some(Component::Prefix(prefix)) => Some(prefix.kind()),
        _ => None,
    };
    Ok(match kind {
        Some(Prefix::Disk(_)) => r"\\?\".encode_utf16().chain(wide).collect(),
        // `\\server\share` becomes `\\?\UNC\server\share`.
        Some(Prefix::UNC(..)) => r"\\?\UNC\".encode_utf16().chain(wide.skip(2)).collect(),
        _ => wide.collect(),
    })
}

/// `verbatim_units`, NUL-terminated for a Win32 call.
pub(super) fn verbatim(path: &Path) -> io::Result<Vec<u16>> {
    let mut units = verbatim_units(path)?;
    units.push(0);
    Ok(units)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file_writes::attrs::{clear_hidden, is_hidden, set_hidden};
    use crate::file_writes::space::free_space;
    use std::fs::{self, File, FileTimes};
    use std::os::windows::fs::{FileTimesExt, OpenOptionsExt};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::{Instant, UNIX_EPOCH};

    // FILE_SHARE_READ only: no share-delete, so a replace cannot move the file.
    const SHARE_READ: u32 = 1;

    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new(tag: &str) -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir()
                .join(format!("plisto_replace_{tag}_{}_{n}", std::process::id()));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            Self { path }
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn text(units: &[u16]) -> String {
        String::from_utf16(units).unwrap()
    }

    // Source, temp and backup names in `dir`, with the source and temp written.
    fn trio(dir: &Path) -> (PathBuf, PathBuf, PathBuf) {
        let s = dir.join("01 - Song.opus");
        let t = dir.join(".plisto-tmp-0123456789abcdef-01 - Song.opus");
        let b = dir.join(".plisto-tmp-bak-0123456789abcdef-01 - Song.opus");
        fs::write(&s, b"original").unwrap();
        fs::write(&t, b"rewritten").unwrap();
        (s, t, b)
    }

    #[test]
    fn a_replace_keeps_the_creation_time_and_the_original_under_the_backup() {
        let dir = TempDir::new("keep");
        let (s, t, b) = trio(&dir.path);
        let created = UNIX_EPOCH + Duration::from_secs(1_500_000_000);
        File::options()
            .write(true)
            .open(&s)
            .unwrap()
            .set_times(FileTimes::new().set_created(created))
            .unwrap();

        assert_eq!(replace(&s, &t, &b).unwrap(), ReplaceOutcome::Replaced);
        assert_eq!(fs::read(&s).unwrap(), b"rewritten");
        assert_eq!(fs::read(&b).unwrap(), b"original");
        assert!(!t.exists());
        assert_eq!(fs::metadata(&s).unwrap().created().unwrap(), created);
        sync_path(&s).unwrap();
    }

    #[test]
    fn a_source_held_without_share_delete_is_retried_then_fails_typed() {
        let dir = TempDir::new("held");
        let (s, t, b) = trio(&dir.path);
        let held = File::options()
            .read(true)
            .share_mode(SHARE_READ)
            .open(&s)
            .unwrap();

        let started = Instant::now();
        let outcome = replace(&s, &t, &b).unwrap();
        assert!(
            started.elapsed() >= RETRY_DELAY * (ATTEMPTS - 1),
            "the held file was not retried"
        );
        let ReplaceOutcome::Failed { code } = outcome else {
            panic!("{outcome:?}");
        };
        assert!(HELD_CODES.iter().any(|c| c.0 == code), "{code}");
        drop(held);
        assert_eq!(fs::read(&s).unwrap(), b"original");
        assert_eq!(fs::read(&t).unwrap(), b"rewritten");
        assert!(!b.exists());
    }

    #[test]
    fn a_path_past_max_path_is_replaced_hidden_and_measured() {
        let dir = TempDir::new("long");
        let mut deep = dir.path.clone();
        while deep.as_os_str().len() < 300 {
            deep.push("a folder name long enough to pass the limit");
        }
        fs::create_dir_all(&deep).unwrap();
        let (s, t, b) = trio(&deep);
        assert!(b.as_os_str().len() > 260);

        assert_eq!(replace(&s, &t, &b).unwrap(), ReplaceOutcome::Replaced);
        set_hidden(&b).unwrap();
        assert!(is_hidden(&b).unwrap());
        clear_hidden(&b).unwrap();
        assert!(!is_hidden(&b).unwrap());
        sync_path(&s).unwrap();
        assert!(free_space(&deep).unwrap() > 0);
    }

    #[test]
    fn a_missing_temp_fails_and_leaves_the_source() {
        let dir = TempDir::new("missing");
        let (s, t, b) = trio(&dir.path);
        fs::remove_file(&t).unwrap();
        assert!(matches!(
            replace(&s, &t, &b).unwrap(),
            ReplaceOutcome::Failed { .. }
        ));
        assert_eq!(fs::read(&s).unwrap(), b"original");
        assert!(!b.exists());
    }

    #[test]
    fn the_replace_errors_map_to_what_stays_on_disk() {
        assert_eq!(outcome(1175), ReplaceOutcome::NothingMoved { code: 1175 });
        assert_eq!(outcome(1176), ReplaceOutcome::NothingMoved { code: 1176 });
        assert_eq!(outcome(1177), ReplaceOutcome::OriginalAtBackup);
        assert_eq!(outcome(32), ReplaceOutcome::Failed { code: 32 });
        assert_eq!(outcome(5), ReplaceOutcome::Failed { code: 5 });
    }

    #[test]
    fn paths_become_verbatim() {
        let v = |p: &str| text(&verbatim_units(Path::new(p)).unwrap());
        assert_eq!(v(r"C:\Music\a.flac"), r"\\?\C:\Music\a.flac");
        assert_eq!(v("C:/Music/x/../a.flac"), r"\\?\C:\Music\a.flac");
        assert_eq!(v(r"\\nas\share\a.flac"), r"\\?\UNC\nas\share\a.flac");
        assert_eq!(v(r"\\?\C:\Music\a.flac"), r"\\?\C:\Music\a.flac");
        let nul = verbatim(Path::new(r"C:\a")).unwrap();
        assert_eq!(nul.last(), Some(&0));
    }
}
