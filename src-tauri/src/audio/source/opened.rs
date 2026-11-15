/*
 * The packets of an opened file decoded in a helper, read from the helper's PCM queue without ever
 * blocking. The source plays the file as an in-process decoder plays it: a chained stream's seam ends
 * it, and so does the helper's end once its queue is empty. Starved while the helper is behind, which
 * a local file rarely is, it plays the block of silence any starved source plays.
 *
 * A source started by a seek passes over that seek's `Break`; a seek's `Break` it was not started
 * for ends it, so a source cut by a seek never plays past it.
 */

// -- Library Imports --
use std::sync::Arc;

// -- Local Imports --
use super::{Packets, Pulled};
use crate::audio::stream::isolate::file::FileDecode;
use crate::audio::stream::{Seam, Segment};

pub(in crate::audio) struct OpenedPackets {
    decode: Arc<FileDecode>,
    // The seek this source starts from: its `Break` is passed over.
    after_seek: Option<u64>,
}

impl OpenedPackets {
    pub(in crate::audio) fn new(decode: Arc<FileDecode>, after_seek: Option<u64>) -> Self {
        Self { decode, after_seek }
    }
}

impl Packets for OpenedPackets {
    fn next(&mut self) -> Pulled {
        // Read before the queue: an end seen here means everything the helper queued is in it.
        let ended = self.decode.end().is_some();
        let reader = self.decode.reader();
        let mut segment = reader.try_next();
        if let Some(Segment::Break(Seam::Seek(generation))) = segment {
            if self.after_seek.take() == Some(generation) {
                segment = reader.try_next();
            }
        }
        match segment {
            Some(Segment::Chunk(chunk)) => Pulled::Chunk(chunk),
            Some(Segment::Break(_) | Segment::End) => Pulled::Done,
            None if ended && self.decode.drained() => Pulled::Done,
            None => Pulled::Starved,
        }
    }

    fn duration_secs(&self) -> Option<f64> {
        self.decode.info()?.duration_secs
    }

    fn file_decode(&self) -> Option<&Arc<FileDecode>> {
        Some(&self.decode)
    }
}
