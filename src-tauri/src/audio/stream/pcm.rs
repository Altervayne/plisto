/*
 * The PCM queue between the decode thread and the audio thread: a bounded channel of segments plus
 * the counters in `StreamControl`. The producer side blocks (in `WAIT_SLICE` steps, re-checking
 * cancel) while its next chunk would take the queue past `PCM_MAX_MS`; the consumer side only ever
 * takes what is ready, with no lock and no wait, because it runs on the audio thread.
 *
 * The producer merges small decoded packets into chunks of at least `MIN_CHUNK_FRAMES`, so a codec
 * with tiny blocks still fills `PCM_MAX_MS` within the channel's segment count, and the audio thread
 * frees fewer buffers.
 *
 * Every segment is stamped with the seek generation it belongs to. The reader drops segments older
 * than the newest requested seek, so audio from before a seek never plays after it, even while the
 * decode thread is still waiting for bytes and has not flushed.
 *
 * The producer keeps a receiver of its own so a seek can flush what is queued. It learns that every
 * consumer is gone through a weak token instead of the channel, which its own receiver keeps open.
 */

// -- Library Imports --
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};
use std::thread;

use crossbeam_channel::{Receiver, Sender, TrySendError};

// -- Local Imports --
use super::{StreamControl, PCM_MAX_MS, WAIT_SLICE};
use crate::audio::PcmChunk;

/// Room for `PCM_MAX_MS` of `MIN_CHUNK_FRAMES` chunks at any rate up to 1 MHz, plus boundaries.
const SEGMENT_CAP: usize = 4_096;

/// The smallest chunk the producer queues, short of a spec change, a boundary or the end.
pub const MIN_CHUNK_FRAMES: usize = 1_024;

// Stale segments the reader drops in one call before it reports nothing ready, so one call stays
// short after a seek.
const STALE_PER_CALL: usize = 16;

/// What a `Break` marks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Seam {
    /// The answer to the seek of this generation: what follows starts at the seek target.
    Seek(u64),
    /// A chained stream started a new logical stream, with its own spec.
    Chain,
}

/// One unit in the queue. `Break` ends the current run of PCM: what follows starts afresh. `End`
/// follows the last chunk. The spec can also change between two chunks with no `Break`.
pub enum Segment {
    Chunk(PcmChunk),
    Break(Seam),
    End,
}

/// Why a push did not land.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PushError {
    Cancelled,
    /// Every consumer is gone.
    ReaderGone,
    /// A seek is pending; the chunk is stale and was dropped.
    SeekPending,
}

// A segment and the seek generation it belongs to.
struct Stamped {
    generation: u64,
    segment: Segment,
}

/// Builds one stream's queue: the producer half for the decode thread and the consumer half for the
/// audio thread, both counting into `control`.
pub fn pcm_queue(control: Arc<StreamControl>) -> (PcmQueue, PcmReader) {
    let (tx, rx) = crossbeam_channel::bounded(SEGMENT_CAP);
    let token = Arc::new(());
    let queue = PcmQueue {
        tx,
        drain: rx.clone(),
        readers: Arc::downgrade(&token),
        control: Arc::clone(&control),
        pending: None,
        halt: None,
    };
    let reader = PcmReader {
        rx,
        control,
        _token: token,
    };
    (queue, reader)
}

/// The producer half, owned by the decode thread.
pub struct PcmQueue {
    tx: Sender<Stamped>,
    drain: Receiver<Stamped>,
    readers: Weak<()>,
    control: Arc<StreamControl>,
    // Decoded audio not yet queued, gathering up to `MIN_CHUNK_FRAMES`.
    pending: Option<PcmChunk>,
    // Once set, every push stops as if cancelled, without cancelling the stream.
    halt: Option<Arc<AtomicBool>>,
}

impl PcmQueue {
    pub fn control(&self) -> &Arc<StreamControl> {
        &self.control
    }

    /// Makes every push, a blocked one included, stop as cancelled once `flag` is set.
    pub(crate) fn halt_on(&mut self, flag: Arc<AtomicBool>) {
        self.halt = Some(flag);
    }

    pub fn buffered_ms(&self) -> u64 {
        self.control.buffered_ms()
    }

    /// Adds decoded audio, queueing it once `MIN_CHUNK_FRAMES` of one spec have gathered. A queued
    /// chunk blocks while it would take the queue past `PCM_MAX_MS`, and always lands in an empty
    /// queue, so one longer than the cap cannot wedge the stream. A pending seek drops the audio
    /// gathered so far and returns `SeekPending`.
    pub fn push_chunk(&mut self, chunk: PcmChunk) -> Result<(), PushError> {
        if let Err(err) = self.check(true) {
            self.pending = None;
            return Err(err);
        }
        let merge = matches!(&self.pending, Some(p) if p.spec == chunk.spec);
        if merge {
            if let Some(p) = self.pending.as_mut() {
                p.samples.extend_from_slice(&chunk.samples);
            }
        } else {
            let mut chunk = chunk;
            if chunk.frames() < MIN_CHUNK_FRAMES {
                chunk
                    .samples
                    .reserve(MIN_CHUNK_FRAMES * chunk.spec.channels as usize);
            }
            if let Some(prev) = self.pending.replace(chunk) {
                self.send_chunk(prev)?;
            }
        }
        if self
            .pending
            .as_ref()
            .is_some_and(|p| p.frames() >= MIN_CHUNK_FRAMES)
        {
            if let Some(full) = self.pending.take() {
                self.send_chunk(full)?;
            }
        }
        Ok(())
    }

    /// Queues the gathered audio, then a `Break`. A seek's `Break` is never refused for a pending
    /// seek: it is the answer.
    pub fn push_break(&mut self, seam: Seam) -> Result<(), PushError> {
        let generation = match seam {
            Seam::Seek(g) => g,
            Seam::Chain => {
                self.send_pending()?;
                self.control.answered()
            }
        };
        self.send_boundary(generation, Segment::Break(seam))
    }

    /// Queues the gathered audio, then `End`. A pending seek returns `SeekPending` instead: an
    /// `End` from before it would be dropped as stale, so the seek must be served first.
    pub fn push_end(&mut self) -> Result<(), PushError> {
        self.send_pending()?;
        if self.control.seek_pending() {
            self.pending = None;
            return Err(PushError::SeekPending);
        }
        self.send_boundary(self.control.answered(), Segment::End)
    }

    /// Drops everything queued and not yet taken, and the audio gathered so far.
    pub fn flush(&mut self) {
        self.pending = None;
        while let Ok(item) = self.drain.try_recv() {
            self.control.taken(&item.segment);
        }
    }

    /// Why this producer should stop, if it should: cancel, or every consumer dropped.
    pub fn stopped(&self) -> Option<PushError> {
        let halted = self
            .halt
            .as_ref()
            .is_some_and(|h| h.load(Ordering::Acquire));
        if halted || self.control.is_cancelled() {
            return Some(PushError::Cancelled);
        }
        if self.readers.strong_count() == 0 {
            return Some(PushError::ReaderGone);
        }
        None
    }

    fn check(&self, seek_interrupts: bool) -> Result<(), PushError> {
        if let Some(err) = self.stopped() {
            return Err(err);
        }
        if seek_interrupts && self.control.seek_pending() {
            return Err(PushError::SeekPending);
        }
        Ok(())
    }

    fn send_pending(&mut self) -> Result<(), PushError> {
        match self.pending.take() {
            Some(p) => match self.send_chunk(p) {
                Err(PushError::SeekPending) => Ok(()),
                other => other,
            },
            None => Ok(()),
        }
    }

    fn send_chunk(&mut self, chunk: PcmChunk) -> Result<(), PushError> {
        let us = chunk_us(&chunk);
        let max_us = PCM_MAX_MS * 1_000;
        let mut item = Stamped {
            generation: self.control.answered(),
            segment: Segment::Chunk(chunk),
        };
        loop {
            if let Err(err) = self.check(true) {
                self.pending = None;
                return Err(err);
            }
            let queued = self.control.buffered_us.load(Ordering::Acquire);
            if queued == 0 || queued + us <= max_us {
                // Counted before the send, so the consumer never takes more than was added.
                self.control.buffered_us.fetch_add(us, Ordering::AcqRel);
                match self.tx.try_send(item) {
                    Ok(()) => return Ok(()),
                    Err(TrySendError::Full(back)) | Err(TrySendError::Disconnected(back)) => {
                        self.control.buffered_us.fetch_sub(us, Ordering::AcqRel);
                        item = back;
                    }
                }
            }
            thread::sleep(WAIT_SLICE);
        }
    }

    fn send_boundary(&self, generation: u64, segment: Segment) -> Result<(), PushError> {
        let mut item = Stamped {
            generation,
            segment,
        };
        loop {
            self.check(false)?;
            self.control.boundaries.fetch_add(1, Ordering::AcqRel);
            match self.tx.try_send(item) {
                Ok(()) => return Ok(()),
                Err(TrySendError::Full(back)) | Err(TrySendError::Disconnected(back)) => {
                    self.control.boundaries.fetch_sub(1, Ordering::AcqRel);
                    item = back;
                }
            }
            thread::sleep(WAIT_SLICE);
        }
    }
}

/// The consumer half, read on the audio thread. Cloning it keeps the stream's producer alive for a
/// source that takes over after a `Break`; the producer ends once every clone is dropped.
#[derive(Clone)]
pub struct PcmReader {
    rx: Receiver<Stamped>,
    control: Arc<StreamControl>,
    _token: Arc<()>,
}

impl PcmReader {
    /// The next ready segment, or None when nothing current is queued. Segments from before the
    /// newest requested seek are dropped on the way, a bounded number per call. Never blocks or
    /// locks; the only deallocation is a dropped stale chunk, as a played chunk frees its own.
    pub fn try_next(&self) -> Option<Segment> {
        for _ in 0..STALE_PER_CALL {
            let item = self.rx.try_recv().ok()?;
            self.control.taken(&item.segment);
            if item.generation >= self.control.requested() {
                return Some(item.segment);
            }
        }
        None
    }

    pub fn control(&self) -> &Arc<StreamControl> {
        &self.control
    }

    pub fn buffered_ms(&self) -> u64 {
        self.control.buffered_ms()
    }
}

impl StreamControl {
    // Uncounts a segment that left the queue.
    fn taken(&self, segment: &Segment) {
        match segment {
            Segment::Chunk(chunk) => {
                self.buffered_us
                    .fetch_sub(chunk_us(chunk), Ordering::AcqRel);
            }
            Segment::Break(_) | Segment::End => {
                self.boundaries.fetch_sub(1, Ordering::AcqRel);
            }
        }
    }
}

// A chunk's length in microseconds at its own rate. Zero rate reads as zero length.
fn chunk_us(chunk: &PcmChunk) -> u64 {
    let rate = chunk.spec.sample_rate as u64;
    if rate == 0 {
        return 0;
    }
    chunk.frames() as u64 * 1_000_000 / rate
}

#[cfg(test)]
mod tests;
