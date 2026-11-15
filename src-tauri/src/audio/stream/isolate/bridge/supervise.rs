/*
 * The bridge thread's watch over a running helper: it forwards new seeks, watches for cancel, for
 * the helper's exit through its process handle and for a helper that spins or hangs, and turns what
 * ended the pump or the byte server into the item's end.
 */

// -- Library Imports --
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Instant;

use crossbeam_channel::{Receiver, TryRecvError, TrySendError};

// -- Local Imports --
use super::outbox::Outbox;
use super::watchdog::Watchdog;
use super::{EXIT_WAIT, HELPER_SEND};
use crate::audio::stream::isolate::alloc::EXIT_MEMORY;
use crate::audio::stream::isolate::wire::MainFrame;
use crate::audio::stream::pcm::PushError;
use crate::audio::stream::{DecodeEnd, Fault, StreamControl, WAIT_SLICE};
use crate::proc::contained::Contained;

/// What ended the pump or the byte server.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Outcome {
    /// The helper's own end.
    End(DecodeEnd),
    /// The helper's pipe closed or broke, either way: its exit code tells why, and a helper that
    /// lives on with a pipe closed broke the protocol.
    Closed,
    /// A bad frame, a frame out of order, a read the byte buffer cannot serve, a helper that stopped
    /// taking main's frames, or a pump that panicked.
    Protocol,
    /// The queue refused a push: cancelled, every reader gone, or the end already decided.
    Stopped(PushError),
}

// Runs until the item ends and returns how. Forwards each newer seek to the helper without ever
// blocking on it: a seek the helper does not take within `HELPER_SEND` ends the item. A live helper
// the watchdog finds spinning or hung ends it too.
pub(super) fn supervise(
    process: &Contained,
    control: &StreamControl,
    outbox: &Outbox,
    outcomes: &Receiver<Outcome>,
    exited: &AtomicBool,
    watchdog: &mut Watchdog,
) -> DecodeEnd {
    let mut forwarded = 0;
    // A seek waiting for room in the outbox, and since when one has been waiting.
    let mut waiting: Option<(MainFrame, Instant)> = None;
    let mut exit_code = None;
    loop {
        match outcomes.try_recv() {
            Ok(outcome) => return settle(outcome, process, control, exit_code),
            Err(TryRecvError::Disconnected) => return DecodeEnd::Isolated(Fault::Protocol),
            Err(TryRecvError::Empty) => {}
        }
        if control.is_cancelled() {
            return DecodeEnd::Cancelled;
        }
        if let Some((secs, generation)) = control.take_seek() {
            if generation > forwarded {
                forwarded = generation;
                let seek = MainFrame::Seek {
                    secs: wire_secs(secs),
                    generation,
                };
                let since = waiting
                    .as_ref()
                    .map_or_else(Instant::now, |(_, since)| *since);
                waiting = Some((seek, since));
            }
        }
        if let Some((seek, since)) = waiting.take() {
            match outbox.tx.try_send(seek) {
                Err(TrySendError::Full(_)) if since.elapsed() >= HELPER_SEND => {
                    return DecodeEnd::Isolated(Fault::Protocol)
                }
                Err(TrySendError::Full(seek)) => waiting = Some((seek, since)),
                // A write to the helper failed: its exit code, or its closed pipe, decides.
                Err(TrySendError::Disconnected(_)) => {
                    return settle(Outcome::Closed, process, control, exit_code)
                }
                // The seek waiting is always the newest forwarded.
                Ok(()) => watchdog.seek_sent(forwarded),
            }
        }
        if exit_code.is_some() {
            thread::sleep(WAIT_SLICE);
            continue;
        }
        if let Some(fault) = watchdog.check() {
            return DecodeEnd::Isolated(fault);
        }
        match process.wait_timeout(WAIT_SLICE) {
            Ok(Some(code)) => {
                exit_code = Some(code);
                // Everything the helper wrote is in its pipe now: the pump reads it to the end.
                exited.store(true, Ordering::Release);
            }
            Ok(None) => {}
            Err(_) => return DecodeEnd::Isolated(Fault::Crashed),
        }
    }
}

// The end an outcome stands for. A closed pipe takes the helper's exit code, waiting for it if
// need be.
fn settle(
    outcome: Outcome,
    process: &Contained,
    control: &StreamControl,
    exit_code: Option<u32>,
) -> DecodeEnd {
    match outcome {
        Outcome::End(end) => end,
        Outcome::Protocol => DecodeEnd::Isolated(Fault::Protocol),
        Outcome::Stopped(PushError::ReaderGone) => DecodeEnd::ReaderGone,
        Outcome::Stopped(_) => DecodeEnd::Cancelled,
        Outcome::Closed => {
            if let Some(code) = exit_code {
                return exit_end(code);
            }
            let deadline = Instant::now() + EXIT_WAIT;
            loop {
                if control.is_cancelled() {
                    return DecodeEnd::Cancelled;
                }
                match process.wait_timeout(WAIT_SLICE) {
                    Ok(Some(code)) => return exit_end(code),
                    Ok(None) if Instant::now() < deadline => {}
                    // A helper that closed its pipe and lives on is not following the protocol.
                    Ok(None) => return DecodeEnd::Isolated(Fault::Protocol),
                    Err(_) => return DecodeEnd::Isolated(Fault::Crashed),
                }
            }
        }
    }
}

/// The end of a helper that exited without sending its own.
pub(super) fn exit_end(code: u32) -> DecodeEnd {
    match code {
        EXIT_MEMORY => DecodeEnd::Isolated(Fault::Memory),
        // A clean exit with no `End` is a helper that broke the protocol.
        0 => DecodeEnd::Isolated(Fault::Protocol),
        _ => DecodeEnd::Isolated(Fault::Crashed),
    }
}

/// A seek target the wire carries: a target past every end stays past every end.
pub(super) fn wire_secs(secs: f64) -> f64 {
    if secs.is_finite() {
        secs
    } else {
        f64::MAX
    }
}
