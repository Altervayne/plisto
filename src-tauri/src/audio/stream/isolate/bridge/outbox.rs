/*
 * Main's frames for the helper: a bounded outbox, and the writer thread that writes them in order.
 * The writer is the one bridge thread that blocks in a pipe write, so the item's end waits for it
 * and cancels a write that would otherwise outlive the helper.
 */

// -- Library Imports --
use std::fs::File;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Instant;

use crossbeam_channel::{Receiver, SendTimeoutError, Sender};

// -- Local Imports --
use super::{EXIT_WAIT, HELPER_SEND};
use crate::audio::stream::isolate::wire::MainFrame;
use crate::audio::stream::{StreamControl, WAIT_SLICE};
use crate::proc::pipe;

/// Main's frames for the helper, written in order by the writer thread.
#[derive(Clone)]
pub(super) struct Outbox {
    pub(super) tx: Sender<MainFrame>,
    pub(super) halt: Arc<AtomicBool>,
    pub(super) control: Arc<StreamControl>,
}

/// How a blocking send to the helper went.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Sent {
    Done,
    /// The end is decided, or the item is cancelled.
    Stopped,
    /// The writer is gone: a write to the helper failed, so the helper stopped reading or died.
    Gone,
    /// The helper took nothing for `HELPER_SEND`.
    Stalled,
}

impl Outbox {
    /// Queues `frame`, waiting for room in `WAIT_SLICE` steps and at most `HELPER_SEND` in all.
    pub(super) fn send(&self, frame: MainFrame) -> Sent {
        let since = Instant::now();
        let mut frame = frame;
        loop {
            match self.tx.send_timeout(frame, WAIT_SLICE) {
                Ok(()) => return Sent::Done,
                Err(SendTimeoutError::Timeout(back)) => {
                    if self.halt.load(Ordering::Acquire) || self.control.is_cancelled() {
                        return Sent::Stopped;
                    }
                    if since.elapsed() >= HELPER_SEND {
                        return Sent::Stalled;
                    }
                    frame = back;
                }
                Err(SendTimeoutError::Disconnected(_)) => return Sent::Gone,
            }
        }
    }
}

/// Writes `frames` to the helper's stdin until the outbox closes, a write fails or the end is
/// decided.
pub(super) fn write_frames(frames: Receiver<MainFrame>, mut stdin: File, halt: Arc<AtomicBool>) {
    for frame in frames {
        if halt.load(Ordering::Acquire) || frame.write(&mut stdin).is_err() {
            return;
        }
    }
}

/// The writer thread, and a second handle to the pipe end it writes, to cancel its write by.
pub(super) struct Writer {
    pub(super) thread: JoinHandle<()>,
    pub(super) pipe: File,
}

/// Waits for the writer once the item has ended, at most `EXIT_WAIT`. The killed helper's pipe
/// breaks its write, unless a handle leaked into another process keeps the helper's read end open:
/// that write is cancelled, by thread and then by pipe. A writer still blocked when the wait ends is
/// logged and left detached; it ends when the leaked handle closes.
pub(super) fn reap(writer: Writer) {
    let deadline = Instant::now() + EXIT_WAIT;
    while !writer.thread.is_finished() {
        if Instant::now() >= deadline {
            eprintln!(
                "warn: decode isolation: a write to an ended helper could not be cancelled; \
                 its thread is left until the pipe breaks"
            );
            return;
        }
        pipe::cancel_blocked_io(&writer.thread, &writer.pipe);
        thread::sleep(WAIT_SLICE);
    }
    let _ = writer.thread.join();
}
