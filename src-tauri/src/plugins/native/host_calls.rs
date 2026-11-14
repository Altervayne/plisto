/*
 * Plugin API calls from a native plugin's child. The pump admits each one on its own thread, through
 * the same checks a frame's call passes, as `Caller::Child` with the id of the pipe's owner; an
 * admitted call then runs on the async runtime, so a slow method never stalls the child's output. Its
 * `host_result` goes back only while the run that asked is still the plugin's current one: after a
 * crash or a stop the answer is dropped, never sent to a pipe that is gone.
 */

// -- Library Imports --
use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use serde_json::Value;

// -- Local Imports --
use super::child::SendError;
use super::protocol::HostMessage;
use super::pump::bump;
use super::{lock, NativeHost, Run};
use crate::plugins::api::error::{ApiError, CallReply};
use crate::plugins::api::{self, Caller, HostContext};

/// The seqs of a run's host calls that have no answer yet.
#[derive(Default)]
pub struct HostCalls(Mutex<HashSet<u64>>);

impl HostCalls {
    fn begin(&self, seq: u64) -> bool {
        lock(&self.0).insert(seq)
    }

    fn end(&self, seq: u64) {
        lock(&self.0).remove(&seq);
    }
}

/// Admits a child's `host_call` and starts it, or answers its refusal at once. False when `seq` is
/// already open: that call is answered `invalid_args` and the open one is left alone.
pub(super) fn begin(
    host: &NativeHost,
    id: &str,
    run: &Arc<Run>,
    api_host: &Arc<dyn HostContext>,
    seq: u64,
    method: &str,
    args: Value,
) -> bool {
    // A run that is being stopped or has ended no longer acts for the plugin. Its `unavailable` is not
    // sent: no answer goes to a run that is not current.
    if host.current_child(id, run).is_none() {
        return true;
    }
    if !run.host_calls.begin(seq) {
        let reused = ApiError::invalid_args("The seq of an open host call was sent again.");
        reply(host, id, run, seq, Err(reused));
        return false;
    }
    let args = args.to_string();
    let admitted = host
        .with_plugins(|plugins| {
            let api = plugins.api().clone();
            let now = host.clock.now();
            api::admit_from(
                Caller::Child,
                &plugins.enabled_set(),
                &api,
                id,
                method,
                args.len(),
                now,
            )
            .map(|admitted| (admitted, api))
        })
        .unwrap_or_else(|| Err(ApiError::unavailable()));
    let (admitted, api) = match admitted {
        Ok(admitted) => admitted,
        Err(refused) => {
            finish(host, id, run, seq, Err(refused));
            return true;
        }
    };
    let job = api::complete(admitted, args, host.app_data.clone(), api_host.clone(), api);
    let (host, id, run) = (host.clone(), id.to_string(), run.clone());
    tauri::async_runtime::spawn(async move {
        let result = job.await;
        finish(&host, &id, &run, seq, result);
    });
    true
}

/// Closes host call `seq` and answers it.
fn finish(host: &NativeHost, id: &str, run: &Arc<Run>, seq: u64, result: Result<Value, ApiError>) {
    run.host_calls.end(seq);
    reply(host, id, run, seq, result);
}

/// Sends `host_result` while `run` is the plugin's current run. An answer the outbox has no room for
/// is dropped and counted; one over the frame cap is replaced by `too_large`.
fn reply(host: &NativeHost, id: &str, run: &Arc<Run>, seq: u64, result: Result<Value, ApiError>) {
    let Some(child) = host.current_child(id, run) else {
        return;
    };
    let sent = match child.send(&host_result(seq, result)) {
        Err(SendError::TooLarge) => {
            let refused =
                ApiError::too_large("The result does not fit in one frame to the plugin.");
            child.send(&host_result(seq, Err(refused)))
        }
        other => other,
    };
    if sent == Err(SendError::Full) {
        bump(&run.stats.results_dropped);
    }
}

fn host_result(seq: u64, result: Result<Value, ApiError>) -> HostMessage {
    let reply = CallReply::from(result);
    HostMessage::HostResult {
        seq,
        ok: reply.ok,
        result: reply.result,
        error: reply.error.and_then(|e| serde_json::to_value(e).ok()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_seq_is_open_once_until_it_ends() {
        let calls = HostCalls::default();
        assert!(calls.begin(1));
        assert!(!calls.begin(1));
        assert!(calls.begin(2));
        calls.end(1);
        assert!(calls.begin(1));
    }

    #[test]
    fn a_host_result_carries_the_reply_error_shape() {
        let refused = host_result(4, Err(ApiError::rate_limited(250)));
        assert_eq!(
            serde_json::to_value(refused).unwrap(),
            json!({ "type": "host_result", "seq": 4, "ok": false, "error": {
                "code": "rate_limited", "message": "Too many calls; retry later.", "retry_after_ms": 250
            }})
        );
        let answered = host_result(5, Ok(Value::Null));
        assert_eq!(
            serde_json::to_value(answered).unwrap(),
            json!({ "type": "host_result", "seq": 5, "ok": true, "result": null })
        );
    }
}
