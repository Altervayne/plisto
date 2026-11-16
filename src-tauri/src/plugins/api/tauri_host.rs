/*
 * The app as a plugin method sees it in the running app: the settings table, the main window's OS
 * theme and whether it is shown, events to it, the managed state the library and playback methods
 * read, the native host a page's `plugin.*` call goes through, and the network engine. Shared by a
 * frame's calls, which come through IPC, and a native child's, which come through its pipe. The
 * engine's stream and socket tasks report through their own `TauriHost`, so they outlive the call.
 */

// -- Library Imports --
use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, Theme};

// -- Local Imports --
use super::error::ApiError;
use super::host_event::{
    HostEvent, EVENT_NET, EVENT_PAGE, EVENT_SIDEBAR, EVENT_STREAM, EVENT_UI,
};
use super::net::sink::{NetEvent, NetSink};
use super::{HostContext, NetEngine};
use crate::db;
#[cfg(windows)]
use crate::plugins::native::NativeHost;
use crate::state::AppState;

const MAIN_LABEL: &str = "main";

pub struct TauriHost {
    app: AppHandle,
}

impl TauriHost {
    pub fn new(app: AppHandle) -> TauriHost {
        TauriHost { app }
    }

    /// The process-wide network engine, its events sent to the main window.
    pub fn net_engine(&self) -> NetEngine {
        NetEngine::shared(Arc::new(TauriHost::new(self.app.clone())))
    }
}

impl NetSink for TauriHost {
    fn emit(&self, event: NetEvent) {
        HostContext::emit(self, HostEvent::Net(event));
    }
}

impl HostContext for TauriHost {
    fn setting(&self, key: &str) -> Option<String> {
        let state = self.app.try_state::<AppState>()?;
        let conn = state.db.lock().ok()?;
        db::get_setting(&conn, key).ok().flatten()
    }

    fn os_prefers_dark(&self) -> bool {
        self.app
            .get_webview_window(MAIN_LABEL)
            .and_then(|main| main.theme().ok())
            .is_some_and(|theme| matches!(theme, Theme::Dark))
    }

    fn emit(&self, event: HostEvent) {
        let _ = match event {
            HostEvent::Ui(event) => self.app.emit_to(MAIN_LABEL, EVENT_UI, event),
            HostEvent::Sidebar(event) => self.app.emit_to(MAIN_LABEL, EVENT_SIDEBAR, event),
            HostEvent::Page(event) => self.app.emit_to(MAIN_LABEL, EVENT_PAGE, event),
            HostEvent::Net(event) => self.app.emit_to(MAIN_LABEL, EVENT_NET, event),
            HostEvent::Stream(event) => {
                // A native owner hears it in its child and in its page frame, which may have started
                // the item.
                #[cfg(windows)]
                if let Some(native) = self.app.try_state::<Arc<NativeHost>>() {
                    native.deliver_stream(&event.id, &event.event);
                }
                self.app.emit_to(MAIN_LABEL, EVENT_STREAM, event)
            }
        };
    }

    fn main_window_shown(&self) -> bool {
        self.app.get_webview_window(MAIN_LABEL).is_some_and(|main| {
            matches!(main.is_visible(), Ok(true)) && matches!(main.is_minimized(), Ok(false))
        })
    }

    fn app_state(&self) -> Option<&AppState> {
        self.app.try_state::<AppState>().map(|state| state.inner())
    }

    #[cfg(windows)]
    fn relay_call(&self, id: &str, method: &str, args: Value) -> Result<Value, ApiError> {
        match self.app.try_state::<Arc<NativeHost>>() {
            Some(native) => native.relay(id, method, args),
            None => Err(ApiError::unavailable()),
        }
    }

    #[cfg(not(windows))]
    fn relay_call(&self, _: &str, _: &str, _: Value) -> Result<Value, ApiError> {
        Err(ApiError::unavailable())
    }

    fn net(&self) -> Option<NetEngine> {
        Some(self.net_engine())
    }
}
