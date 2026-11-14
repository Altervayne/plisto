/*
 * `net.fetch` over raw IPC, and the two network reads beside it. A request is a little-endian u32
 * length, that many bytes of UTF-8 JSON `{"id", "args"}`, then the request body; a reply is the same
 * layout around the call reply, then the response body of a buffered success. A body thus crosses as
 * bytes rather than base64 in JSON. The plugin id comes from the caller's bytes, so a frame is admitted
 * exactly as a `plugin_call` is: from the main window, once frames are ready, for a serving plugin.
 * Every refusal is a framed reply, and the request is awaited on the async runtime.
 */

// -- Library Imports --
use std::sync::atomic::Ordering;
use std::time::Instant;

use serde_json::{Map, Value};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager, State, Webview};

// -- Local Imports --
use super::plugin_call::call_from;
use crate::plugins::api::error::{ApiError, CallReply};
use crate::plugins::api::state::ApiState;
use crate::plugins::api::tauri_host::TauriHost;
use crate::plugins::api::{self, Fetched, NetEngine, NetEnvironment, NetLogEntry, ProxyKind};
use crate::plugins::state::EnabledSet;
use crate::state::AppState;

const MAIN_LABEL: &str = "main";
/// The bytes of the length prefix.
const PREFIX_BYTES: usize = 4;

/// A decoded request.
#[derive(Debug, PartialEq, Eq)]
pub struct Frame {
    pub id: String,
    /// The JSON text of the arguments object.
    pub args: String,
    pub body: Vec<u8>,
}

fn malformed() -> ApiError {
    ApiError::invalid_args("The request is not a valid frame.")
}

/// Decodes request bytes. A short prefix, a length past the end, JSON that is not UTF-8, and a JSON
/// part that is not an object with a string `id` and a string `args` are each `invalid_args`.
pub fn frame_from(bytes: &[u8]) -> Result<Frame, ApiError> {
    let prefix: [u8; PREFIX_BYTES] = bytes
        .get(..PREFIX_BYTES)
        .and_then(|prefix| prefix.try_into().ok())
        .ok_or_else(malformed)?;
    let meta_len = u32::from_le_bytes(prefix) as usize;
    let body_start = PREFIX_BYTES
        .checked_add(meta_len)
        .filter(|end| *end <= bytes.len())
        .ok_or_else(malformed)?;
    let text = std::str::from_utf8(&bytes[PREFIX_BYTES..body_start]).map_err(|_| malformed())?;
    let meta: Map<String, Value> = serde_json::from_str(text).map_err(|_| malformed())?;
    let field = |name: &str| meta.get(name).and_then(Value::as_str).map(str::to_string);
    let (Some(id), Some(args)) = (field("id"), field("args")) else {
        return Err(malformed());
    };
    Ok(Frame {
        id,
        args,
        body: bytes[body_start..].to_vec(),
    })
}

/// Frames a call's outcome: the call reply, then the body of a buffered success.
pub fn reply_bytes(outcome: Result<Fetched, ApiError>) -> Vec<u8> {
    let (reply, body) = match outcome {
        Ok(Fetched { result, body }) => (CallReply::from(Ok(result)), body.unwrap_or_default()),
        Err(error) => (CallReply::from(Err(error)), Vec::new()),
    };
    // An empty reply reads as malformed, which the shim answers `unavailable`.
    let Ok(meta) = serde_json::to_vec(&reply) else {
        return Vec::new();
    };
    let Ok(meta_len) = u32::try_from(meta.len()) else {
        return Vec::new();
    };
    let mut out = Vec::with_capacity(PREFIX_BYTES + meta.len() + body.len());
    out.extend_from_slice(&meta_len.to_le_bytes());
    out.extend_from_slice(&meta);
    out.extend_from_slice(&body);
    out
}

/// Admits a decoded frame from the webview `label` as `plugin_call` admits a call, measuring the
/// `args` text as it does, then runs it.
async fn answer(
    frame: Result<Frame, ApiError>,
    label: &str,
    frames_ready: bool,
    enabled: &EnabledSet,
    api: &ApiState,
    engine: NetEngine,
) -> Result<Fetched, ApiError> {
    let frame = frame?;
    let admitted = call_from(
        label,
        frames_ready,
        enabled,
        api,
        &frame.id,
        "net.fetch",
        frame.args.len(),
        Instant::now(),
    )?;
    api::net_fetch(admitted, &frame.args, frame.body, engine, api.net().clone()).await
}

/// Runs one framed `net.fetch` and resolves the framed reply. Always `Ok`: Tauri requires a `Result`
/// of an async command that borrows its request.
#[tauri::command]
pub async fn plugin_fetch(
    request: Request<'_>,
    webview: Webview,
    app: AppHandle,
) -> Result<Response, ApiError> {
    let frame = match request.body() {
        InvokeBody::Raw(bytes) => frame_from(bytes),
        InvokeBody::Json(_) => Err(ApiError::invalid_args("The request must be raw bytes.")),
    };
    let (enabled, api, frames_ready) = {
        let state = app.state::<AppState>();
        let plugins = &state.plugins;
        (
            plugins.enabled_set(),
            plugins.api().clone(),
            state.frames_ready.load(Ordering::SeqCst),
        )
    };
    let engine = TauriHost::new(app).net_engine();
    let outcome = answer(frame, webview.label(), frames_ready, &enabled, &api, engine).await;
    Ok(Response::new(reply_bytes(outcome)))
}

/// Plugin `id`'s log for the webview `label`: the main window's, else empty.
fn log_from(label: &str, api: &ApiState, id: &str) -> Vec<NetLogEntry> {
    if label != MAIN_LABEL {
        return Vec::new();
    }
    api.net().log(id)
}

/// The last requests Plisto made for plugin `id`, oldest first. Held in memory only.
#[tauri::command]
pub fn plugin_net_log(
    id: String,
    webview: Webview,
    state: State<'_, AppState>,
) -> Vec<NetLogEntry> {
    log_from(webview.label(), state.plugins.api(), &id)
}

/// What `read` says for the main window; any other webview reads `none`, without a read.
fn environment_from(label: &str, read: impl FnOnce() -> NetEnvironment) -> NetEnvironment {
    if label != MAIN_LABEL {
        return NetEnvironment {
            proxy: ProxyKind::None,
        };
    }
    read()
}

/// Whether Windows is set to use a proxy, which plugin requests never go through. Off the main thread:
/// a stale cache reads the WinHTTP settings.
#[tauri::command(async)]
pub fn plugin_net_environment(webview: Webview) -> NetEnvironment {
    environment_from(webview.label(), api::net_environment)
}

#[cfg(test)]
mod tests;
