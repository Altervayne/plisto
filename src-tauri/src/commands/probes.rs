/*
 * Development commands for the probes page, compiled into debug builds only: window capture, the
 * WebView2 process list with CPU, memory and two guarded process ends, an event burst, and the probe
 * host's request log. Every command refuses a webview other than the main one. That check does not
 * tell frames inside the main window from its own document; no capability grants a remote URL, and
 * `plugins::frame_host_guards` fails the build's tests if one does. A command that touches WebView2 is
 * async and hands its COM call to the UI thread, so none blocks the thread it waits on.
 */

// -- Module Declarations --
#[cfg(all(windows, debug_assertions))]
pub mod capture;
#[cfg(all(windows, debug_assertions))]
pub mod emit;
#[cfg(all(windows, debug_assertions))]
pub mod processes;

// -- Library Imports --
#[cfg(windows)]
use std::cell::Cell;
#[cfg(windows)]
use std::rc::Rc;

#[cfg(windows)]
use tauri::webview::PlatformWebview;
use tauri::Webview;
#[cfg(windows)]
use tokio::sync::oneshot;

// -- Local Imports --
use super::plugins::MAIN_LABEL;
use crate::plugins::frame_host::probe::log_lines;

/// Refuses a webview that is not the main one.
fn main_only(label: &str) -> Result<(), String> {
    if label == MAIN_LABEL {
        Ok(())
    } else {
        Err("probe commands answer the main window only".to_string())
    }
}

/// The probe host's request log, oldest line first.
#[tauri::command]
pub fn probe_host_log(webview: Webview) -> Result<Vec<String>, String> {
    main_only(webview.label())?;
    Ok(log_lines())
}

/// A one-shot answer from the UI thread. Clones share one sender, so a completion handler and an
/// early error path can both hold it; only the first answer counts.
#[cfg(windows)]
struct Reply<T>(Rc<Cell<Option<oneshot::Sender<Result<T, String>>>>>);

#[cfg(windows)]
impl<T> Clone for Reply<T> {
    fn clone(&self) -> Self {
        Self(Rc::clone(&self.0))
    }
}

#[cfg(windows)]
impl<T> Reply<T> {
    fn send(&self, value: Result<T, String>) {
        if let Some(tx) = self.0.take() {
            let _ = tx.send(value);
        }
    }
}

/// Runs `start` on the UI thread with the webview and awaits what it sends, at once or later from a
/// completion handler. An error `start` returns is the answer unless one was sent first.
#[cfg(windows)]
async fn on_ui<T, F>(webview: &Webview, start: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&PlatformWebview, Reply<T>) -> Result<(), String> + Send + 'static,
{
    let (tx, rx) = oneshot::channel();
    webview
        .with_webview(move |pw| {
            let reply = Reply(Rc::new(Cell::new(Some(tx))));
            if let Err(e) = start(&pw, reply.clone()) {
                reply.send(Err(e));
            }
        })
        .map_err(|e| e.to_string())?;
    rx.await
        .map_err(|_| "the webview dropped the request unanswered".to_string())?
}

/// Runs `work` on the blocking pool.
#[cfg(windows)]
async fn blocking<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| "the probe task failed to run".to_string())?
}

/// A COM error with its HRESULT, which tells a missing interface from a failed call.
#[cfg(windows)]
fn hr(e: windows62::core::Error) -> String {
    format!("{:#010X} {}", e.code().0, e.message())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_main_window_may_call() {
        assert!(main_only(MAIN_LABEL).is_ok());
        for label in ["tray", "nowplaying", "Main", "main ", ""] {
            assert!(main_only(label).is_err(), "{label:?}");
        }
    }
}
