/*
 * The plain-text `scan.log` in the app data folder: one line per unreadable file or folder a pass
 * found new or whose reason changed, so the file stays small and can be attached to a bug report.
 * It holds full paths and never leaves the machine. Best-effort: a write failure is dropped.
 */

// -- Library Imports --
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

// -- Local Imports --
use crate::applog::{append_line, sanitize};
use crate::db::scan_issues::DraftChange;

const LOG_FILE: &str = "scan.log";
const LOG_OLD_FILE: &str = "scan.log.old";
const ROTATE_BYTES: u64 = 262_144;

/// The log file's path inside the app data folder.
pub fn log_path(app_data: &Path) -> std::path::PathBuf {
    app_data.join(LOG_FILE)
}

/// Logs a pass's changes into the folder holding the database at `db_path`; a bare path with no
/// folder logs nothing.
pub fn log_pass(db_path: &Path, changes: &[DraftChange]) {
    if let Some(dir) = db_path.parent().filter(|d| !d.as_os_str().is_empty()) {
        log_changes(dir, changes);
    }
}

/// Appends one line per change, stamped now. Callers pass only `DraftChange` rows, which are already
/// new-or-changed, so a repeated pass has nothing to write.
pub fn log_changes(app_data: &Path, changes: &[DraftChange]) {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64);
    write_changes(app_data, changes, now_ms);
}

fn write_changes(app_data: &Path, changes: &[DraftChange], now_ms: u64) {
    let path = log_path(app_data);
    let old = app_data.join(LOG_OLD_FILE);
    for change in changes {
        let line = format_line(change, now_ms);
        if append_line(&path, &old, &line, ROTATE_BYTES).is_err() {
            return;
        }
    }
}

/// `<unix_ms> <KIND> <reason> <path> | <detail>` on one line, cut to the line cap, newline last.
fn format_line(change: &DraftChange, now_ms: u64) -> String {
    let raw = format!(
        "{now_ms} {} {} {} | {}",
        change.kind.as_str().to_uppercase(),
        change.reason.as_str(),
        change.path,
        change.detail
    );
    let (mut line, _) = sanitize(&raw);
    line.push('\n');
    line
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::scan::issues::{IssueKind, Reason};
    use crate::scan::{run_scan, ScanRoot};
    use std::collections::HashMap;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::Arc;

    fn temp_dir(tag: &str) -> PathBuf {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "plisto_{tag}_{}_{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn change(kind: IssueKind, reason: Reason, path: &str, detail: &str) -> DraftChange {
        DraftChange {
            path: path.to_string(),
            key: path.to_lowercase(),
            kind,
            reason,
            detail: detail.to_string(),
            is_new: true,
        }
    }

    #[test]
    fn each_kind_formats_as_stamp_kind_reason_path_detail() {
        let cases = [
            (
                IssueKind::Tags,
                Reason::CorruptOrUnsupported,
                "TAGS corrupt_or_unsupported",
            ),
            (IssueKind::Stat, Reason::AccessDenied, "STAT access_denied"),
            (IssueKind::Folder, Reason::DiskError, "FOLDER disk_error"),
        ];
        for (kind, reason, head) in cases {
            let line = format_line(
                &change(kind, reason, "C:\\m\\a.mp3", "boom"),
                1_700_000_000_123,
            );
            assert_eq!(line, format!("1700000000123 {head} C:\\m\\a.mp3 | boom\n"));
        }
    }

    #[test]
    fn a_newline_or_control_character_stays_on_one_line() {
        let line = format_line(
            &change(
                IssueKind::Stat,
                Reason::Other,
                "C:\\m\\a\nb.mp3",
                "x\r\ny\u{0}z",
            ),
            1,
        );
        assert_eq!(line.matches('\n').count(), 1);
        assert!(line.ends_with('\n'));
        assert_eq!(line, "1 STAT other C:\\m\\a b.mp3 | x  y z\n");
    }

    #[test]
    fn a_long_line_is_capped_on_a_character_boundary() {
        let path = format!("/m/{}", "\u{e9}".repeat(3000));
        let line = format_line(&change(IssueKind::Tags, Reason::Other, &path, "d"), 1);
        let text = line.strip_suffix('\n').unwrap();
        assert!(text.len() <= 2048);
        assert!(text.len() >= 2046);
        assert!(text.starts_with("1 TAGS other /m/"));
    }

    #[test]
    fn lines_append_and_the_log_rotates_into_one_old_file() {
        let dir = temp_dir("scan_log");
        let c = change(IssueKind::Stat, Reason::Other, "/m/a.mp3", "boom");
        write_changes(&dir, &[c.clone(), c.clone()], 5);
        let text = fs::read_to_string(dir.join("scan.log")).unwrap();
        assert_eq!(text.lines().count(), 2);

        fs::write(dir.join("scan.log"), vec![b'a'; ROTATE_BYTES as usize]).unwrap();
        write_changes(&dir, &[c], 6);
        assert_eq!(
            fs::read_to_string(dir.join("scan.log")).unwrap(),
            "6 STAT other /m/a.mp3 | boom\n"
        );
        assert_eq!(
            fs::metadata(dir.join("scan.log.old")).unwrap().len(),
            ROTATE_BYTES
        );
        let mut names: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, ["scan.log", "scan.log.old"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_repeated_scan_of_the_same_failure_logs_it_once() {
        let dir = temp_dir("scan_log_pass");
        let music = dir.join("music");
        fs::create_dir_all(&music).unwrap();
        fs::write(music.join("a.m4a"), b"this is not audio").unwrap();
        let db_path = dir.join("plisto.sqlite");
        let conn = db::open_db(&db_path).unwrap();
        let (root_id, _) = db::get_or_create_root(&conn, &music.to_string_lossy(), 1).unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        for at in [1000, 2000] {
            let root = ScanRoot {
                id: root_id,
                path: music.clone(),
                units: None,
            };
            run_scan(&[root], &db_path, &cancel, at, &HashMap::new(), |_| {}).unwrap();
        }

        let text = fs::read_to_string(dir.join("scan.log")).unwrap();
        assert_eq!(text.lines().count(), 1);
        assert!(text.contains(" TAGS corrupt_or_unsupported "));
        assert!(text.contains("a.m4a | "));
        drop(conn);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn no_changes_write_nothing() {
        let dir = temp_dir("scan_log_none");
        log_changes(&dir, &[]);
        assert!(!dir.join("scan.log").exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
