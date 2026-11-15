/*
 * The source of one queue entry. A library track decodes in-process. A file the user opened (a
 * negative id) decodes in a helper process, so hostile bytes in it end that file instead of the app;
 * it decodes in-process only while no helper can be set up on this machine, and never once a helper
 * has failed on it. Both play as the same source type, so a preload of either joins the other
 * gaplessly.
 */

// -- Library Imports --
use std::path::Path;
use std::sync::Arc;

// -- Local Imports --
use super::opened::OpenedPackets;
use super::{open_decoder, DecoderSource, Packets, Pulled};
use crate::adhoc::is_ad_hoc;
use crate::audio::decode;
use crate::audio::dsp::{DspShared, DspStage};
use crate::audio::stream::isolate::file::{
    file_key, open_file, session, FileDecode, Opening, Seeked,
};
use crate::audio::tap::TapWriter;

/// A queue entry's producer.
pub(in crate::audio) enum TrackPackets {
    Local(decode::Decoder),
    Opened(OpenedPackets),
}

/// A queue entry's source.
pub(in crate::audio) type TrackSource = DecoderSource<TrackPackets>;

/// How the queue came to an entry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::audio) enum Arrival {
    /// The user asked for it: a play, a skip onto it, a seek.
    User,
    /// The queue reached it by itself: a track end, a repeat, a preload or a restore.
    Queue,
}

/// How opening an entry went.
pub(in crate::audio) enum Entry {
    Ready(Box<TrackSource>),
    /// The file ended before the start asked for: it is passed as a track that played out.
    Ended,
    /// An opened file whose helper failed earlier, reached by the queue: passed over unopened.
    Faulted,
    Failed,
}

impl Entry {
    pub(in crate::audio) fn ready(self) -> Option<TrackSource> {
        match self {
            Entry::Ready(src) => Some(*src),
            _ => None,
        }
    }
}

impl Packets for TrackPackets {
    fn next(&mut self) -> Pulled {
        match self {
            TrackPackets::Local(decoder) => Packets::next(decoder),
            TrackPackets::Opened(packets) => packets.next(),
        }
    }

    fn duration_secs(&self) -> Option<f64> {
        match self {
            TrackPackets::Local(decoder) => Packets::duration_secs(decoder),
            TrackPackets::Opened(packets) => packets.duration_secs(),
        }
    }

    fn file_decode(&self) -> Option<&Arc<FileDecode>> {
        match self {
            TrackPackets::Local(_) => None,
            TrackPackets::Opened(packets) => packets.file_decode(),
        }
    }
}

/// Opens queue entry `id` at `path` as `open_source` opens a file: at `start_secs` when one is
/// given, with a DSP stage on `dsp` carrying `gain_db`, writing `tap`.
pub(in crate::audio) fn open_entry(
    id: i64,
    path: &Path,
    start_secs: Option<f64>,
    gain_db: f32,
    dsp: &Arc<DspShared>,
    tap: Option<TapWriter>,
    arrival: Arrival,
) -> Entry {
    let stage = DspStage::new(Arc::clone(dsp), gain_db);
    if is_ad_hoc(id) {
        if arrival == Arrival::Queue && session().is_faulted(&file_key(path)) {
            return Entry::Faulted;
        }
        match open_file(path, start_secs) {
            Opening::Isolated(decode, seeked) => {
                // A file that decoded to its end before the seek was asked plays from the top.
                let start = seeked.and(start_secs).unwrap_or(0.0);
                let packets = TrackPackets::Opened(OpenedPackets::new(decode, seeked));
                return ready(DecoderSource::new(packets, start, stage, tap));
            }
            Opening::Ended => return Entry::Ended,
            Opening::Refused => return Entry::Failed,
            Opening::Unavailable => {}
        }
    }
    let Some(decoder) = open_decoder(path, start_secs) else {
        return Entry::Failed;
    };
    let packets = TrackPackets::Local(decoder);
    ready(DecoderSource::new(
        packets,
        start_secs.unwrap_or(0.0),
        stage,
        tap,
    ))
}

/// `open_entry` for a source or nothing.
pub(in crate::audio) fn open_track(
    id: i64,
    path: &Path,
    start_secs: Option<f64>,
    gain_db: f32,
    dsp: &Arc<DspShared>,
    tap: Option<TapWriter>,
    arrival: Arrival,
) -> Option<TrackSource> {
    open_entry(id, path, start_secs, gain_db, dsp, tap, arrival).ready()
}

/// A source over the helper already decoding an opened file, from the answer to its seek
/// `generation` to `secs`. Waits for that answer and audio after it.
pub(in crate::audio) fn opened_at(
    decode: Arc<FileDecode>,
    generation: u64,
    secs: f64,
    gain_db: f32,
    dsp: &Arc<DspShared>,
    tap: Option<TapWriter>,
) -> Entry {
    match decode.await_seek() {
        Seeked::Audio => {}
        Seeked::Ended => return Entry::Ended,
        Seeked::Failed => return Entry::Failed,
    }
    let stage = DspStage::new(Arc::clone(dsp), gain_db);
    let packets = TrackPackets::Opened(OpenedPackets::new(decode, Some(generation)));
    ready(DecoderSource::new(packets, secs.max(0.0), stage, tap))
}

fn ready(src: Option<TrackSource>) -> Entry {
    src.map_or(Entry::Failed, |src| Entry::Ready(Box::new(src)))
}
