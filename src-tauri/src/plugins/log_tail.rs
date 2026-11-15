/*
 * The end of a plugin's logs, for the developer-mode panel. A file is read from its end and never whole:
 * at most `MAX_BYTES` are taken, cut at a line boundary, so a huge file or one enormous line costs a
 * bounded read. A file that is missing, not a plain file or a link reads as no lines.
 */

// -- Library Imports --
use std::fs;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;

use serde::Serialize;

// -- Local Imports --
use super::frame_host::is_reparse_point;
use super::install_error::{ErrorCode, InstallError};
use super::manifest::Tier;
use super::paths::{data_dir, log_file, stderr_log_path, validate_id};
use super::state::PluginsState;
use super::update::not_installed;

/// Lines returned per file.
pub const MAX_LINES: usize = 200;

/// Bytes read per file.
pub const MAX_BYTES: u64 = 64 * 1024;

/// The tails of one plugin's logs. `stderr` is None for a plugin with no process of its own.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LogTail {
    pub plugin: Vec<String>,
    pub stderr: Option<Vec<String>>,
}

/// The last lines of `plugin.log` and, for a native plugin, of `stderr.log`.
pub fn log_tail(
    app_data: &Path,
    plugins: &PluginsState,
    id: &str,
) -> Result<LogTail, InstallError> {
    validate_id(id).map_err(|why| {
        InstallError::new(
            ErrorCode::NotFound,
            format!("{id} is not a plugin id: {why}"),
        )
    })?;
    let tier = plugins
        .snapshot()
        .entry(id)
        .ok_or_else(|| not_installed(id))?
        .tier;
    let read = |path: &Path| {
        tail_file(path, MAX_LINES, MAX_BYTES)
            .map_err(|e| InstallError::io("cannot read the log", e))
    };
    let plugin = read(&log_file(app_data, id))?;
    let stderr = match tier {
        Tier::Native => Some(read(&stderr_log_path(&data_dir(app_data, id)))?),
        Tier::Ui => None,
    };
    Ok(LogTail { plugin, stderr })
}

/// Up to `max_lines` last lines of the file, from at most `max_bytes` of its end, with invalid UTF-8
/// replaced.
fn tail_file(path: &Path, max_lines: usize, max_bytes: u64) -> io::Result<Vec<String>> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    if !meta.is_file() || is_reparse_point(&meta) {
        return Ok(Vec::new());
    }
    let mut file = fs::File::open(path)?;
    let start = file.metadata()?.len().saturating_sub(max_bytes);
    // One byte before the cut tells whether the cut landed on a line start.
    let from = start.saturating_sub(1);
    file.seek(SeekFrom::Start(from))?;
    let mut bytes = Vec::new();
    file.take(max_bytes + (start - from))
        .read_to_end(&mut bytes)?;
    let cut_front = start > 0 && bytes.first() != Some(&b'\n');
    let body = if start > 0 {
        &bytes[1.min(bytes.len())..]
    } else {
        &bytes[..]
    };
    Ok(last_lines(body, cut_front, max_lines))
}

/// The last `max_lines` lines of `bytes`. When `cut_front`, the first line may be partial and is
/// dropped, unless it is all there is: the end of one enormous line is still worth showing.
fn last_lines(bytes: &[u8], cut_front: bool, max_lines: usize) -> Vec<String> {
    let whole = match bytes.iter().position(|b| *b == b'\n') {
        Some(at) if cut_front && at + 1 < bytes.len() => &bytes[at + 1..],
        _ => bytes,
    };
    let mut lines: Vec<&[u8]> = whole.split(|b| *b == b'\n').collect();
    if lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }
    let skip = lines.len().saturating_sub(max_lines);
    lines[skip..]
        .iter()
        .map(|line| {
            let line = line.strip_suffix(b"\r").unwrap_or(line);
            String::from_utf8_lossy(line).into_owned()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::stage::Temp;
    use crate::plugins::test_kit::{native, ui, Kit, ID};

    fn file_with(t: &Temp, bytes: &[u8]) -> std::path::PathBuf {
        let path = t.0.join("plugin.log");
        fs::create_dir_all(&t.0).unwrap();
        fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn a_missing_file_has_no_lines() {
        let t = Temp::new("logtail");
        assert!(tail_file(&t.0.join("nope.log"), 10, 1024)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn a_short_file_comes_back_whole_with_or_without_a_final_newline() {
        let t = Temp::new("logtail");
        let with = file_with(&t, b"one\r\ntwo\nthree\n");
        assert_eq!(tail_file(&with, 10, 1024).unwrap(), ["one", "two", "three"]);
        let without = file_with(&t, b"one\ntwo\nthree");
        assert_eq!(
            tail_file(&without, 10, 1024).unwrap(),
            ["one", "two", "three"]
        );
        let empty = file_with(&t, b"");
        assert!(tail_file(&empty, 10, 1024).unwrap().is_empty());
    }

    #[test]
    fn only_the_last_lines_are_kept_in_order() {
        let t = Temp::new("logtail");
        let text: String = (1..=500).map(|n| format!("line {n}\n")).collect();
        let path = file_with(&t, text.as_bytes());
        let lines = tail_file(&path, MAX_LINES, MAX_BYTES).unwrap();
        assert_eq!(lines.len(), MAX_LINES);
        assert_eq!(lines[0], "line 301");
        assert_eq!(lines[MAX_LINES - 1], "line 500");
    }

    #[test]
    fn the_byte_cap_bounds_the_read_and_cuts_at_a_line_boundary() {
        let t = Temp::new("logtail");
        let text: String = (1..=5000).map(|n| format!("line {n:05}\n")).collect();
        let path = file_with(&t, text.as_bytes());
        let lines = tail_file(&path, 10_000, 1000).unwrap();
        assert!(lines.iter().map(|l| l.len() + 1).sum::<usize>() <= 1000);
        assert_eq!(lines.last().unwrap(), "line 05000");
        // The first line kept is whole, never the tail of a cut one.
        assert!(lines
            .iter()
            .all(|l| l.len() == "line 00001".len() && l.starts_with("line ")));
        assert!(lines.len() > 70, "{}", lines.len());
    }

    #[test]
    fn a_cut_exactly_on_a_line_start_keeps_the_first_line() {
        let t = Temp::new("logtail");
        // Ten 10-byte lines; a 50-byte cap starts the read exactly on line 6.
        let text: String = (1..=10).map(|n| format!("line {n:04}\n")).collect();
        assert_eq!(text.len(), 100);
        let path = file_with(&t, text.as_bytes());
        let lines = tail_file(&path, 200, 50).unwrap();
        assert_eq!(
            lines,
            [
                "line 0006",
                "line 0007",
                "line 0008",
                "line 0009",
                "line 0010"
            ]
        );
        // One byte off the boundary, the partial first line is dropped.
        let lines = tail_file(&path, 200, 49).unwrap();
        assert_eq!(lines.first().unwrap(), "line 0007");
    }

    #[test]
    fn one_over_long_line_is_capped_not_read_whole() {
        let t = Temp::new("logtail");
        let mut huge = "x".repeat(100_000).into_bytes();
        let path = file_with(&t, &huge);
        let lines = tail_file(&path, 200, 1024).unwrap();
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].len(), 1024);
        // The same line ended by a newline still shows its end.
        huge.push(b'\n');
        let path = file_with(&t, &huge);
        let lines = tail_file(&path, 200, 1024).unwrap();
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].len(), 1023);
        // Short lines after the long one stand alone; the cut line is dropped.
        huge.extend_from_slice(b"after\n");
        let path = file_with(&t, &huge);
        assert_eq!(tail_file(&path, 200, 1024).unwrap(), ["after"]);
    }

    #[test]
    fn invalid_utf8_is_replaced() {
        let t = Temp::new("logtail");
        let path = file_with(&t, b"ok\n\xff\xfe bad\n");
        let lines = tail_file(&path, 10, 1024).unwrap();
        assert_eq!(lines[0], "ok");
        assert!(lines[1].contains('\u{fffd}') && lines[1].ends_with(" bad"));
    }

    #[test]
    fn a_folder_where_the_log_belongs_has_no_lines() {
        let t = Temp::new("logtail");
        fs::create_dir_all(t.0.join("plugin.log")).unwrap();
        assert!(tail_file(&t.0.join("plugin.log"), 10, 1024)
            .unwrap()
            .is_empty());
    }

    fn write_logs(k: &Kit, plugin: &str, stderr: &str) {
        let dir = data_dir(&k.data, ID);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("plugin.log"), plugin).unwrap();
        fs::write(dir.join("stderr.log"), stderr).unwrap();
    }

    #[test]
    fn a_native_plugin_returns_both_logs_and_a_ui_plugin_only_its_own() {
        let k = Kit::new();
        k.install(&native("1.0.0", &[]));
        write_logs(&k, "from plugin\n", "from stderr\n");
        let tail = log_tail(&k.data, &k.plugins, ID).unwrap();
        assert_eq!(tail.plugin, ["from plugin"]);
        assert_eq!(
            tail.stderr.as_deref(),
            Some(&["from stderr".to_string()][..])
        );

        let k = Kit::new();
        k.install(&ui("1.0.0", &[]));
        write_logs(&k, "from plugin\n", "never shown\n");
        let tail = log_tail(&k.data, &k.plugins, ID).unwrap();
        assert_eq!(tail.plugin, ["from plugin"]);
        assert_eq!(tail.stderr, None);
    }

    #[test]
    fn a_plugin_that_wrote_nothing_has_empty_logs() {
        let k = Kit::new();
        k.install(&native("1.0.0", &[]));
        let tail = log_tail(&k.data, &k.plugins, ID).unwrap();
        assert!(tail.plugin.is_empty());
        assert_eq!(tail.stderr, Some(Vec::new()));
    }

    #[test]
    fn an_invalid_or_unknown_id_is_refused() {
        let k = Kit::new();
        for id in ["../escape", "C:\\Windows", "", "Not.Valid"] {
            assert_eq!(
                log_tail(&k.data, &k.plugins, id).unwrap_err().code,
                ErrorCode::NotFound
            );
        }
        let err = log_tail(&k.data, &k.plugins, "com.example.never").unwrap_err();
        assert_eq!(err.code, ErrorCode::NotInstalled);
    }
}
