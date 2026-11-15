/*
 * The byte buffers a stream decodes from, each split into a writer half (the network feeder or the
 * push path) and a reader half that implements symphonia's `MediaSource` for the decode thread.
 *
 * `ByteRing` is a bounded FIFO for live and push items: unseekable, with no length. Writes never
 * block and never overwrite unread bytes; a write that does not fit is refused whole, and `room`
 * is exact, because the push path's flow control hands that number to the plugin.
 *
 * `GrowingBuffer` keeps a finite body whole as it arrives, up to `FINITE_MAX`, so it is seekable
 * with a known length; a read or a seek past what has arrived waits for it.
 *
 * Only the reader blocks, in `WAIT_SLICE` steps re-checking cancel and a closed source (a decode
 * helper's item that has ended). A writer dropped before
 * `finish` reads as a broken pipe; a reader dropped closes the writer.
 */

// -- Library Imports --
use std::collections::VecDeque;
use std::io::{self, Read, Seek, SeekFrom};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};

use symphonia::core::io::MediaSource;

// -- Local Imports --
use super::{StreamControl, FINITE_MAX, WAIT_SLICE};

/// Why a write did not land.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WriteError {
    /// The bytes do not fit; `room` is what does.
    Full { room: usize },
    /// A growing body would pass `FINITE_MAX`.
    TooLarge,
    /// Cancelled, finished, or the reader is gone.
    Closed,
}

// How the writer half left, as the reader sees it.
#[derive(Clone, Copy, PartialEq, Eq)]
enum WriterState {
    Open,
    Finished,
    Gone,
}

/// Locks `mutex`, recovering the data from a poisoned lock: a panicked peer leaves the bytes valid.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

fn cancelled() -> io::Error {
    io::Error::new(io::ErrorKind::ConnectionAborted, "stream cancelled")
}

fn writer_gone() -> io::Error {
    io::Error::new(io::ErrorKind::BrokenPipe, "stream producer gone")
}

// ---- ByteRing ----

struct Ring {
    bytes: VecDeque<u8>,
    capacity: usize,
    writer: WriterState,
    reader_gone: bool,
}

struct RingShared {
    ring: Mutex<Ring>,
    arrived: Condvar,
    control: Arc<StreamControl>,
}

/// Builds a ring holding at most `capacity` unread bytes.
pub fn byte_ring(capacity: usize, control: Arc<StreamControl>) -> (RingWriter, ByteRing) {
    let shared = Arc::new(RingShared {
        ring: Mutex::new(Ring {
            bytes: VecDeque::with_capacity(capacity),
            capacity,
            writer: WriterState::Open,
            reader_gone: false,
        }),
        arrived: Condvar::new(),
        control,
    });
    (
        RingWriter {
            shared: Arc::clone(&shared),
        },
        ByteRing { shared },
    )
}

/// The writer half of a `ByteRing`. Never blocks.
pub struct RingWriter {
    shared: Arc<RingShared>,
}

impl RingWriter {
    /// Free bytes right now: a write of at most this many lands.
    pub fn room(&self) -> usize {
        let ring = lock(&self.shared.ring);
        ring.capacity - ring.bytes.len()
    }

    /// Appends all of `data`, or nothing. Returns the room left after it.
    pub fn try_write(&self, data: &[u8]) -> Result<usize, WriteError> {
        let mut ring = lock(&self.shared.ring);
        if ring.writer != WriterState::Open
            || ring.reader_gone
            || self.shared.control.is_cancelled()
        {
            return Err(WriteError::Closed);
        }
        let room = ring.capacity - ring.bytes.len();
        if data.len() > room {
            return Err(WriteError::Full { room });
        }
        ring.bytes.extend(data);
        drop(ring);
        self.shared.arrived.notify_one();
        Ok(room - data.len())
    }

    /// Marks the end of the bytes: the reader drains what is left, then reads end of stream.
    pub fn finish(self) {
        self.close(WriterState::Finished);
    }

    fn close(&self, state: WriterState) {
        let mut ring = lock(&self.shared.ring);
        if ring.writer == WriterState::Open {
            ring.writer = state;
        }
        drop(ring);
        self.shared.arrived.notify_all();
    }
}

impl Drop for RingWriter {
    fn drop(&mut self) {
        self.close(WriterState::Gone);
    }
}

/// The reader half of a ring, read by the decode thread. Unseekable, with no length.
pub struct ByteRing {
    shared: Arc<RingShared>,
}

impl Read for ByteRing {
    /// Blocks until at least one byte, the end, or cancel.
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        let mut ring = lock(&self.shared.ring);
        loop {
            if self.shared.control.reads_stopped() {
                return Err(cancelled());
            }
            if !ring.bytes.is_empty() {
                let n = buf.len().min(ring.bytes.len());
                for (dst, src) in buf.iter_mut().zip(ring.bytes.drain(..n)) {
                    *dst = src;
                }
                return Ok(n);
            }
            match ring.writer {
                WriterState::Finished => return Ok(0),
                WriterState::Gone => return Err(writer_gone()),
                WriterState::Open => {}
            }
            ring = self
                .shared
                .arrived
                .wait_timeout(ring, WAIT_SLICE)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
    }
}

impl Seek for ByteRing {
    fn seek(&mut self, _pos: SeekFrom) -> io::Result<u64> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "a byte ring is not seekable",
        ))
    }
}

impl MediaSource for ByteRing {
    fn is_seekable(&self) -> bool {
        false
    }

    fn byte_len(&self) -> Option<u64> {
        None
    }
}

impl Drop for ByteRing {
    fn drop(&mut self) {
        lock(&self.shared.ring).reader_gone = true;
    }
}

// ---- GrowingBuffer ----

/// The block a growing body is stored in. Growth adds a block and never copies the bytes already
/// held, so a large body never doubles under the lock.
const BODY_BLOCK: usize = 1 << 20;

struct Body {
    blocks: Vec<Box<[u8]>>,
    filled: u64,
    writer: WriterState,
    reader_gone: bool,
}

struct BodyShared {
    body: Mutex<Body>,
    arrived: Condvar,
    len: u64,
    cap: u64,
    block: usize,
    control: Arc<StreamControl>,
}

/// Builds a buffer for a body of exactly `len` bytes. It holds at most `FINITE_MAX` of them.
pub fn growing_buffer(len: u64, control: Arc<StreamControl>) -> (GrowingWriter, GrowingBuffer) {
    growing_with(len, FINITE_MAX, BODY_BLOCK, control)
}

fn growing_with(
    len: u64,
    cap: u64,
    block: usize,
    control: Arc<StreamControl>,
) -> (GrowingWriter, GrowingBuffer) {
    let shared = Arc::new(BodyShared {
        body: Mutex::new(Body {
            blocks: Vec::new(),
            filled: 0,
            writer: WriterState::Open,
            reader_gone: false,
        }),
        arrived: Condvar::new(),
        len,
        cap,
        block,
        control,
    });
    (
        GrowingWriter {
            shared: Arc::clone(&shared),
        },
        GrowingBuffer { shared, pos: 0 },
    )
}

/// The writer half of a `GrowingBuffer`. Never blocks.
pub struct GrowingWriter {
    shared: Arc<BodyShared>,
}

impl GrowingWriter {
    /// Bytes received so far: the offset a resumed download continues from.
    pub fn downloaded(&self) -> u64 {
        lock(&self.shared.body).filled
    }

    /// Appends all of `data`, or nothing when it would run past the stated length (`Full`) or past
    /// `FINITE_MAX` (`TooLarge`).
    pub fn write(&self, data: &[u8]) -> Result<(), WriteError> {
        let shared = &self.shared;
        let mut body = lock(&shared.body);
        if body.writer != WriterState::Open || body.reader_gone || shared.control.is_cancelled() {
            return Err(WriteError::Closed);
        }
        let end = body.filled + data.len() as u64;
        if end > shared.len {
            return Err(WriteError::Full {
                room: (shared.len - body.filled) as usize,
            });
        }
        if end > shared.cap {
            return Err(WriteError::TooLarge);
        }
        let mut rest = data;
        while !rest.is_empty() {
            let off = (body.filled % shared.block as u64) as usize;
            if off == 0 {
                // The last block is sized to what is left, so the body never holds more than `len`.
                let size = (shared.len - body.filled).min(shared.block as u64) as usize;
                body.blocks.push(vec![0u8; size].into_boxed_slice());
            }
            let Some(last) = body.blocks.last_mut() else {
                break;
            };
            let n = rest.len().min(last.len() - off);
            last[off..off + n].copy_from_slice(&rest[..n]);
            body.filled += n as u64;
            rest = &rest[n..];
        }
        drop(body);
        shared.arrived.notify_one();
        Ok(())
    }

    /// Marks the end of the download. A body that stopped short reads as end of stream at the
    /// short end, and a seek past it fails. Call it only for a body that is complete: a feeder that
    /// loses the network must drop the writer instead, or the decoder reads the short body as a
    /// clean end.
    pub fn finish(self) {
        self.close(WriterState::Finished);
    }

    fn close(&self, state: WriterState) {
        let mut body = lock(&self.shared.body);
        if body.writer == WriterState::Open {
            body.writer = state;
        }
        drop(body);
        self.shared.arrived.notify_all();
    }
}

impl Drop for GrowingWriter {
    fn drop(&mut self) {
        self.close(WriterState::Gone);
    }
}

/// The reader half of a growing body, read by the decode thread. Seekable, with the stated length.
pub struct GrowingBuffer {
    shared: Arc<BodyShared>,
    pos: u64,
}

impl GrowingBuffer {
    /// Waits until the body holds `end` bytes or will never hold them. Returns the guard and
    /// whether the bytes are there.
    fn wait_for(&self, end: u64) -> io::Result<(MutexGuard<'_, Body>, bool)> {
        let mut body = lock(&self.shared.body);
        loop {
            if self.shared.control.reads_stopped() {
                return Err(cancelled());
            }
            if body.filled >= end {
                return Ok((body, true));
            }
            match body.writer {
                WriterState::Finished => return Ok((body, false)),
                WriterState::Gone => return Err(writer_gone()),
                WriterState::Open => {}
            }
            body = self
                .shared
                .arrived
                .wait_timeout(body, WAIT_SLICE)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
    }
}

impl Read for GrowingBuffer {
    /// Blocks until at least one byte at the read position, the end, or cancel. One read stops at
    /// a block edge.
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() || self.pos >= self.shared.len {
            return Ok(0);
        }
        let (body, there) = self.wait_for(self.pos + 1)?;
        if !there {
            return Ok(0);
        }
        let block = self.shared.block as u64;
        let held = &body.blocks[(self.pos / block) as usize];
        let off = (self.pos % block) as usize;
        let n = buf
            .len()
            .min(held.len() - off)
            .min((body.filled - self.pos) as usize);
        buf[..n].copy_from_slice(&held[off..off + n]);
        drop(body);
        self.pos += n as u64;
        Ok(n)
    }
}

impl Seek for GrowingBuffer {
    /// Blocks until the target has arrived. A target past the stated length, or past where a
    /// finished body stopped, fails.
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        let len = self.shared.len as i128;
        let target = match pos {
            SeekFrom::Start(n) => n as i128,
            SeekFrom::Current(d) => self.pos as i128 + d as i128,
            SeekFrom::End(d) => len + d as i128,
        };
        if target < 0 || target > len {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "seek outside the body",
            ));
        }
        let target = target as u64;
        let (body, there) = self.wait_for(target)?;
        drop(body);
        if !there {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "the body ended before the seek target",
            ));
        }
        self.pos = target;
        Ok(target)
    }
}

impl MediaSource for GrowingBuffer {
    fn is_seekable(&self) -> bool {
        true
    }

    fn byte_len(&self) -> Option<u64> {
        Some(self.shared.len)
    }
}

impl Drop for GrowingBuffer {
    fn drop(&mut self) {
        lock(&self.shared.body).reader_gone = true;
    }
}

#[cfg(test)]
mod tests;
