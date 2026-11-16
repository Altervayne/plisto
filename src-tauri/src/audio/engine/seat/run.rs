/*
 * The seated stream's transport and tick: what its producer learned, a fresh producer, pause and
 * resume, skips, seeks, the device rebind, and the tick that starts a run once enough is queued,
 * follows starvation and recovery, and starts the next run when a source reached its edge.
 */

// -- Library Imports --
use std::sync::Arc;

// -- Local Imports --
use super::{Attached, Engine, SourceHandles};
use crate::audio::dsp::DspStage;
use crate::audio::feed::FeedCause;
use crate::audio::source::{self, unpack_spec, DecoderSource, Edge, EdgeCell, StreamPackets};
use crate::audio::stream::{PcmReader, StreamControl, REBUFFER_MS, START_MS};
use crate::audio::{SkipDir, StreamEndReason, StreamPhase, StreamSignal};

/// How a cold start went.
enum Start {
    Attached,
    NotReady,
    Ended,
}

impl Engine {
    /// What the item turned out to be once its producer knew: ignored unless `id` is the one seated.
    pub(in crate::audio::engine) fn stream_facts(
        &mut self,
        id: i64,
        live: bool,
        seekable: bool,
        duration: Option<f64>,
    ) {
        let previewing = self.previewing();
        let Some(seat) = self.seating.seat.as_mut().filter(|s| s.id == id) else {
            return;
        };
        seat.live = live;
        seat.seekable = seekable;
        seat.duration = duration.filter(|d| d.is_finite() && *d > 0.0);
        if !previewing {
            self.cur_duration = seat.duration.unwrap_or(0.0);
        }
        self.emit(true);
    }

    /// Gives the seated item a fresh producer, `pcm` and `control`: the attached source is cut and
    /// what the old queue held is never played; the next run starts from the new queue once it
    /// holds enough. The old control is cancelled. Ignored unless `id` is the one seated.
    pub(in crate::audio::engine) fn stream_epoch(
        &mut self,
        id: i64,
        pcm: PcmReader,
        control: Arc<StreamControl>,
    ) {
        let position = self.position_secs();
        let previewing = self.previewing();
        let Some(seat) = self.seating.seat.as_mut().filter(|s| s.id == id) else {
            control.cancel();
            return;
        };
        let cut = seat.let_go();
        if cut {
            seat.carried = position;
        }
        let old = std::mem::replace(&mut seat.reader, pcm);
        seat.held.push(old);
        std::mem::replace(&mut seat.control, control).cancel();
        seat.awaiting = None;
        seat.last_seek = None;
        seat.next_cause = FeedCause::Start;
        if cut && !previewing {
            if let Some(sink) = &self.sink {
                sink.clear();
            }
        }
        self.stream_waits();
    }

    /// Moves the seated stream to `phase` and tells the owner. Outside a preview the engine's
    /// pause flag follows: only `Playing` sounds.
    pub(super) fn set_phase(&mut self, phase: StreamPhase) {
        let previewing = self.previewing();
        let Some(seat) = &mut self.seating.seat else {
            return;
        };
        if seat.phase == phase {
            return;
        }
        let was_playing = seat.phase == StreamPhase::Playing;
        seat.phase = phase;
        seat.signal(StreamSignal::Phase(seat.id, phase));
        if !previewing {
            self.paused = phase != StreamPhase::Playing;
            if was_playing {
                self.emit_spectrum_rest();
            }
        }
    }

    /// Pauses or resumes the item. A resume goes to connecting before the first audio, and to
    /// buffering while no source is attached or the queue is still empty.
    pub(super) fn stream_pause(&mut self, pause: bool) {
        let previewing = self.previewing();
        let Some(seat) = &mut self.seating.seat else {
            return;
        };
        seat.paused_by_user = pause;
        // A sounding preview holds the item; what was asked applies when the preview stops.
        if previewing || pause == (seat.phase == StreamPhase::Paused) {
            self.emit(true);
            return;
        }
        let attached = seat.attached.is_some();
        if pause {
            if attached {
                if let Some(sink) = &self.sink {
                    sink.pause();
                }
            }
            self.set_phase(StreamPhase::Paused);
            self.feed(FeedCause::Pause);
        } else {
            let empty = seat.control.buffered_ms() == 0 && !seat.control.has_boundary();
            let resumed = if !seat.started {
                StreamPhase::Connecting
            } else if attached && seat.awaiting.is_none() && !empty {
                StreamPhase::Playing
            } else {
                StreamPhase::Buffering
            };
            if resumed == StreamPhase::Playing {
                if let Some(sink) = &self.sink {
                    sink.play();
                }
            }
            self.set_phase(resumed);
            self.feed(FeedCause::Resume);
        }
        self.emit(true);
    }

    /// Next or Previous: a skip request to the owner when it takes that skip, else nothing.
    pub(super) fn stream_skip(&mut self, dir: SkipDir) {
        if let Some(seat) = &self.seating.seat {
            if seat.skip.accepts(dir) {
                seat.signal(StreamSignal::Skip(seat.id, dir));
            }
        }
    }

    /// Seeks a seekable item: the sink is cut at once, and the next start waits until the producer
    /// has answered. A newer seek supersedes one not yet answered. Ignored for a live or unseekable
    /// item and before the producer takes seeks.
    pub(super) fn stream_seek(&mut self, secs: f64) {
        let position = self.position_secs();
        let Some(seat) = &mut self.seating.seat else {
            return;
        };
        if !seat.seekable {
            return;
        }
        // The source is cancelled before the request, so it stops taking from the queue first.
        let cut = seat.let_go();
        if cut {
            seat.carried = position;
        }
        match seat.control.request_seek(secs) {
            Some(generation) => {
                self.seek_seq += 1;
                seat.awaiting = Some(generation);
                seat.last_seek = Some(generation);
                seat.carried = secs.max(0.0);
                seat.next_cause = FeedCause::Seek;
            }
            None if !cut => return,
            None => {}
        }
        if cut {
            if let Some(sink) = &self.sink {
                sink.clear();
            }
        }
        if seat.phase != StreamPhase::Paused {
            self.set_phase(StreamPhase::Buffering);
        }
        self.feed(FeedCause::Buffering);
        self.emit(true);
    }

    /// Takes the stream onto a rebuilt sink from the same queue: the producer never notices.
    pub(in crate::audio::engine) fn stream_rebound(&mut self) {
        let position = self.position_secs();
        if let Some(seat) = &mut self.seating.seat {
            if seat.let_go() {
                seat.carried = position;
                seat.next_cause = FeedCause::Device;
                // The old sink went with its sources, so the new one can start at once.
                match self.start_stream() {
                    Start::Attached => {}
                    Start::NotReady => self.stream_waits(),
                    Start::Ended => return,
                }
                self.emit(true);
                return;
            }
        }
        self.feed(FeedCause::Device);
        self.emit(true);
    }

    /// The seated stream's share of the tick. Never runs while a preview sounds.
    pub(in crate::audio::engine) fn stream_tick(&mut self) {
        let Some(seat) = &mut self.seating.seat else {
            return;
        };
        seat.sweep();
        if seat.awaiting.is_some() && !seat.control.seek_pending() {
            seat.awaiting = None;
        }
        let Some(attached) = &seat.attached else {
            self.start_when_ready();
            return;
        };
        // The source's spec can change mid-run; the feed and the play head follow it.
        let spec = unpack_spec(attached.spec.load(std::sync::atomic::Ordering::Relaxed));
        self.cur_rate = spec.sample_rate;
        self.cur_channels = spec.channels;
        // A starved source plays silence and never drains, so a drained sink means it reached its
        // edge.
        if self.sink.as_ref().is_some_and(|s| s.empty()) {
            let edge = attached.edge.get();
            self.next_run(edge);
            return;
        }
        let control = Arc::clone(&seat.control);
        let phase = seat.phase;
        match phase {
            // A producer that is gone with nothing queued is waited out the same way, until the
            // owner ends the item.
            StreamPhase::Playing if control.is_starved() => {
                if let Some(sink) = &self.sink {
                    sink.pause();
                }
                self.set_phase(StreamPhase::Buffering);
                self.feed(FeedCause::Buffering);
                self.emit(true);
            }
            StreamPhase::Buffering if control.is_ready(REBUFFER_MS) => {
                control.set_starved(false);
                if let Some(sink) = &self.sink {
                    sink.play();
                }
                self.set_phase(StreamPhase::Playing);
                self.feed(FeedCause::Buffered);
                self.emit(true);
            }
            _ => {}
        }
    }

    /// Starts the unattached stream once its queue holds enough, unless it is paused, waits for a
    /// seek, or a preview sounds.
    pub(super) fn start_when_ready(&mut self) {
        if self.previewing() {
            return;
        }
        let Some(seat) = &self.seating.seat else {
            return;
        };
        if seat.attached.is_some() || seat.awaiting.is_some() || seat.phase == StreamPhase::Paused {
            return;
        }
        let threshold = if seat.started { REBUFFER_MS } else { START_MS };
        if !seat.control.is_ready(threshold) {
            return;
        }
        if let Start::Attached = self.start_stream() {
            self.emit(true);
        }
    }

    /// Starts the run after a source that reached `edge`: at once, and in buffering when nothing
    /// is queued yet.
    fn next_run(&mut self, edge: Edge) {
        let position = self.position_secs();
        let Some(seat) = &mut self.seating.seat else {
            return;
        };
        seat.let_go();
        seat.carried = position;
        seat.next_cause = match edge {
            Edge::End => {
                self.end_stream(StreamEndReason::Finished, true, true);
                return;
            }
            Edge::Seek(_) => FeedCause::Seek,
            Edge::Chain | Edge::Open => FeedCause::Start,
        };
        match self.start_stream() {
            Start::Attached => self.emit(true),
            Start::NotReady => self.stream_waits(),
            Start::Ended => {}
        }
    }

    // Puts a stream with no source attached into buffering until the queue refills.
    fn stream_waits(&mut self) {
        if self
            .seating
            .seat
            .as_ref()
            .is_some_and(|s| s.phase != StreamPhase::Paused)
        {
            self.set_phase(StreamPhase::Buffering);
            self.feed(FeedCause::Buffering);
        }
        self.emit(true);
    }

    /// Starts the next run of the stream on the sink, cold with a new tap epoch, from the carried
    /// position. Plays unless the item is paused.
    fn start_stream(&mut self) -> Start {
        if self.sink.is_none() {
            return Start::NotReady;
        }
        let Some(seat) = &self.seating.seat else {
            return Start::NotReady;
        };
        let edge = Arc::new(EdgeCell::default());
        let packets = StreamPackets::new(seat.reader.clone(), Arc::clone(&edge), seat.last_seek);
        let carried = seat.carried;
        let control = Arc::clone(&seat.control);
        let stage = DspStage::new(Arc::clone(&self.dsp), 0.0);
        let tap = Some(self.tap.cold());
        let Some(src) = DecoderSource::new(packets, carried, stage, tap) else {
            control.set_starved(false);
            if edge.get() == Edge::End {
                self.end_stream(StreamEndReason::Finished, true, true);
                return Start::Ended;
            }
            return Start::NotReady;
        };
        let attached = Attached {
            edge,
            cancel: Arc::clone(&src.cancel),
            spec: Arc::clone(&src.live_spec),
        };
        let cut = self.outgoing();
        self.seat(SourceHandles::of(&src));
        let Some(seat) = &mut self.seating.seat else {
            return Start::NotReady;
        };
        self.cur_duration = seat.duration.unwrap_or(0.0);
        seat.attached = Some(attached);
        seat.started = true;
        let cause = seat.next_cause;
        let paused = seat.phase == StreamPhase::Paused;
        if let Some(sink) = &self.sink {
            sink.clear();
            source::append_cold(sink, src, cut.as_ref());
            sink.set_volume(self.output_volume());
            if paused {
                sink.pause();
            } else {
                sink.play();
            }
        }
        if !paused {
            self.set_phase(StreamPhase::Playing);
        }
        self.feed(cause);
        Start::Attached
    }
}
