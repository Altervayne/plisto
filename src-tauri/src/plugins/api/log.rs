/*
 * `log.write`: one line per call appended to the plugin's own `plugin.log`, with a single rotated
 * file beside it. Text is flattened to one line and capped, so a plugin cannot forge a line or grow
 * the file without bound. Plisto's own lines about a plugin use the `HOST` level, which no call can
 * write. Callers hold the plugin's log gate around every append.
 */

// -- Library Imports --
#[cfg(test)]
use std::fs;
use std::io;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};

// -- Local Imports --
use super::error::ApiError;
use super::files::ensure_data_dir;
use super::rate::RateClass;
use super::{CallCtx, MethodSpec, Need, Outcome};
use crate::applog::{append_line, sanitize};
use crate::plugins::paths::{log_file, log_old_file};

#[cfg(test)]
use crate::applog::MAX_LINE_BYTES;
pub const ROTATE_BYTES: u64 = 262_144;

pub(super) const METHODS: &[MethodSpec] = &[MethodSpec {
    name: "log.write",
    need: Need::Ambient,
    class: RateClass::Log,
    run: write,
}];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Debug,
    Info,
    Warn,
    Error,
    Host,
}

impl Level {
    /// The levels a plugin may write.
    fn from_call(name: &str) -> Option<Level> {
        match name {
            "debug" => Some(Level::Debug),
            "info" => Some(Level::Info),
            "warn" => Some(Level::Warn),
            "error" => Some(Level::Error),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Level::Debug => "DEBUG",
            Level::Info => "INFO",
            Level::Warn => "WARN",
            Level::Error => "ERROR",
            Level::Host => "HOST",
        }
    }
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// Appends one line to the plugin's log, rotating first when the line would take the file past
/// `ROTATE_BYTES`. Returns whether the text was cut.
pub fn append(
    app_data: &Path,
    id: &str,
    level: Level,
    text: &str,
    now_ms: u64,
) -> io::Result<bool> {
    ensure_data_dir(app_data, id)?;
    let (text, truncated) = sanitize(text);
    let line = format!("{now_ms} {} {text}\n", level.as_str());
    append_line(
        &log_file(app_data, id),
        &log_old_file(app_data, id),
        &line,
        ROTATE_BYTES,
    )?;
    Ok(truncated)
}

/// Writes a `HOST` line about the plugin, stamped now.
pub fn host_line(app_data: &Path, id: &str, text: &str) -> io::Result<()> {
    append(app_data, id, Level::Host, text, unix_ms()).map(|_| ())
}

fn write(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Outcome {
    Outcome::Done(write_line(ctx, args))
}

fn write_line(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Result<Value, ApiError> {
    let level = args
        .get("level")
        .and_then(Value::as_str)
        .and_then(Level::from_call)
        .ok_or_else(|| {
            ApiError::invalid_args("'level' must be one of debug, info, warn, error.")
        })?;
    let text = args
        .get("text")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::invalid_args("'text' must be a string."))?;
    let gates = ctx.api.gates(ctx.id);
    let _held = gates
        .log
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    // A disable or uninstall may have landed while this call waited for the gate.
    if !ctx.enabled.contains(ctx.id) {
        return Err(ApiError::unavailable());
    }
    let truncated = append(ctx.app_data, ctx.id, level, text, unix_ms())
        .map_err(|_| ApiError::unavailable())?;
    Ok(json!({ "truncated": truncated }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::api::error::ApiCode;
    use crate::plugins::api::files::tests::link_dir;
    use crate::plugins::api::{test_ctx, FakeHost};
    use crate::plugins::paths::data_dir;
    use crate::plugins::stage::Temp;
    use crate::plugins::state::EnabledSet;

    const ID: &str = "com.example.demo";

    fn read(path: &Path) -> String {
        fs::read_to_string(path).unwrap()
    }

    #[test]
    fn control_characters_and_line_separators_become_spaces() {
        assert_eq!(
            sanitize("a\nb\r\nc\td\u{0}e\u{7F}f\u{2028}g\u{2029}h"),
            ("a b  c d e f g h".to_string(), false)
        );
        // Other characters, including non-ASCII, are kept.
        assert_eq!(
            sanitize("caf\u{e9} \u{2014}"),
            ("caf\u{e9} \u{2014}".to_string(), false)
        );
    }

    #[test]
    fn long_text_is_cut_at_a_character_boundary() {
        let exact = "a".repeat(MAX_LINE_BYTES);
        assert_eq!(sanitize(&exact), (exact.clone(), false));
        let over = "a".repeat(MAX_LINE_BYTES + 1);
        assert_eq!(sanitize(&over), (exact, true));
        // 2047 ASCII bytes then a two-byte character: it does not fit, so it is dropped whole.
        let split = format!("{}\u{e9}", "a".repeat(MAX_LINE_BYTES - 1));
        let (cut, truncated) = sanitize(&split);
        assert!(truncated);
        assert_eq!(cut.len(), MAX_LINE_BYTES - 1);
    }

    #[test]
    fn lines_have_the_timestamp_level_and_text() {
        let t = Temp::new("api-log");
        assert!(!append(&t.0, ID, Level::Info, "hello\nthere", 1_700_000_000_123).unwrap());
        host_line(&t.0, ID, "storage reset").unwrap();
        let text = read(&log_file(&t.0, ID));
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines[0], "1700000000123 INFO hello there");
        let (stamp, rest) = lines[1].split_once(' ').unwrap();
        assert!(stamp.parse::<u64>().unwrap() > 0);
        assert_eq!(rest, "HOST storage reset");
        assert!(text.ends_with('\n'));
    }

    #[test]
    fn the_log_rotates_before_passing_the_cap_and_keeps_one_old_file() {
        let t = Temp::new("api-log");
        let path = log_file(&t.0, ID);
        let old = log_old_file(&t.0, ID);
        ensure_data_dir(&t.0, ID).unwrap();
        // "1 INFO x\n" is 9 bytes: a file 9 short of the cap takes it exactly.
        fs::write(&path, vec![b'a'; ROTATE_BYTES as usize - 9]).unwrap();
        append(&t.0, ID, Level::Info, "x", 1).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().len(), ROTATE_BYTES);
        assert!(!old.exists());
        // One more byte would pass it: the file moves to `.1` and a new one starts.
        append(&t.0, ID, Level::Info, "y", 2).unwrap();
        assert_eq!(read(&path), "2 INFO y\n");
        assert_eq!(fs::metadata(&old).unwrap().len(), ROTATE_BYTES);
        // The next rotation replaces `.1`.
        fs::write(&path, vec![b'b'; ROTATE_BYTES as usize]).unwrap();
        append(&t.0, ID, Level::Info, "z", 3).unwrap();
        assert_eq!(read(&path), "3 INFO z\n");
        assert!(read(&old).starts_with('b'));
        let names = fs::read_dir(data_dir(&t.0, ID)).unwrap().count();
        assert_eq!(names, 2);
    }

    #[test]
    fn the_call_writes_and_reports_truncation() {
        let t = Temp::new("api-log");
        let host = FakeHost::default();
        let ctx = test_ctx(&t.0, &host);
        let args = |level: &str, text: &str| {
            json!({ "level": level, "text": text })
                .as_object()
                .unwrap()
                .clone()
        };
        assert_eq!(
            write_line(&ctx.ctx(), &args("warn", "careful")),
            Ok(json!({ "truncated": false }))
        );
        let long = "x".repeat(MAX_LINE_BYTES + 5);
        assert_eq!(
            write_line(&ctx.ctx(), &args("error", &long)),
            Ok(json!({ "truncated": true }))
        );
        let text = read(&log_file(&t.0, ID));
        assert!(text.lines().next().unwrap().ends_with(" WARN careful"));
        assert!(text.lines().nth(1).unwrap().contains(" ERROR x"));
    }

    #[test]
    fn a_plugin_that_stopped_serving_is_answered_unavailable_and_leaves_no_folder() {
        let t = Temp::new("api-log");
        let host = FakeHost::default();
        let mut ctx = test_ctx(&t.0, &host);
        ctx.enabled = EnabledSet::default();
        let args = json!({ "level": "info", "text": "x" });
        let error = write_line(&ctx.ctx(), args.as_object().unwrap()).unwrap_err();
        assert_eq!(error, ApiError::unavailable());
        assert!(!data_dir(&t.0, ID).exists());
    }

    #[test]
    fn an_unknown_level_or_missing_text_is_refused() {
        let t = Temp::new("api-log");
        let host = FakeHost::default();
        let ctx = test_ctx(&t.0, &host);
        for args in [
            json!({ "level": "host", "text": "forged" }),
            json!({ "level": "HOST", "text": "forged" }),
            json!({ "level": "INFO", "text": "x" }),
            json!({ "level": "fatal", "text": "x" }),
            json!({ "text": "x" }),
            json!({ "level": "info" }),
            json!({ "level": "info", "text": 5 }),
            json!({ "level": 1, "text": "x" }),
        ] {
            let error = write_line(&ctx.ctx(), args.as_object().unwrap()).unwrap_err();
            assert_eq!(error.code, ApiCode::InvalidArgs, "{args}");
        }
        assert!(!log_file(&t.0, ID).exists());
    }

    #[test]
    fn a_junctioned_data_folder_answers_unavailable() {
        let t = Temp::new("api-log");
        let elsewhere = t.0.join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        let dir = data_dir(&t.0, ID);
        fs::create_dir_all(dir.parent().unwrap()).unwrap();
        if !link_dir(&dir, &elsewhere) {
            eprintln!("skipped: cannot create a junction here");
            return;
        }
        let host = FakeHost::default();
        let ctx = test_ctx(&t.0, &host);
        let args = json!({ "level": "info", "text": "x" });
        let error = write_line(&ctx.ctx(), args.as_object().unwrap()).unwrap_err();
        assert_eq!(error, ApiError::unavailable());
        assert_eq!(fs::read_dir(&elsewhere).unwrap().count(), 0);
    }
}
