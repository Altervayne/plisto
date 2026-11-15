/*
 * The packets of a stream source, read from the stream's PCM queue without ever blocking. A source
 * covers one run of the stream: a `Break` or `End` in the queue ends it, and the edge it met is left
 * in an `EdgeCell` the engine reads once the sink has dropped the source. A run that follows a seek
 * passes over that seek's `Break`, so it does not matter which source met it. A spec change does not
 * end a run: the source refills eagerly, so the output converter reads the new layout from its first
 * sample.
 */

// -- Library Imports --
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;

// -- Local Imports --
use super::{Packets, Pulled};
use crate::audio::stream::{PcmReader, Seam, Segment};

/// Why a stream source stopped taking packets.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::audio) enum Edge {
    /// Still taking packets.
    Open,
    End,
    Chain,
    Seek(u64),
}

/// One source's `Edge`, written on the audio thread and read on the engine thread.
#[derive(Default)]
pub(in crate::audio) struct EdgeCell {
    kind: AtomicU8,
    generation: AtomicU64,
}

impl EdgeCell {
    fn set(&self, edge: Edge) {
        let kind = match edge {
            Edge::Open => 0,
            Edge::End => 1,
            Edge::Chain => 2,
            Edge::Seek(generation) => {
                self.generation.store(generation, Ordering::Relaxed);
                3
            }
        };
        self.kind.store(kind, Ordering::Release);
    }

    pub(in crate::audio) fn get(&self) -> Edge {
        match self.kind.load(Ordering::Acquire) {
            1 => Edge::End,
            2 => Edge::Chain,
            3 => Edge::Seek(self.generation.load(Ordering::Relaxed)),
            _ => Edge::Open,
        }
    }
}

/// Starved when nothing is queued; done at a `Break` or at `End`.
pub(in crate::audio) struct StreamPackets {
    reader: PcmReader,
    edge: Arc<EdgeCell>,
    // The seek this run starts from: its `Break` is passed over, whichever source meets it.
    after_seek: Option<u64>,
}

impl StreamPackets {
    pub(in crate::audio) fn new(
        reader: PcmReader,
        edge: Arc<EdgeCell>,
        after_seek: Option<u64>,
    ) -> Self {
        Self {
            reader,
            edge,
            after_seek,
        }
    }

    fn done(&self, edge: Edge) -> Pulled {
        self.edge.set(edge);
        Pulled::Done
    }
}

impl Packets for StreamPackets {
    fn next(&mut self) -> Pulled {
        let mut segment = self.reader.try_next();
        if let Some(Segment::Break(Seam::Seek(generation))) = segment {
            if self.after_seek.take() == Some(generation) {
                segment = self.reader.try_next();
            }
        }
        match segment {
            Some(Segment::Chunk(chunk)) => {
                self.reader.control().set_starved(false);
                Pulled::Chunk(chunk)
            }
            Some(Segment::Break(Seam::Chain)) => self.done(Edge::Chain),
            Some(Segment::Break(Seam::Seek(generation))) => self.done(Edge::Seek(generation)),
            Some(Segment::End) => self.done(Edge::End),
            None => {
                // The engine tells a queue that never refills apart from a starved one.
                self.reader.control().set_starved(true);
                Pulled::Starved
            }
        }
    }

    fn eager(&self) -> bool {
        true
    }
}
