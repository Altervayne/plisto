/*
 * The pump: the one reader of the helper's frames for its whole life. It pushes the helper's chunks
 * and seams into the real queue, hands its reads to the byte server, and is the only caller of
 * `answer_seek`.
 */

// -- Library Imports --
use std::fs::File;
use std::io::{self, Read};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
#[cfg(test)]
use std::time::Duration;

use crossbeam_channel::Sender;

// -- Local Imports --
use super::ending::EndGate;
use super::outbox::{Outbox, Sent};
use super::supervise::{wire_secs, Outcome};
use super::watchdog::Activity;
use super::{lock, POLL_FIRST};
use crate::audio::stream::isolate::file::{FileInfo, FileState};
use crate::audio::stream::isolate::wire::{
    HelperFrame, HelperReader, MainFrame, ReadSource, WireError,
};
use crate::audio::stream::pcm::{PcmQueue, PushError, Seam};
use crate::audio::stream::{DecodeEnd, StreamControl, WAIT_SLICE};
use crate::audio::AudioSpec;
use crate::proc::pipe;

/// The helper's stdout, read only once bytes wait in it, so a read never outlasts the end being
/// decided. Once the helper has exited, an empty pipe is its end, even if a handle leaked into
/// another process keeps the pipe open.
pub(super) struct PolledPipe {
    pub(super) file: File,
    pub(super) halt: Arc<AtomicBool>,
    pub(super) exited: Arc<AtomicBool>,
}

impl Read for PolledPipe {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        // A frame usually follows soon after the last: look again quickly at first, then back off
        // to `WAIT_SLICE`.
        let mut pause = POLL_FIRST;
        loop {
            if self.halt.load(Ordering::Acquire) {
                return Err(io::Error::other("the item has ended"));
            }
            // Read before the pipe: an exit seen here means the pipe holds all the helper wrote.
            let exited = self.exited.load(Ordering::Acquire);
            match pipe::waiting(&self.file) {
                // The write end closed and everything is read.
                None => return Ok(0),
                Some(waiting) if waiting > 0 => {
                    let len = buf.len().min(waiting as usize);
                    return self.file.read(&mut buf[..len]);
                }
                Some(_) if exited => return Ok(0),
                Some(_) => {
                    thread::sleep(pause);
                    pause = (pause * 2).min(WAIT_SLICE);
                }
            }
        }
    }
}

/// One `Read` for the byte server.
pub(super) struct ReadRequest {
    pub(super) pos: u64,
    pub(super) max: u32,
}

/// Hands the pump's outcome to the bridge thread exactly once: a pump that panics reports
/// `Protocol` as it unwinds, so the item never waits on a pump that is gone.
pub(super) struct Report {
    pub(super) outcomes: Sender<Outcome>,
    pub(super) sent: bool,
}

impl Report {
    fn send(mut self, outcome: Outcome) {
        self.sent = true;
        let _ = self.outcomes.send(outcome);
    }
}

impl Drop for Report {
    fn drop(&mut self) {
        if !self.sent {
            let _ = self.outcomes.send(Outcome::Protocol);
        }
    }
}

pub(super) struct Pump<R> {
    pub(super) reader: HelperReader<R>,
    pub(super) queue: PcmQueue,
    pub(super) control: Arc<StreamControl>,
    pub(super) outbox: Outbox,
    pub(super) reads: Sender<ReadRequest>,
    // A `Read` the byte server has not answered yet.
    pub(super) outstanding: Arc<AtomicBool>,
    pub(super) seekable: bool,
    // The queue holds the item's `End`, after a `CloseSeeks` that found no seek waiting.
    pub(super) end_queued: bool,
    pub(super) gate: Arc<EndGate>,
    pub(super) activity: Arc<Activity>,
    // An opened file's report, which takes its one `Opened`. None for a stream item.
    pub(super) file: Option<Arc<FileState>>,
    // How long a take holds the end lock before acting, so a test can decide the end meanwhile.
    #[cfg(test)]
    pub(super) pause_in_take: Duration,
}

impl<R: Read> Pump<R> {
    pub(super) fn run(mut self, outcomes: Sender<Outcome>) {
        let report = Report {
            outcomes,
            sent: false,
        };
        let outcome = loop {
            let frame = match self.reader.read_frame() {
                Ok(Some(frame)) => frame,
                // Torn or broken mid-frame: the helper died writing, and its exit code says why.
                Ok(None) | Err(WireError::Torn | WireError::Io(_)) => break Outcome::Closed,
                Err(_) => break Outcome::Protocol,
            };
            if let Some(outcome) = self.take_gated(frame) {
                break outcome;
            }
        };
        report.send(outcome);
    }

    // `take`, unless the end is decided: then the frame is dropped and the pump stops.
    pub(super) fn take_gated(&mut self, frame: HelperFrame) -> Option<Outcome> {
        let gate = Arc::clone(&self.gate);
        let ended = lock(&gate.ended);
        if *ended {
            return Some(Outcome::Stopped(PushError::Cancelled));
        }
        #[cfg(test)]
        thread::sleep(self.pause_in_take);
        self.take(frame)
    }

    // Acts on one frame. Some when the item ends with it.
    pub(super) fn take(&mut self, frame: HelperFrame) -> Option<Outcome> {
        // Once the item's `End` is queued, only the helper's own end may follow.
        if self.end_queued && !matches!(frame, HelperFrame::End(_)) {
            return Some(Outcome::Protocol);
        }
        match frame {
            HelperFrame::Read {
                source: ReadSource::Audio,
                pos,
                max,
            } => {
                // The decode thread reads one request at a time.
                if self.outstanding.swap(true, Ordering::AcqRel) {
                    return Some(Outcome::Protocol);
                }
                if self.reads.try_send(ReadRequest { pos, max }).is_err() {
                    return Some(Outcome::Protocol);
                }
            }
            HelperFrame::Chunk(chunk) => {
                let rate = u64::from(chunk.spec.sample_rate.max(1));
                let audio_us = chunk.frames() as u64 * 1_000_000 / rate;
                match self.pushing(|queue| queue.push_chunk(chunk)) {
                    Ok(()) => {
                        self.activity.audio_us.fetch_add(audio_us, Ordering::AcqRel);
                    }
                    // A chunk from before a pending seek is stale, and earns nothing.
                    Err(PushError::SeekPending) => {}
                    Err(err) => return Some(Outcome::Stopped(err)),
                }
            }
            HelperFrame::Break(seam) => {
                let Ok(seam) = seam.check(&self.control) else {
                    return Some(Outcome::Protocol);
                };
                if let Seam::Seek(generation) = seam {
                    self.queue.flush();
                    if let Err(err) = self.pushing(|queue| queue.push_break(seam)) {
                        return Some(Outcome::Stopped(err));
                    }
                    self.control.answer_seek(generation);
                } else if !self.control.seek_pending() {
                    // Any other seam behind a pending seek is stale like a chunk: the seek's answer
                    // flushes everything before it. So the pump never waits on a full queue then.
                    if let Err(err) = self.pushing(|queue| queue.push_break(seam)) {
                        return Some(Outcome::Stopped(err));
                    }
                }
            }
            HelperFrame::Opened {
                rate,
                channels,
                duration_secs,
            } => {
                let info = FileInfo {
                    spec: AudioSpec {
                        sample_rate: rate,
                        channels,
                    },
                    duration_secs,
                };
                // A helper reports its media once. A stream item's length goes to its control,
                // where its owner reads it and checks it.
                let reported = match &self.file {
                    Some(file) => file.open(info),
                    None => self.control.report_media(duration_secs),
                };
                if !reported {
                    return Some(Outcome::Protocol);
                }
            }
            HelperFrame::SeeksOpen if self.seekable => self.control.open_seeks(),
            HelperFrame::CloseSeeks if !self.end_queued => {
                let pending = match self.close_at_end() {
                    Ok(pending) => pending,
                    Err(err) => return Some(Outcome::Stopped(err)),
                };
                let pending = pending.map(|(secs, generation)| (wire_secs(secs), generation));
                match self.outbox.send(MainFrame::SeeksClosed { pending }) {
                    Sent::Done => {
                        if let Some((_, generation)) = pending {
                            self.activity.seek_sent(generation);
                        }
                    }
                    Sent::Stopped => return Some(Outcome::Stopped(PushError::Cancelled)),
                    Sent::Gone => return Some(Outcome::Closed),
                    Sent::Stalled => return Some(Outcome::Protocol),
                }
            }
            HelperFrame::End(DecodeEnd::Finished) if !self.end_queued => {
                return Some(Outcome::Protocol)
            }
            HelperFrame::End(end) => return Some(Outcome::End(end)),
            _ => return Some(Outcome::Protocol),
        }
        None
    }

    // A push into the queue, marked for the watchdog: it waits while the queue is full, and then
    // main, not the helper, holds the item up.
    fn pushing<T>(&mut self, push: impl FnOnce(&mut PcmQueue) -> T) -> T {
        self.activity.pushing.store(true, Ordering::Release);
        let pushed = push(&mut self.queue);
        self.activity.pushing.store(false, Ordering::Release);
        pushed
    }

    // The helper queued its `End` and closes seeks: queue main's `End` and close seeks in one step
    // with it, as the decode thread does in-process. Returns the seek to serve first, if one got in.
    fn close_at_end(&mut self) -> Result<Option<(f64, u64)>, PushError> {
        match self.pushing(PcmQueue::push_end) {
            Ok(()) => {}
            Err(PushError::SeekPending) => return Ok(self.control.take_seek()),
            Err(err) => return Err(err),
        }
        if self.control.close_seeks() {
            // The queued `End` is stale now; the seek's flush drops it.
            self.control.open_seeks();
            return Ok(self.control.take_seek());
        }
        self.end_queued = true;
        Ok(None)
    }
}
