/*
 * A plugin call that stays open until the user or a deadline ends it. The call's blocking thread
 * waits on a one-slot channel while `UiState` holds the sending end. Whoever removes the open request
 * from `UiState` owns the outcome and sends it once, so a deadline meeting an answer can never resolve
 * twice: the waiter that loses the removal takes the answer already on its way.
 */

// -- Library Imports --
use std::fmt;
use std::time::Duration;

use crossbeam_channel::{Receiver, RecvTimeoutError};
use serde_json::{json, Value};

// -- Local Imports --
use super::error::ApiError;
use super::host_event::{HostEvent, UiEvent};
use super::ui_state::UiState;
use super::HostContext;

/// What an open request resolves to when its deadline passes first.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Expiry {
    /// A toast: the plugin hears it was dismissed.
    Dismissed,
    /// A prompt: the call fails `timeout`, which a user's "no" never does.
    TimedOut,
}

/// The outcome of an open request. `close` asks the waiter to withdraw it from the main window.
pub struct Resolution {
    pub result: Result<Value, ApiError>,
    pub close: bool,
}

/// One open request, waited on by the call that made it.
pub struct Pending {
    request_id: String,
    plugin: String,
    rx: Receiver<Resolution>,
    deadline: Duration,
    expiry: Expiry,
}

// Written by hand: a resolution may carry a gesture token, and nothing of the channel is printed.
impl fmt::Debug for Pending {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Pending")
            .field("request_id", &self.request_id)
            .field("deadline", &self.deadline)
            .field("expiry", &self.expiry)
            .finish_non_exhaustive()
    }
}

impl Expiry {
    fn on_deadline(self) -> Result<Value, ApiError> {
        match self {
            Expiry::Dismissed => Ok(json!({ "result": "dismissed" })),
            Expiry::TimedOut => Err(ApiError::timeout()),
        }
    }
}

impl Pending {
    pub(super) fn new(
        request_id: String,
        plugin: String,
        rx: Receiver<Resolution>,
        deadline: Duration,
        expiry: Expiry,
    ) -> Pending {
        Pending {
            request_id,
            plugin,
            rx,
            deadline,
            expiry,
        }
    }

    #[cfg(test)]
    pub(super) fn with_deadline(mut self, deadline: Duration) -> Pending {
        self.deadline = deadline;
        self
    }

    /// Blocks until the request resolves or its deadline passes, holding no lock meanwhile. A
    /// resolution that withdraws the request is followed by a `close` event.
    pub fn wait(self, host: &dyn HostContext, ui: &UiState) -> Result<Value, ApiError> {
        self.wait_with(host, ui, || {})
    }

    /// `wait`, running `before_expire` between the deadline and the attempt to expire.
    pub(super) fn wait_with(
        self,
        host: &dyn HostContext,
        ui: &UiState,
        before_expire: impl FnOnce(),
    ) -> Result<Value, ApiError> {
        // Only reached if a remover dropped the sender without sending, which no path does.
        let lost = || Resolution {
            result: Err(ApiError::unavailable()),
            close: true,
        };
        let resolution = match self.rx.recv_timeout(self.deadline) {
            Ok(resolution) => resolution,
            Err(RecvTimeoutError::Timeout) => {
                before_expire();
                if ui.expire(&self.request_id) {
                    Resolution {
                        result: self.expiry.on_deadline(),
                        close: true,
                    }
                } else {
                    // Another path removed the request first and sends without blocking.
                    self.rx.recv().unwrap_or_else(|_| lost())
                }
            }
            Err(RecvTimeoutError::Disconnected) => lost(),
        };
        if resolution.close {
            host.emit(HostEvent::Ui(UiEvent::close(
                &self.request_id,
                &self.plugin,
            )));
        }
        resolution.result
    }
}
