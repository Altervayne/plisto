/*
 * The plain-text `boot.log` in the app data folder: a start line per launch and one line per startup
 * read that failed, timed out, arrived late or recovered, so a report of an empty library comes with
 * evidence. Rotates into a single `.old` beside it. Best-effort: a write failure is dropped.
 */

// -- Library Imports --
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

// -- Local Imports --
use crate::applog::{append_line, sanitize};

const LOG_FILE: &str = "boot.log";
const LOG_OLD_FILE: &str = "boot.log.old";
const ROTATE_BYTES: u64 = 262_144;

/// The most bytes of caller error text one line keeps.
pub const MAX_ERROR_BYTES: usize = 512;

/// Where the log lives and when the process started, managed so a command can reach both without the
/// database lock.
pub struct BootLog {
    dir: PathBuf,
    started: Instant,
}

impl BootLog {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            started: Instant::now(),
        }
    }

    /// Writes the line that places the reads below it: app version and build kind.
    pub fn log_start(&self) {
        write_line(&self.dir, &start_line(now_ms()));
    }

    /// Writes one startup-read line, stamped now, with the uptime read here.
    pub fn log_read(&self, read: &str, outcome: &str, attempt: u32, elapsed_ms: u64, error: &str) {
        let uptime_ms = self.started.elapsed().as_millis() as u64;
        let line = read_line(now_ms(), read, outcome, attempt, elapsed_ms, uptime_ms, error);
        write_line(&self.dir, &line);
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

fn write_line(dir: &Path, line: &str) {
    let _ = append_line(
        &dir.join(LOG_FILE),
        &dir.join(LOG_OLD_FILE),
        line,
        ROTATE_BYTES,
    );
}

fn build_kind() -> &'static str {
    if cfg!(debug_assertions) {
        "debug"
    } else if cfg!(feature = "diagnostic") {
        "release+diagnostic"
    } else {
        "release"
    }
}

/// `<unix_ms> START version=<v> build=<kind>`, newline last.
fn start_line(now_ms: u64) -> String {
    let (mut line, _) = sanitize(&format!(
        "{now_ms} START version={} build={}",
        env!("CARGO_PKG_VERSION"),
        build_kind()
    ));
    line.push('\n');
    line
}

/// Cuts `text` to at most `max` bytes at a character boundary.
fn cap(text: &str, max: usize) -> &str {
    let mut end = text.len().min(max);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// `<unix_ms> BOOTREAD <read> <outcome> attempt=<n> elapsed_ms=<n> uptime_ms=<n> | <error>`, newline last.
fn read_line(
    now_ms: u64,
    read: &str,
    outcome: &str,
    attempt: u32,
    elapsed_ms: u64,
    uptime_ms: u64,
    error: &str,
) -> String {
    let raw = format!(
        "{now_ms} BOOTREAD {read} {outcome} attempt={attempt} elapsed_ms={elapsed_ms} uptime_ms={uptime_ms} | {}",
        cap(error, MAX_ERROR_BYTES)
    );
    let (mut line, _) = sanitize(&raw);
    line.push('\n');
    line
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU32, Ordering};

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

    #[test]
    fn a_read_line_has_the_documented_layout() {
        let line = read_line(1_700_000_000_123, "tracks", "failed", 2, 31, 4500, "boom");
        assert_eq!(
            line,
            "1700000000123 BOOTREAD tracks failed attempt=2 elapsed_ms=31 uptime_ms=4500 | boom\n"
        );
    }

    #[test]
    fn the_start_line_names_the_version_and_build() {
        let line = start_line(7);
        assert!(line.starts_with(&format!(
            "7 START version={} build=",
            env!("CARGO_PKG_VERSION")
        )));
        assert!(line.ends_with('\n'));
    }

    #[test]
    fn error_text_is_capped_on_a_character_boundary() {
        let long = "\u{e9}".repeat(1000);
        let line = read_line(1, "roots", "late", 1, 1, 1, &long);
        let tail = line.split(" | ").nth(1).unwrap().trim_end();
        assert_eq!(tail.len(), MAX_ERROR_BYTES);
        assert_eq!(cap("a\u{e9}", 2), "a");
    }

    #[test]
    fn a_newline_or_control_character_stays_on_one_line() {
        let line = read_line(1, "roots", "failed", 1, 1, 1, "x\r\ny\u{0}z");
        assert_eq!(line.matches('\n').count(), 1);
        assert!(line.ends_with(" | x  y z\n"));
    }

    #[test]
    fn lines_append_and_the_log_rotates_into_one_old_file() {
        let dir = temp_dir("boot_log");
        let log = BootLog::new(dir.clone());
        log.log_start();
        log.log_read("roots", "failed", 1, 5, "e");
        let text = fs::read_to_string(dir.join("boot.log")).unwrap();
        assert_eq!(text.lines().count(), 2);
        assert!(text
            .lines()
            .nth(1)
            .unwrap()
            .contains(" BOOTREAD roots failed attempt=1 elapsed_ms=5 uptime_ms="));

        fs::write(dir.join("boot.log"), vec![b'a'; ROTATE_BYTES as usize]).unwrap();
        log.log_read("tracks", "late", 3, 9, "");
        let text = fs::read_to_string(dir.join("boot.log")).unwrap();
        assert_eq!(text.lines().count(), 1);
        assert_eq!(
            fs::metadata(dir.join("boot.log.old")).unwrap().len(),
            ROTATE_BYTES
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_folder_drops_the_write_without_failing() {
        let dir = temp_dir("boot_log_gone");
        let _ = fs::remove_dir_all(&dir);
        BootLog::new(dir).log_read("roots", "failed", 1, 1, "e");
    }
}
