/*
 * Plugin API calls from a native plugin's child. The pump admits each one on its own thread, through
 * the same checks a frame's call passes, as `Caller::Child` with the id of the pipe's owner; an
 * admitted call then runs on the async runtime, so a slow method never stalls the child's output. Its
 * `host_result` goes back only while the run that asked is still the plugin's current one: after a
 * crash or a stop the answer is dropped, never sent to a pipe that is gone. A child's event
 * subscriptions are the exception to running in parallel: each replaces the last, so they run one at a
 * time in the order they were admitted.
 */

// -- Library Imports --
use std::collections::{HashSet, VecDeque};
use std::future::Future;
use std::pin::Pin;
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

/// The method whose calls run in admission order.
const SERIAL_METHOD: &str = "events.subscribe";

type Job = Pin<Box<dyn Future<Output = ()> + Send>>;

/// The calls of a run that go one at a time, in the order they were queued.
#[derive(Default)]
pub struct SerialCalls(Arc<Mutex<SerialQueue>>);

#[derive(Default)]
struct SerialQueue {
    waiting: VecDeque<Job>,
    draining: bool,
}

impl SerialCalls {
    /// Queues `job` behind the ones before it. The job that finds the queue idle starts its drain.
    fn queue(&self, job: Job) {
        let start = {
            let mut queue = lock(&self.0);
            queue.waiting.push_back(job);
            !std::mem::replace(&mut queue.draining, true)
        };
        if start {
            tauri::async_runtime::spawn(drain(self.0.clone()));
        }
    }
}

/// Runs the queued jobs one after another until none is left.
async fn drain(queue: Arc<Mutex<SerialQueue>>) {
    loop {
        let next = {
            let mut queue = lock(&queue);
            let next = queue.waiting.pop_front();
            queue.draining = next.is_some();
            next
        };
        match next {
            Some(job) => job.await,
            None => return,
        }
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
    let serial = method == SERIAL_METHOD;
    let (host, id, owner) = (host.clone(), id.to_string(), run.clone());
    let call = async move {
        let result = job.await;
        finish(&host, &id, &owner, seq, result);
    };
    if serial {
        run.serial_calls.queue(Box::pin(call));
    } else {
        tauri::async_runtime::spawn(call);
    }
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
    fn serial_calls_run_one_at_a_time_in_the_order_queued() {
        let calls = SerialCalls::default();
        let (opened, open) = tokio::sync::oneshot::channel::<()>();
        let (done, finished) = std::sync::mpsc::channel();
        let record = move |name: &'static str| {
            let done = done.clone();
            move || done.send(name).unwrap()
        };
        let (first, second, third) = (record("first"), record("second"), record("third"));
        // The first call is still waiting when the other two are queued; the second would finish
        // first if the calls ran side by side.
        calls.queue(Box::pin(async move {
            let _ = open.await;
            first();
        }));
        calls.queue(Box::pin(async move { second() }));
        calls.queue(Box::pin(async move { third() }));
        assert!(finished.try_recv().is_err());
        opened.send(()).unwrap();
        let order: Vec<_> = (0..3)
            .map(|_| finished.recv_timeout(std::time::Duration::from_secs(10)).unwrap())
            .collect();
        assert_eq!(order, ["first", "second", "third"]);

        // An idle queue starts again.
        calls.queue(Box::pin(async move { record("again")() }));
        assert_eq!(
            finished.recv_timeout(std::time::Duration::from_secs(10)).unwrap(),
            "again"
        );
    }

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
