/*
 * A child's pump thread: runs the handshake, then drains everything the child sends for as long as its
 * output lasts. It only parses, stores and hands on, so a slow consumer never stalls the child behind a
 * full inbox. A broken frame or the end of the output ends the run as a crash, unless a stop already
 * took it. Unknown and malformed frames are counted and the stream goes on.
 * Call answers, host calls, page events and takeover requests have no consumer: they are dropped and
 * counted.
 */

// -- Library Imports --
use std::sync::Arc;
use std::time::Duration;

use crossbeam_channel::RecvTimeoutError;

// -- Local Imports --
use super::child::{Child, HandshakeError, Inbound, CLOSED_PROTOCOL};
use super::heartbeat::Beat;
use super::protocol::{ChildMessage, HostMessage, LogLevel};
use super::status::{CrashReason, Reported};
use super::{lock, NativeHost, Run, HANDSHAKE_TIMEOUT};
use crate::plugins::api::log::{append_child, Level};
use crate::plugins::api::rate::RateClass;

/// Protocol errors logged per run; the rest are only counted.
pub const LOGGED_ERRORS: u32 = 16;
// How long one wait on the inbox lasts before it simply waits again.
const IDLE_WAIT: Duration = Duration::from_secs(60);

/// What one run of a child sent that was not used.
#[derive(Debug, Default)]
pub struct ChildStats {
    pub protocol_errors: u32,
    pub logs_dropped: u32,
    /// Messages with no consumer: answered calls, host calls, page events, takeover requests.
    pub unhandled: u32,
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
    let open = host
        .with_plugins(|plugins| plugins.api().is_page_open(id))
        .unwrap_or(false);
    let _ = child.send(&HostMessage::Page { open });
    let mut stats = ChildStats::default();
    loop {
        let inbound = match child.recv_timeout(IDLE_WAIT) {
            Ok(inbound) => inbound,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => Inbound::Closed(String::new()),
        };
        match inbound {
            Inbound::Message(message) => handle(host, id, run, message, &mut stats),
            // The codec keeps only name characters of the type, so it is safe to log.
            Inbound::Unknown(kind) => protocol_error(
                host,
                id,
                &mut stats,
                &format!("unknown message type '{kind}'"),
            ),
            Inbound::Malformed(_) => protocol_error(host, id, &mut stats, "malformed frame"),
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
    message: ChildMessage,
    stats: &mut ChildStats,
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
                Some(Err(())) | None => protocol_error(host, id, stats, "pong out of range"),
            }
        }
        ChildMessage::Status { state, text } => {
            host.board
                .report(id, Reported { state, text }, host.clock.now());
        }
        ChildMessage::Log { level, text } => {
            if !write_log(host, id, level, &text) {
                stats.logs_dropped = stats.logs_dropped.saturating_add(1);
            }
        }
        ChildMessage::Ready { .. } => protocol_error(host, id, stats, "second ready"),
        // The host sends no `call`, so every answer has an unknown seq.
        ChildMessage::Result { .. } => protocol_error(host, id, stats, "result with no open call"),
        ChildMessage::HostCall { .. }
        | ChildMessage::PageEvent { .. }
        | ChildMessage::Takeover { .. } => {
            stats.unhandled = stats.unhandled.saturating_add(1);
        }
    }
}

/// Counts a protocol error on the plugin's status, and logs the first few of a run. `what` never
/// quotes the frame.
fn protocol_error(host: &NativeHost, id: &str, stats: &mut ChildStats, what: &str) {
    stats.protocol_errors = stats.protocol_errors.saturating_add(1);
    if stats.protocol_errors <= LOGGED_ERRORS {
        eprintln!("plugins: {id}: protocol error: {what}");
    }
    host.board.protocol_error(id, host.clock.now());
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
