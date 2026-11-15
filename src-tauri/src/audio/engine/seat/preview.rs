/*
 * The Track Editor's preview and restore with a stream in play. The editor pauses what plays on
 * entry, auditions previews on the sink, stops a sounding preview with the ordinary `Stop`, and sends
 * `RestoreLibrary { secs, playing }` with the values it read on entry when it leaves. A restore carries
 * no id: with an item seated it only resumes a paused item when `playing` says so and never pauses
 * one; after an item ended it brings the parked track back paused where the engine parked it. Only
 * with no stream involved do the command's values reach the library.
 */

// -- Library Imports --
use std::path::PathBuf;

// -- Local Imports --
use super::{AfterItem, Engine, Parked};
use crate::audio::feed::FeedCause;
use crate::audio::{PlayerCmd, StreamPhase};

impl Engine {
    /// Starts a preview. The library, or the seated item's source, leaves the sink and the item is
    /// held paused under the preview. A file that does not open changes nothing.
    pub(super) fn stream_preview(&mut self, path: PathBuf, start_secs: f64, end_secs: f64) {
        let position = self
            .seating
            .seat
            .as_ref()
            .map(|seat| self.stream_position(seat));
        let library = (!self.seating.is_seated() && self.has_library_track())
            .then(|| {
                self.cur_track_id.map(|track_id| Parked {
                    track_id,
                    secs: self.position_secs(),
                })
            })
            .flatten();
        self.preview(path, start_secs, end_secs);
        if !self.previewing() {
            return;
        }
        if library.is_some() {
            self.seating.library = library;
        }
        let Some(seat) = &mut self.seating.seat else {
            return;
        };
        if seat.let_go() {
            seat.carried = position.unwrap_or(seat.carried);
        }
        self.set_phase(StreamPhase::Paused);
        self.emit(true);
    }

    /// Stops a sounding preview with an item seated. The item stays as it was.
    pub(super) fn stop_preview(&mut self) {
        self.stop_playback();
        self.preview_ended();
        self.emit(true);
    }

    /// Hands the engine state back to the seated item once a preview stopped sounding.
    pub(in crate::audio::engine) fn preview_ended(&mut self) {
        if self.seating.is_seated() {
            self.enter_seat();
            self.release_hold();
        }
    }

    /// Lets go of an item the preview held: unless a pause command paused it, it goes on by
    /// itself, cold, in whatever phase its queue gives.
    fn release_hold(&mut self) {
        let Some(seat) = &self.seating.seat else {
            return;
        };
        if seat.paused_by_user || seat.phase != StreamPhase::Paused {
            return;
        }
        let phase = if seat.started {
            StreamPhase::Buffering
        } else {
            StreamPhase::Connecting
        };
        self.set_phase(phase);
        self.feed(FeedCause::Buffering);
        self.start_when_ready();
    }

    /// The restore that ends an editor session. Returns the command when the ordinary library
    /// restore should run it.
    pub(super) fn restore_after_preview(&mut self, secs: f64, playing: bool) -> Option<PlayerCmd> {
        self.seating.library = None;
        if self.seating.is_seated() {
            if self.previewing() {
                self.clear_pending();
                if let Some(sink) = &self.sink {
                    sink.clear();
                }
                self.enter_seat();
                self.release_hold();
            }
            let paused = self
                .seating
                .seat
                .as_ref()
                .is_some_and(|s| s.phase == StreamPhase::Paused);
            if playing && paused {
                self.stream_pause(false);
            } else {
                self.emit(true);
            }
            self.start_when_ready();
            return None;
        }
        match self.seating.after_item.take() {
            Some(AfterItem::Parked(p)) => {
                if !self.reseat_parked(p) {
                    self.stop_playback();
                }
                self.emit(true);
                None
            }
            Some(AfterItem::Stopped) => {
                self.stop_playback();
                self.emit(true);
                None
            }
            None => Some(PlayerCmd::RestoreLibrary { secs, playing }),
        }
    }
}
