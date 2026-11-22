/*
 * The IPC command behind developer-mode feed recording: it saves a recording of the ticks a
 * visualizer frame received under `feeds/` in the plugin's data folder, where the kit harness can
 * load it. Main window only and only while developer mode is on; the plugin id and kind id are
 * validated, the text must be JSON under a fixed cap, and the write is temp-then-rename.
 */

// -- Library Imports --
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::de::IgnoredAny;
use serde::Serialize;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager, State, Webview};

// -- Local Imports --
use super::plugins::MAIN_LABEL;
use crate::plugins::dev_mode;
use crate::plugins::paths::feeds_dir;
use crate::plugins::vis_store::{check_ids, write_atomic};
use crate::state::AppState;

/// The most a saved recording may hold, in bytes.
pub const FEED_MAX_BYTES: usize = 8 * 1024 * 1024;

/// Why a save was refused; `code` is stable and snake_case, `detail` is for logs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SaveCode {
    NotMain,
    DevModeOff,
    InvalidId,
    NotInstalled,
    TooLarge,
    NotJson,
    Io,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SaveError {
    pub code: SaveCode,
    pub detail: String,
}

fn refuse(code: SaveCode, detail: impl Into<String>) -> SaveError {
    SaveError {
        code,
        detail: detail.into(),
    }
}

/// The text of request header `name`, or an error when it is missing or not text.
fn header(request: &Request<'_>, name: &str) -> Result<String, SaveError> {
    request
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .ok_or_else(|| refuse(SaveCode::InvalidId, format!("missing header {name}")))
}

/// Saves a feed recording and returns the file's path. The recording is the raw request body, whose
/// length is checked before anything reads it; the plugin id and its kind id travel as the
/// `x-vis-id` and `x-vis-kind` headers.
#[tauri::command]
pub async fn plugin_vis_record_save(
    request: Request<'_>,
    webview: Webview,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, SaveError> {
    guard(webview.label(), dev_mode::is_on(&state.plugins))?;
    let InvokeBody::Raw(body) = request.body() else {
        return Err(refuse(SaveCode::NotJson, "the request must be raw bytes"));
    };
    if body.len() > FEED_MAX_BYTES {
        return Err(refuse(SaveCode::TooLarge, "the recording is too large"));
    }
    let body = body.clone();
    let id = header(&request, "x-vis-id")?;
    let kind_id = header(&request, "x-vis-kind")?;
    check_ids(&id, &kind_id).map_err(|e| refuse(SaveCode::InvalidId, e))?;
    if state.plugins.snapshot().entry(&id).is_none() {
        return Err(refuse(SaveCode::NotInstalled, format!("plugin {id} is not installed")));
    }
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| refuse(SaveCode::Io, format!("no app data folder: {e}")))?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let saved = tauri::async_runtime::spawn_blocking(move || {
        save_feed(&app_data, &id, &kind_id, &body, now)
    })
    .await
    .map_err(|e| refuse(SaveCode::Io, e.to_string()))??;
    Ok(saved.to_string_lossy().into_owned())
}

/// Refuses a window that is not the main one, and any call while developer mode is off.
fn guard(label: &str, dev_mode_on: bool) -> Result<(), SaveError> {
    if label != MAIN_LABEL {
        return Err(refuse(SaveCode::NotMain, "only available to the main window"));
    }
    if !dev_mode_on {
        return Err(refuse(SaveCode::DevModeOff, "developer mode is off"));
    }
    Ok(())
}

/// Writes `json` as `feeds/feed-<UTC time>-<kind>.json` under the plugin's data folder.
fn save_feed(
    app_data: &Path,
    id: &str,
    kind_id: &str,
    json: &[u8],
    unix_secs: u64,
) -> Result<PathBuf, SaveError> {
    check_ids(id, kind_id).map_err(|e| refuse(SaveCode::InvalidId, e))?;
    if json.len() > FEED_MAX_BYTES {
        return Err(refuse(SaveCode::TooLarge, "the recording is too large"));
    }
    serde_json::from_slice::<IgnoredAny>(json)
        .map_err(|_| refuse(SaveCode::NotJson, "the recording is not JSON"))?;
    let io = |e: std::io::Error| refuse(SaveCode::Io, format!("cannot save the recording: {e}"));
    let dir = feeds_dir(app_data, id);
    fs::create_dir_all(&dir).map_err(io)?;
    let path = dir.join(format!("feed-{}-{kind_id}.json", utc_stamp(unix_secs)));
    write_atomic(&path, json).map_err(io)?;
    Ok(path)
}

/// A Unix time as `YYYYMMDDTHHMMSSZ`, in UTC.
fn utc_stamp(unix_secs: u64) -> String {
    let days = (unix_secs / 86_400) as i64;
    let rest = unix_secs % 86_400;
    // Days since 0000-03-01, in 400-year eras.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}{month:02}{day:02}T{:02}{:02}{:02}Z",
        rest / 3_600,
        rest % 3_600 / 60,
        rest % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::stage::Temp;

    const ID: &str = "com.example.rings";

    #[test]
    fn only_the_main_window_may_save_and_only_in_developer_mode() {
        assert!(guard(MAIN_LABEL, true).is_ok());
        assert_eq!(guard(MAIN_LABEL, false).unwrap_err().code, SaveCode::DevModeOff);
        for label in ["tray", "nowplaying", "Main", "main ", ""] {
            assert_eq!(guard(label, true).unwrap_err().code, SaveCode::NotMain, "{label:?}");
        }
    }

    #[test]
    fn the_stamp_is_utc_with_a_padded_date() {
        assert_eq!(utc_stamp(0), "19700101T000000Z");
        assert_eq!(utc_stamp(951_782_400), "20000229T000000Z");
        assert_eq!(utc_stamp(1_700_000_000), "20231114T221320Z");
        assert_eq!(utc_stamp(4_102_444_799), "20991231T235959Z");
    }

    #[test]
    fn a_recording_lands_under_the_plugins_data_folder() {
        let data = Temp::new("feed-save");
        let path = save_feed(&data.0, ID, "aurora", br#"{"ticks":[]}"#, 1_700_000_000).unwrap();
        assert_eq!(
            path,
            data.0
                .join("plugins-data")
                .join(ID)
                .join("feeds")
                .join("feed-20231114T221320Z-aurora.json")
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), r#"{"ticks":[]}"#);
        let names: Vec<_> = fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, ["feed-20231114T221320Z-aurora.json"]);
    }

    #[test]
    fn ids_that_could_leave_the_folder_are_refused() {
        let data = Temp::new("feed-ids");
        for id in ["", "..", "../x.y", "com.example/rings", "COM.EXAMPLE.RINGS", "con.example"] {
            assert!(save_feed(&data.0, id, "aurora", b"{}", 0).is_err(), "{id:?}");
        }
        for kind in ["", "..", "../a", "a/b", "a\\b", "Aurora", "has space", &"k".repeat(25)] {
            assert!(save_feed(&data.0, ID, kind, b"{}", 0).is_err(), "{kind:?}");
        }
        assert!(!data.0.join("plugins-data").exists());
        // A refusal never carries the id it refused.
        let err = save_feed(&data.0, "../secret-id", "aurora", b"{}", 0).unwrap_err();
        assert_eq!(err.code, SaveCode::InvalidId);
        assert!(!err.detail.contains("secret"));
    }

    #[test]
    fn the_size_cap_is_exact_and_the_text_must_be_json() {
        let data = Temp::new("feed-cap");
        let pad = FEED_MAX_BYTES - "[\"\"]".len();
        let at_cap = format!("[\"{}\"]", "a".repeat(pad));
        assert_eq!(at_cap.len(), FEED_MAX_BYTES);
        assert!(save_feed(&data.0, ID, "aurora", at_cap.as_bytes(), 0).is_ok());
        let over = format!("[\"{}\"]", "a".repeat(pad + 1));
        let too_big = save_feed(&data.0, ID, "aurora", over.as_bytes(), 1).unwrap_err();
        assert_eq!(too_big.code, SaveCode::TooLarge);
        let bad = save_feed(&data.0, ID, "aurora", b"not json", 2).unwrap_err();
        assert_eq!(bad.code, SaveCode::NotJson);
        let files = fs::read_dir(feeds_dir(&data.0, ID)).unwrap().count();
        assert_eq!(files, 1);
    }
}
