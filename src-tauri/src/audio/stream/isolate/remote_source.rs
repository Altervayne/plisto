/*
 * The decode helper's byte source. It holds no bytes: each read sends a `Read` for the position it
 * is at and blocks on the main process's answer, and a seek only moves that position. The main
 * process serves the reads from its own buffer, so the bytes never live in the helper.
 */

// -- Library Imports --
use std::io::{self, Read, Seek, SeekFrom};

use crossbeam_channel::Receiver;
use symphonia::core::io::MediaSource;

// -- Local Imports --
use super::helper::{send, Outlet};
use super::wire::{HelperFrame, MainFrame, ReadSource, READ_MAX};

pub(super) struct RemoteSource {
    out: Outlet,
    // `Data`, `Eof` and `Broken`, in the order the reads were sent.
    replies: Receiver<MainFrame>,
    source: ReadSource,
    pos: u64,
    seekable: bool,
    len: Option<u64>,
}

impl RemoteSource {
    pub(super) fn new(
        out: Outlet,
        replies: Receiver<MainFrame>,
        seekable: bool,
        len: Option<u64>,
    ) -> RemoteSource {
        RemoteSource {
            out,
            replies,
            source: ReadSource::Audio,
            pos: 0,
            seekable,
            len,
        }
    }

    /// The same source, reading `source`'s bytes instead of the audio.
    pub(super) fn reading(self, source: ReadSource) -> RemoteSource {
        RemoteSource { source, ..self }
    }
}

// The main process is gone, or its byte source broke.
fn broken() -> io::Error {
    io::Error::new(io::ErrorKind::BrokenPipe, "the byte source broke")
}

impl Read for RemoteSource {
    /// Blocks until the main process answers with at least one byte, the end, or a broken source.
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() || self.len.is_some_and(|len| self.pos >= len) {
            return Ok(0);
        }
        let max = buf.len().min(READ_MAX as usize);
        let read = HelperFrame::Read {
            source: self.source,
            pos: self.pos,
            max: max as u32,
        };
        send(&self.out, &read).map_err(|_| broken())?;
        match self.replies.recv() {
            Ok(MainFrame::Data(bytes)) if bytes.len() <= max => {
                buf[..bytes.len()].copy_from_slice(&bytes);
                self.pos += bytes.len() as u64;
                Ok(bytes.len())
            }
            Ok(MainFrame::Eof) => Ok(0),
            Ok(MainFrame::Data(_)) => Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "more bytes than were asked for",
            )),
            _ => Err(broken()),
        }
    }
}

impl Seek for RemoteSource {
    /// Moves the read position; a target outside the body fails, as it does on the main process's
    /// buffer. Bytes not there yet are waited for by the next read.
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        if !self.seekable {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "the byte source is not seekable",
            ));
        }
        let target = match (pos, self.len) {
            (SeekFrom::Start(n), _) => n as i128,
            (SeekFrom::Current(d), _) => self.pos as i128 + d as i128,
            (SeekFrom::End(d), Some(len)) => len as i128 + d as i128,
            (SeekFrom::End(_), None) => -1,
        };
        if target < 0 || self.len.is_some_and(|len| target > len as i128) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "seek outside the body",
            ));
        }
        self.pos = target as u64;
        Ok(self.pos)
    }
}

impl MediaSource for RemoteSource {
    fn is_seekable(&self) -> bool {
        self.seekable
    }

    fn byte_len(&self) -> Option<u64> {
        self.len
    }
}
