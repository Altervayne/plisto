/*
 * Where the engine's events go: the app, or in a test build a log the test reads. A test build never
 * holds an app handle: linking one into the test binary pulls in window code whose imports a binary
 * with no app manifest cannot load.
 */

// -- Library Imports --
#[cfg(test)]
use std::sync::{Arc, Mutex};

use serde::Serialize;
#[cfg(not(test))]
use tauri::Emitter;

pub(super) enum AppEvents {
    #[cfg(not(test))]
    App(tauri::AppHandle),
    #[cfg(test)]
    Log(Arc<Mutex<Vec<(String, serde_json::Value)>>>),
}

impl AppEvents {
    #[cfg(not(test))]
    pub(super) fn of(app: tauri::AppHandle) -> Self {
        Self::App(app)
    }

    #[cfg(test)]
    pub(super) fn of(_app: tauri::AppHandle) -> Self {
        Self::Log(Arc::default())
    }

    pub(super) fn emit<S: Serialize + Clone>(&self, event: &str, payload: S) -> tauri::Result<()> {
        match self {
            #[cfg(not(test))]
            Self::App(app) => app.emit(event, payload),
            #[cfg(test)]
            Self::Log(log) => {
                let value = serde_json::to_value(payload).unwrap_or_default();
                if let Ok(mut log) = log.lock() {
                    log.push((event.to_string(), value));
                }
                Ok(())
            }
        }
    }
}
