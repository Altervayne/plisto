/*
 * The engine's hold on files the user opened, which decode in helper processes. The current source's
 * helper is held while it plays, and ended as soon as another source with its own helper or none
 * takes over; a seek or a device rebind reuses it. A helper that failed while its file played is
 * reported once: when the queue moves past the file, or when the user leaves it first.
 */

// -- Library Imports --
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

// -- Local Imports --
use super::Engine;
use crate::adhoc::is_ad_hoc;
use crate::audio::queue::advance_index;
use crate::audio::source::{self, Arrival, DecoderSource, Entry, Packets, TrackSource};
use crate::audio::stream::isolate::file::FileDecode;
use crate::audio::tap::TapWriter;
use crate::audio::{PlayerNotice, QueueTrack};

/// A source's opened-file helper, and the source's own cancel flag.
pub(super) struct OpenedSource {
    pub(super) decode: Arc<FileDecode>,
    cancel: Arc<AtomicBool>,
}

impl OpenedSource {
    /// The hold on `src`'s helper; None for a source that decodes in-process.
    pub(super) fn of<P: Packets>(src: &DecoderSource<P>) -> Option<Self> {
        src.file_decode().map(|decode| Self {
            decode: Arc::clone(decode),
            cancel: Arc::clone(&src.cancel),
        })
    }
}

impl Engine {
    /// Opens queue entry `track` on the engine's DSP parameters, writing `tap`. See
    /// `source::open_entry`.
    pub(super) fn open_entry(
        &self,
        track: &QueueTrack,
        start_secs: Option<f64>,
        tap: Option<TapWriter>,
        arrival: Arrival,
    ) -> Entry {
        source::open_entry(
            track.id,
            &track.path,
            start_secs,
            track.gain_db,
            &self.dsp,
            tap,
            arrival,
        )
    }

    /// `open_entry` for an entry the queue reached by itself, as a source or nothing.
    pub(super) fn open_track(
        &self,
        track: &QueueTrack,
        start_secs: Option<f64>,
        tap: Option<TapWriter>,
    ) -> Option<TrackSource> {
        self.open_entry(track, start_secs, tap, Arrival::Queue)
            .ready()
    }

    /// Opens entry `i` of `queue` at `start_secs`, as the queue reaches it by itself. When the file
    /// ends before that start, the queue moves on as at a track end and the next entries open from
    /// their top. Returns the slot that opened.
    pub(super) fn open_onward(
        &self,
        queue: &[QueueTrack],
        i: usize,
        start_secs: Option<f64>,
    ) -> Option<(usize, TrackSource)> {
        let (mut slot, mut start) = (i, start_secs);
        for _ in 0..queue.len() {
            let tap = Some(self.tap.cold());
            match self.open_entry(&queue[slot], start, tap, Arrival::Queue) {
                Entry::Ready(src) => return Some((slot, *src)),
                Entry::Ended => {}
                Entry::Faulted | Entry::Failed => return None,
            }
            slot = advance_index(slot, queue.len(), self.repeat)?;
            start = None;
        }
        None
    }

    /// The current track `track` from `secs`, for a seek or a device rebind. An opened file's
    /// helper that still takes seeks serves it; otherwise the file is opened again. A target at or
    /// past the file's end cuts the current source, so the queue moves on at the next tick. An
    /// opened file that fails the seek is reported.
    pub(super) fn reopen_current(
        &mut self,
        track: &QueueTrack,
        secs: f64,
        tap: Option<TapWriter>,
    ) -> Option<TrackSource> {
        let seated = self
            .opened
            .as_ref()
            .map(|o| (Arc::clone(&o.decode), Arc::clone(&o.cancel)));
        let entry = match &seated {
            Some((decode, cancel)) => match decode.request_seek(secs) {
                Some(generation) => {
                    // The current source stops taking from the helper's queue, and no preload
                    // behind it may take over while the answer is awaited.
                    self.clear_pending();
                    cancel.store(true, Ordering::Relaxed);
                    let decode = Arc::clone(decode);
                    source::opened_at(decode, generation, secs, track.gain_db, &self.dsp, tap)
                }
                None => self.open_entry(track, Some(secs), tap, Arrival::User),
            },
            None => self.open_entry(track, Some(secs), tap, Arrival::User),
        };
        match entry {
            Entry::Ready(src) => Some(*src),
            Entry::Ended => {
                if let Some((_, cancel)) = seated {
                    self.clear_pending();
                    cancel.store(true, Ordering::Relaxed);
                }
                None
            }
            Entry::Faulted | Entry::Failed => {
                if is_ad_hoc(track.id) {
                    self.notice_current_file();
                }
                None
            }
        }
    }

    /// Holds the helper of the source now current. A previous helper the new source does not share
    /// is ended, and reported first if it had failed.
    pub(super) fn seat_opened(&mut self, next: Option<OpenedSource>) {
        if let Some(old) = self.opened.take() {
            let kept = next
                .as_ref()
                .is_some_and(|n| Arc::ptr_eq(&n.decode, &old.decode));
            if !kept {
                if old.decode.take_fault() {
                    let _ = self.app.emit("player:error", PlayerNotice::File);
                }
                old.decode.cancel();
            }
        }
        self.opened = next;
    }

    /// Ends the current source's helper, if it has one.
    pub(super) fn drop_opened(&mut self) {
        self.seat_opened(None);
    }

    /// Reports an opened file whose helper failed while it played, once: its source ended as a
    /// file's end does, and the notice says it did not simply end.
    pub(super) fn notice_failed_file(&mut self) {
        if self.opened.as_ref().is_some_and(|o| o.decode.take_fault()) {
            let _ = self.app.emit("player:error", PlayerNotice::File);
        }
    }

    // Reports the current opened file once, whatever its helper does later.
    fn notice_current_file(&mut self) {
        let first = self.opened.as_ref().is_none_or(|o| o.decode.report());
        if first {
            let _ = self.app.emit("player:error", PlayerNotice::File);
        }
    }
}
