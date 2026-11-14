/*
 * A child's pump thread: runs the handshake, then drains everything the child sends for as long as its
 * output lasts. It only parses, stores and hands on, so a slow consumer never stalls the child behind a
 * full inbox: answers go to the relay that waits for them, host calls run off the pump once admitted,
 * and page events reach the main window only while the plugin's page is open. A broken frame or the end
 * of the output ends the run as a crash, unless a stop already took it. Unknown and malformed frames are
 * counted and the stream goes on. Once the child is ready it hears whether its page is open, and the
 * run's feed forwarder starts.
 * Takeover requests have no consumer: they are dropped and counted.
 */

// -- Library Imports --
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use crossbeam_channel::RecvTimeoutError;
use serde_json::Value;

// -- Local Imports --
use super::child::{Child, HandshakeError, Inbound, CLOSED_PROTOCOL};
use super::feed;
use super::heartbeat::Beat;
use super::host_calls;
use super::protocol::{name_ok, ChildMessage, HostMessage, LogLevel};
use super::relay;
use super::status::{CrashReason, Reported};
use super::{lock, NativeHost, Run, HANDSHAKE_TIMEOUT};
use crate::plugins::api::host_event::{HostEvent, PageEvent};
use crate::plugins::api::log::{append_child, Level};
use crate::plugins::api::rate::RateClass;
use crate::plugins::api::HostContext;

/// Protocol errors logged per run; the rest are only counted.
pub const LOGGED_ERRORS: u32 = 16;
/// The largest page event passed on, its topic and serialized data together.
pub const MAX_PAGE_EVENT_BYTES: usize = 32 * 1024;
// How long one wait on the inbox lasts before it simply waits again.
const IDLE_WAIT: Duration = Duration::from_secs(60);

/// What one run of a child sent or was owed that was not used. Shared by the pump and the threads
/// that answer host calls.
#[derive(Debug, Default)]
pub struct ChildStats {
    pub protocol_errors: AtomicU32,
    pub logs_dropped: AtomicU32,
    /// Takeover requests, which have no consumer.
    pub unhandled: AtomicU32,
    /// Page events sent while the page was closed, over the size cap or over the rate.
    pub page_events_dropped: AtomicU32,
    /// `host_result` frames the outbox had no room for.
    pub results_dropped: AtomicU32,
}

/// Adds one to a counter and returns the new count; it stops at its maximum.
pub fn bump(counter: &AtomicU32) -> u32 {
    let mut seen = counter.load(Ordering::Relaxed);
    loop {
        let next = seen.saturating_add(1);
        match counter.compare_exchange_weak(seen, next, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => return next,
            Err(actual) => seen = actual,
        }
    }
}

/// Runs a child's handshake and then its inbox until the run ends.
pub(super) fn run(
    host: &NativeHost,
    id: &str,
    run: &Arc<Run>,
    child: &Arc<Child>,
    hello: &HostMessage,
) {
    if let Err(e) = child.handshake(hello, HANDSHAKE_TIMEOUT) {
        eprintln!("plugins: {id}: handshake failed: {e}");
        let reason = match e {
            HandshakeError::Exited(why) if why == CLOSED_PROTOCOL => CrashReason::Protocol,
            HandshakeError::Exited(_) => CrashReason::Exited,
            HandshakeError::Timeout | HandshakeError::Protocol(_) | HandshakeError::Send(_) => {
                CrashReason::Handshake
            }
        };
        host.end_run(id, run, child, reason);
        return;
    }
    if !host.went_running(id, run) {
        return;
    }
    // Read after the run counts as ready, so a page shown meanwhile is either read here or sent by
    // `notify_page`.
    let open = host
        .with_plugins(|plugins| plugins.api().is_page_open(id))
        .unwrap_or(false);
    let _ = child.send(&HostMessage::Page { open });
    feed::forward(&run.feed, host.link.as_ref(), id, child);
    let api_host = host.link.api_host();
    loop {
        let inbound = match child.recv_timeout(IDLE_WAIT) {
            Ok(inbound) => inbound,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => Inbound::Closed(String::new()),
        };
        match inbound {
            Inbound::Message(message) => handle(host, id, run, &api_host, message),
            // The codec keeps only name characters of the type, so it is safe to log.
            Inbound::Unknown(kind) => {
                protocol_error(host, id, run, &format!("unknown message type '{kind}'"))
            }
            Inbound::Malformed(_) => protocol_error(host, id, run, "malformed frame"),
            Inbound::Closed(why) => {
                let reason = if why == CLOSED_PROTOCOL {
                    CrashReason::Protocol
                } else {
                    CrashReason::Exited
                };
                host.end_run(id, run, child, reason);
                return;
            }
        }
    }
}

fn handle(
    host: &NativeHost,
    id: &str,
    run: &Arc<Run>,
    api_host: &Arc<dyn HostContext>,
    message: ChildMessage,
) {
    match message {
        ChildMessage::Pong { seq } => {
            let now = host.clock.now();
            let beat = lock(&run.heartbeat)
                .as_mut()
                .map(|heartbeat| heartbeat.pong(seq, now));
            match beat {
                Some(Ok(Beat::Recovered)) => host.recovered(id, run),
                Some(Ok(_)) => {}
                Some(Err(())) | None => protocol_error(host, id, run, "pong out of range"),
            }
        }
        ChildMessage::Status { state, text } => {
            host.board
                .report(id, Reported { state, text }, host.clock.now());
        }
        ChildMessage::Log { level, text } => {
            if !write_log(host, id, level, &text) {
                bump(&run.stats.logs_dropped);
            }
        }
        ChildMessage::Ready { .. } => protocol_error(host, id, run, "second ready"),
        ChildMessage::Result {
            seq,
            ok,
            result,
            error,
        } => {
            if !run.relays.resolve(seq, relay::answer(ok, result, error)) {
                protocol_error(host, id, run, "result with no open call");
            }
        }
        ChildMessage::HostCall { seq, method, args } => {
            if !host_calls::begin(host, id, run, api_host, seq, &method, args) {
                protocol_error(host, id, run, "host call seq already open");
            }
        }
        ChildMessage::PageEvent { topic, data } => {
            if !name_ok(&topic) {
                protocol_error(host, id, run, "bad page event topic");
            } else if !page_event(host, id, api_host.as_ref(), topic, data) {
                bump(&run.stats.page_events_dropped);
            }
        }
        ChildMessage::Takeover { .. } => {
            bump(&run.stats.unhandled);
        }
    }
}

/// Counts a protocol error on the plugin's status, and logs the first few of a run. `what` never
/// quotes the frame.
fn protocol_error(host: &NativeHost, id: &str, run: &Run, what: &str) {
    if bump(&run.stats.protocol_errors) <= LOGGED_ERRORS {
        eprintln!("plugins: {id}: protocol error: {what}");
    }
    host.board.protocol_error(id, host.clock.now());
}

/// Passes a page event to the main window while the plugin's page is open, within the size cap and
/// the plugin's page event bucket. False when it was dropped.
fn page_event(
    host: &NativeHost,
    id: &str,
    api_host: &dyn HostContext,
    topic: String,
    data: Value,
) -> bool {
    let size = serde_json::to_vec(&data).map_or(usize::MAX, |json| json.len());
    let fits = size.saturating_add(topic.len()) <= MAX_PAGE_EVENT_BYTES;
    let allowed = host
        .with_plugins(|plugins| {
            let api = plugins.api();
            api.is_page_open(id)
                && fits
                && api.take(id, RateClass::PageEvent, host.clock.now()).is_ok()
        })
        .unwrap_or(false);
    if allowed {
        api_host.emit(HostEvent::Page(PageEvent {
            id: id.to_string(),
            topic,
            data,
        }));
    }
    allowed
}

/// Writes a child's `log` line to its plugin log, within the plugin's log bucket. False when dropped.
fn write_log(host: &NativeHost, id: &str, level: LogLevel, text: &str) -> bool {
    let level = match level {
        LogLevel::Debug => Level::Debug,
        LogLevel::Info => Level::Info,
        LogLevel::Warn => Level::Warn,
        LogLevel::Error => Level::Error,
    };
    host.with_plugins(|plugins| {
        let api = plugins.api();
        if api.take(id, RateClass::Log, host.clock.now()).is_err() {
            return false;
        }
        let gates = api.gates(id);
        let _held = lock(&gates.log);
        // A disable may have landed while this waited for the gate.
        plugins.is_enabled(id) && append_child(&host.app_data, id, level, text).is_ok()
    })
    .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_counter_counts_up_and_stops_at_its_maximum() {
        let counter = AtomicU32::new(0);
        assert_eq!(bump(&counter), 1);
        assert_eq!(bump(&counter), 2);
        counter.store(u32::MAX, Ordering::Relaxed);
        assert_eq!(bump(&counter), u32::MAX);
        assert_eq!(counter.load(Ordering::Relaxed), u32::MAX);
    }
}
