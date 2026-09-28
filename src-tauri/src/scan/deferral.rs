/*
 * Half-copied file detection. A file still being written is either held open for writing by the
 * copier (a sharing violation on a read-only, share-read open) or changes size or mtime while its
 * tags are read. Either way the scan defers it instead of indexing a torn read: no row, no error, and
 * it is not taken as missing. A file stuck in that state past the deferral limit is read anyway, so
 * a handle left open forever never hides a track for good.
 */

// -- Library Imports --
use std::path::Path;

/// How long a file may stay deferred, in seconds, before it is read regardless.
const DEFER_LIMIT_SECS: i64 = 600;

/// What the scan does with one file once its stability is known.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadDecision {
    Read,
    Defer,
    ForceRead,
}

/// Decides a file's fate. `locked` is a sharing violation on the probe open; `before` and `after` are
/// the (size, mtime) around the tag read, `after` None when the file vanished or was never read.
/// `deferred_since` is when the file was first deferred, in unix seconds, and `now` the pass clock.
pub fn read_decision(
    locked: bool,
    before: (i64, i64),
    after: Option<(i64, i64)>,
    deferred_since: Option<i64>,
    now: i64,
) -> ReadDecision {
    if !locked && after == Some(before) {
        return ReadDecision::Read;
    }
    match deferred_since {
        Some(since) if now - since > DEFER_LIMIT_SECS => ReadDecision::ForceRead,
        _ => ReadDecision::Defer,
    }
}

/// Whether another process holds `path` open for writing. Opens it read-only while sharing only
/// reads, which the OS refuses with a sharing violation while a writer has it. Any other open failure
/// is left to the tag reader to report.
#[cfg(windows)]
pub fn share_locked(path: &Path) -> bool {
    use std::os::windows::fs::OpenOptionsExt;

    const FILE_SHARE_READ: u32 = 0x1;
    const ERROR_SHARING_VIOLATION: i32 = 32;
    match std::fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .open(path)
    {
        Ok(_) => false,
        Err(e) => e.raw_os_error() == Some(ERROR_SHARING_VIOLATION),
    }
}

/// Share modes are a Windows notion; elsewhere only the stat comparison guards a torn read.
#[cfg(not(windows))]
pub fn share_locked(_path: &Path) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    const STAT: (i64, i64) = (1000, 50);

    #[test]
    fn a_stable_unlocked_file_is_read() {
        assert_eq!(
            read_decision(false, STAT, Some(STAT), None, 100),
            ReadDecision::Read
        );
        // A stable read clears any earlier deferral.
        assert_eq!(
            read_decision(false, STAT, Some(STAT), Some(0), 100),
            ReadDecision::Read
        );
    }

    #[test]
    fn a_locked_file_is_deferred() {
        assert_eq!(
            read_decision(true, STAT, None, None, 100),
            ReadDecision::Defer
        );
    }

    #[test]
    fn a_file_that_changes_across_the_read_is_deferred() {
        assert_eq!(
            read_decision(false, STAT, Some((2000, 50)), None, 100),
            ReadDecision::Defer
        );
        assert_eq!(
            read_decision(false, STAT, Some((1000, 51)), None, 100),
            ReadDecision::Defer
        );
        assert_eq!(
            read_decision(false, STAT, None, None, 100),
            ReadDecision::Defer,
            "a file gone by the second stat is not indexed",
        );
    }

    #[test]
    fn a_file_deferred_past_the_limit_is_read_anyway() {
        let since = 1_000;
        assert_eq!(
            read_decision(true, STAT, None, Some(since), since + DEFER_LIMIT_SECS),
            ReadDecision::Defer,
            "exactly at the limit it still waits",
        );
        assert_eq!(
            read_decision(true, STAT, None, Some(since), since + DEFER_LIMIT_SECS + 1),
            ReadDecision::ForceRead
        );
        assert_eq!(
            read_decision(false, STAT, Some((5, 5)), Some(since), since + 3_600),
            ReadDecision::ForceRead
        );
    }

    #[cfg(windows)]
    #[test]
    fn an_open_writer_is_a_sharing_violation() {
        let dir = std::env::temp_dir().join(format!(
            "plisto_share_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("copying.mp3");
        let writer = std::fs::File::create(&path).unwrap();
        assert!(
            share_locked(&path),
            "a live writer blocks the share-read open"
        );
        drop(writer);
        assert!(!share_locked(&path), "a closed file opens fine");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
