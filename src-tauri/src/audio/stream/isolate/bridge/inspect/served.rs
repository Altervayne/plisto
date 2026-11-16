/*
 * The files main serves an inspecting helper, and the byte server that reads them. A file's length
 * is kept outside the lock the byte server holds while it reads, so the calling thread never waits
 * on a read stuck on its storage.
 */

// -- Library Imports --
use std::io::{Read, Seek};
use std::sync::{Arc, Mutex};

use crossbeam_channel::{Receiver, Sender};

// -- Local Imports --
use super::super::byte_server::read_at;
use super::super::lock;
use crate::audio::stream::isolate::wire::{MainFrame, ReadSource, READ_MAX};
use crate::audio::stream::Fault;

/// A byte source main can serve by position.
pub trait ServedSource: Read + Seek + Send {}

impl<T: Read + Seek + Send> ServedSource for T {}

/// One file main serves to the helper, by position.
pub struct Served {
    source: Box<dyn ServedSource>,
    pub(super) len: u64,
    // Where the source's next read starts.
    at: u64,
}

impl Served {
    pub fn new(source: impl ServedSource + 'static, len: u64) -> Served {
        Served {
            source: Box::new(source),
            len,
            at: 0,
        }
    }

    pub fn byte_len(&self) -> u64 {
        self.len
    }
}

/// A served file, shared with the byte server for the length of a step.
pub(in crate::audio::stream::isolate) type Shared = Arc<Mutex<Served>>;

/// A file a step serves, with its length kept outside the lock.
pub(in crate::audio::stream::isolate) struct Offered {
    pub(in crate::audio::stream::isolate) len: u64,
    pub(in crate::audio::stream::isolate) served: Shared,
}

impl Offered {
    pub(in crate::audio::stream::isolate) fn new(served: Served) -> Offered {
        Offered {
            len: served.len,
            served: Arc::new(Mutex::new(served)),
        }
    }
}

/// The file a read asks for, from the audio and the image a step serves. Asking for one the step
/// does not serve is a fault.
pub(in crate::audio::stream::isolate) fn pick(
    served: &[Option<Offered>; 2],
    source: ReadSource,
) -> Result<&Offered, Fault> {
    let index = match source {
        ReadSource::Audio => 0,
        ReadSource::Image => 1,
    };
    served[index].as_ref().ok_or(Fault::Protocol)
}

/// One read for the byte server.
pub(super) struct ReadJob {
    pub(super) served: Shared,
    pub(super) pos: u64,
    pub(super) max: u32,
}

/// Reads what the helper asks for until the helper is dropped. A read stuck on its storage holds
/// only this thread.
pub(super) fn serve_reads(jobs: Receiver<ReadJob>, replies: Sender<MainFrame>) {
    let mut buf = vec![0u8; READ_MAX as usize];
    for ReadJob { served, pos, max } in jobs {
        let reply = {
            let mut served = lock(&served);
            let Served { source, at, .. } = &mut *served;
            read_at(&mut **source, at, pos, &mut buf[..max as usize])
        };
        if replies.send(reply).is_err() {
            return;
        }
    }
}
