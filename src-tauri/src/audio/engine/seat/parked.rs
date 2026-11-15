/*
 * Edits of the queue parked under a stream. They touch no sink and start nothing; the parked slot
 * follows its track through them.
 */

// -- Local Imports --
use super::{Engine, Parked, SourceHandles};
use crate::audio::feed::FeedCause;
use crate::audio::queue::{
    clamp_index, enqueue_tracks, index_of_id, insert_after_current, remove_queue_item,
};
use crate::audio::source;
use crate::audio::QueueTrack;

impl Engine {
    /// Re-seats the parked track paused at its position. False when it left the queue or its file
    /// does not open; the end of a stream reports no notice for it.
    pub(super) fn reseat_parked(&mut self, parked: Parked) -> bool {
        let i = match self.queue.get(self.index) {
            Some(t) if t.id == parked.track_id => self.index,
            _ => match index_of_id(&self.queue, parked.track_id) {
                Some(i) => i,
                None => return false,
            },
        };
        let start = (parked.secs > 0.0).then_some(parked.secs);
        // A file that ends before its parked spot moves the queue on, as at its end.
        let Some((i, src)) = self.open_onward(&self.queue, i, start) else {
            return false;
        };
        let cut = self.outgoing();
        self.begin_listen(i, self.queue[i].id);
        self.seat(SourceHandles::of(&src));
        if let Some(sink) = &self.sink {
            sink.clear();
            sink.pause();
            source::append_cold(sink, src, cut.as_ref());
            sink.set_volume(self.output_volume());
        }
        self.paused = true;
        self.playing = true;
        self.feed(FeedCause::Start);
        true
    }

    /// Fills an empty parked slot from the boot restore.
    pub(super) fn load_parked(&mut self, queue: Vec<QueueTrack>, index: usize, secs: f64) {
        if queue.is_empty() || self.seating.parked.is_some() || self.seating.parked_cleared {
            return;
        }
        let i = clamp_index(index, queue.len());
        self.seating.parked = Some(Parked {
            track_id: queue[i].id,
            secs: secs.max(0.0),
        });
        self.queue = queue;
        self.original_order = self.queue.clone();
        self.shuffle = false;
        self.index = i;
        self.emit_queue();
        self.emit(true);
    }

    /// Adds tracks to the parked queue, after the parked track with `next`. Into an empty parked
    /// queue the first of them becomes the parked track, at its start.
    pub(super) fn park_tracks(&mut self, tracks: Vec<QueueTrack>, next: bool) {
        if tracks.is_empty() {
            return;
        }
        let was_empty = self.queue.is_empty();
        let first = if next {
            let anchor = self.queue_anchor();
            insert_after_current(
                &mut self.queue,
                &mut self.original_order,
                self.shuffle,
                self.index,
                anchor,
                tracks,
            )
        } else {
            enqueue_tracks(&mut self.queue, &mut self.original_order, tracks)
        };
        if was_empty {
            self.index = first;
            self.seating.parked = Some(Parked {
                track_id: self.queue[first].id,
                secs: 0.0,
            });
            self.seating.parked_cleared = false;
        } else {
            self.reseat_cursor();
        }
        self.emit_queue();
        self.emit(true);
    }

    /// Removes a parked-queue row. Removing the parked row parks the row that slides into its
    /// place, else the last one, at its start; an emptied queue parks nothing.
    pub(super) fn remove_parked(&mut self, index: usize) {
        let parked_row = self.seating.parked.is_some() && index == self.index;
        if remove_queue_item(
            &mut self.queue,
            &mut self.original_order,
            self.shuffle,
            index,
        )
        .is_none()
        {
            return;
        }
        if parked_row {
            self.index = clamp_index(index, self.queue.len());
            self.seating.parked = self.queue.get(self.index).map(|t| Parked {
                track_id: t.id,
                secs: 0.0,
            });
        } else {
            self.reseat_cursor();
        }
        self.emit_queue();
        self.emit(true);
    }

    /// Empties the parked queue; the stream plays on and a later end stops the engine. Ignored
    /// with no stream seated.
    pub(in crate::audio::engine) fn clear_parked(&mut self) {
        if !self.seating.is_seated() {
            return;
        }
        self.queue.clear();
        self.original_order.clear();
        self.index = 0;
        self.seating.parked = None;
        self.seating.parked_cleared = true;
        self.emit_queue();
        self.emit(true);
    }
}
