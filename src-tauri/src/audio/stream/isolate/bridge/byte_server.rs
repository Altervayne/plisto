/*
 * The byte server: answers the helper's reads from the item's byte buffer, one at a time, as the
 * decode thread would read it in-process.
 */

// -- Library Imports --
use std::io::{self, Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crossbeam_channel::{Receiver, Sender};
use symphonia::core::io::MediaSource;

// -- Local Imports --
use super::outbox::{Outbox, Sent};
use super::pump::ReadRequest;
use super::supervise::Outcome;
use crate::audio::stream::isolate::wire::{MainFrame, READ_MAX};

pub(super) struct ByteServer {
    pub(super) source: Box<dyn MediaSource>,
    // Where the source's next read starts.
    pub(super) at: u64,
    pub(super) seekable: bool,
    pub(super) len: Option<u64>,
    pub(super) outbox: Outbox,
    pub(super) outstanding: Arc<AtomicBool>,
}

impl ByteServer {
    pub(super) fn run(mut self, reads: Receiver<ReadRequest>, outcomes: Sender<Outcome>) {
        let mut buf = vec![0u8; READ_MAX as usize];
        for ReadRequest { pos, max } in reads {
            if !read_ok(pos, max, self.at, self.seekable, self.len) {
                let _ = outcomes.send(Outcome::Protocol);
                return;
            }
            let reply = self.read_at(pos, &mut buf[..max as usize]);
            self.outstanding.store(false, Ordering::Release);
            match self.outbox.send(reply) {
                Sent::Done => {}
                Sent::Stopped => return,
                Sent::Gone => {
                    let _ = outcomes.send(Outcome::Closed);
                    return;
                }
                Sent::Stalled => {
                    let _ = outcomes.send(Outcome::Protocol);
                    return;
                }
            }
        }
    }

    // One read at `pos`, as the helper's answer.
    fn read_at(&mut self, pos: u64, buf: &mut [u8]) -> MainFrame {
        read_at(&mut *self.source, &mut self.at, pos, buf)
    }
}

/// One read of `source` at `pos`, as the helper's answer. `at` is where the source's next read
/// starts, and is moved past what is read.
pub(super) fn read_at<S: Read + Seek + ?Sized>(
    source: &mut S,
    at: &mut u64,
    pos: u64,
    buf: &mut [u8],
) -> MainFrame {
    if pos != *at {
        match source.seek(SeekFrom::Start(pos)) {
            Ok(moved) => *at = moved,
            // A finished body that stopped short of the target.
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return MainFrame::Eof,
            Err(_) => return MainFrame::Broken,
        }
    }
    loop {
        match source.read(buf) {
            Ok(0) => return MainFrame::Eof,
            Ok(n) => {
                *at += n as u64;
                return MainFrame::Data(buf[..n].to_vec());
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => return MainFrame::Broken,
        }
    }
}

/// Whether a `Read` asks for bytes the source can serve: no overflow, within the body, and on an
/// unseekable source exactly where the last read stopped.
pub(super) fn read_ok(pos: u64, max: u32, at: u64, seekable: bool, len: Option<u64>) -> bool {
    if pos.checked_add(u64::from(max)).is_none() {
        return false;
    }
    if !seekable {
        return pos == at;
    }
    len.is_none_or(|len| pos <= len)
}
