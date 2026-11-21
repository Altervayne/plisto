/*
 * The IPC commands for plugin visualizers: the URL a declared kind's frame loads from its
 * plugin's visualizer host, the set of shown visualizer hosts the process watch reads, and the
 * per-plugin store of fault marks, reset trial markers and stills. Like the page frame URL, no URL
 * is handed out until the main webview's frame handler is installed, so nothing mounts a frame that
 * no one would answer.
 */

// -- Library Imports --
use std::collections::BTreeSet;
use std::path::Path;
use std::sync::atomic::Ordering;

use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager, State, Webview};

// -- Local Imports --
use super::plugins::MAIN_LABEL;
use crate::plugins::frame_host::vis_host;
use crate::plugins::{vis_process, vis_store};
use crate::state::AppState;

/// The URL visualizer `kind` of enabled plugin `id` loads from. Errors when frames are unavailable,
/// the plugin is not installed or not enabled, or it declares no such kind.
#[tauri::command]
pub fn plugin_vis_url(
    id: String,
    kind: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    if !state.frames_ready.load(Ordering::SeqCst) {
        return Err("plugin frames are unavailable".to_string());
    }
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data folder: {e}"))?;
    vis_host::kind_url(&app_data, &id, &kind, &|id| state.plugins.is_enabled(id))
        .map_err(|e| e.to_string())
}

/// Reports the set of visualizer hosts (`pv-<hash>.invalid`) whose frames are shown. The process
/// watch ends a renderer only after a valid report has arrived since it began tracking it, and
/// never while a host it served was shown at any report since its last sample. Main window only.
/// One entry that is not a visualizer host rejects the whole report and leaves the shown set
/// unknown, so nothing is ended until the next valid report.
#[tauri::command]
pub fn plugin_vis_shown(
    hosts: Vec<String>,
    webview: Webview,
    app: AppHandle,
) -> Result<(), String> {
    if webview.label() != MAIN_LABEL {
        return Err("visualizer commands are only available to the main window".to_string());
    }
    let labels = hosts
        .iter()
        .map(|host| {
            vis_process::shown_label(host).ok_or_else(|| format!("not a visualizer host: {host}"))
        })
        .collect::<Result<BTreeSet<String>, String>>();
    let labels = match labels {
        Ok(labels) => labels,
        Err(e) => {
            #[cfg(windows)]
            crate::plugins::vis_process_win::reject_shown();
            return Err(e);
        }
    };
    #[cfg(windows)]
    crate::plugins::vis_process_win::set_shown(&app, labels);
    #[cfg(not(windows))]
    let _ = (labels, app);
    Ok(())
}

// -- Store commands --

/// Runs `work` on a blocking thread with the app data folder. Only the main window may call the
/// store commands.
async fn with_store<T: Send + 'static>(
    webview: &Webview,
    app: &AppHandle,
    work: impl FnOnce(&Path) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    if webview.label() != MAIN_LABEL {
        return Err("visualizer store commands are only available to the main window".to_string());
    }
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data folder: {e}"))?;
    tauri::async_runtime::spawn_blocking(move || work(&app_data))
        .await
        .map_err(|e| e.to_string())?
}

/// Every kind of every plugin that has a fault mark or was turned back on, under its plugin's
/// current build key. One call serves the whole catalog; kinds with nothing recorded are absent.
#[tauri::command]
pub async fn plugin_vis_marks(
    webview: Webview,
    app: AppHandle,
) -> Result<Vec<vis_store::KindState>, String> {
    with_store(&webview, &app, |dir| Ok(vis_store::marks(dir))).await
}

/// Marks a kind as flashing or as having lost its graphics context.
#[tauri::command]
pub async fn plugin_vis_mark(
    id: String,
    kind: String,
    mark: vis_store::VisMark,
    webview: Webview,
    app: AppHandle,
) -> Result<(), String> {
    with_store(&webview, &app, move |dir| vis_store::set_mark(dir, &id, &kind, mark)).await
}

/// Clears a kind's fault marks and records it as turned back on under the current build key.
#[tauri::command]
pub async fn plugin_vis_clear_mark(
    id: String,
    kind: String,
    webview: Webview,
    app: AppHandle,
) -> Result<(), String> {
    with_store(&webview, &app, move |dir| vis_store::clear_mark(dir, &id, &kind)).await
}

/// Writes the reset trial marker for a kind. False when the kind already passed its trial under the
/// current build, in which case nothing is written.
#[tauri::command]
pub async fn plugin_vis_trial_begin(
    id: String,
    kind: String,
    webview: Webview,
    app: AppHandle,
) -> Result<bool, String> {
    with_store(&webview, &app, move |dir| vis_store::trial_begin(dir, &id, &kind)).await
}

/// Removes the reset trial marker for a kind. With `passed`, the kind is recorded as trialed under
/// its build; without it, the marker is only removed (the kind unmounted before the trial ended).
#[tauri::command]
pub async fn plugin_vis_trial_end(
    id: String,
    kind: String,
    passed: bool,
    webview: Webview,
    app: AppHandle,
) -> Result<(), String> {
    let work = move |dir: &Path| vis_store::trial_end(dir, &id, &kind, passed);
    with_store(&webview, &app, work).await
}

/// The text of request header `name`, or an error when it is missing or not text.
fn header(request: &Request<'_>, name: &str) -> Result<String, String> {
    request
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .ok_or_else(|| format!("missing header {name}"))
}

/// Stores a kind's still. The PNG is the raw request body and the plugin id, kind and theme travel
/// as the `x-vis-id`, `x-vis-kind` and `x-vis-theme` headers, so the bytes cross unencoded.
#[tauri::command]
pub async fn plugin_vis_thumb_put(
    request: Request<'_>,
    webview: Webview,
    app: AppHandle,
) -> Result<(), String> {
    let InvokeBody::Raw(png) = request.body() else {
        return Err("the request must be raw bytes".to_string());
    };
    if png.len() > vis_store::STILL_MAX {
        return Err("the still is too large".to_string());
    }
    let png = png.clone();
    let id = header(&request, "x-vis-id")?;
    let kind = header(&request, "x-vis-kind")?;
    let theme = header(&request, "x-vis-theme")?;
    let theme: vis_store::VisTheme = serde_json::from_value(serde_json::Value::String(theme))
        .map_err(|_| "the theme must be light or dark".to_string())?;
    with_store(&webview, &app, move |dir| vis_store::thumb_put(dir, &id, &kind, theme, &png)).await
}

/// A kind's stored still as raw PNG bytes; empty when there is none under the current build key.
#[tauri::command]
pub async fn plugin_vis_thumb_get(
    id: String,
    kind: String,
    theme: vis_store::VisTheme,
    webview: Webview,
    app: AppHandle,
) -> Result<Response, String> {
    let png = with_store(&webview, &app, move |dir| {
        vis_store::thumb_get(dir, &id, &kind, theme)
    })
    .await?;
    Ok(Response::new(png.unwrap_or_default()))
}
