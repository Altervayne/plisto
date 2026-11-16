/*
 * What the feeder changes in the hub's session. Each step takes the hub lock briefly, acts only
 * while the item it names is still the one seated, and never waits under it.
 */

// -- Library Imports --
use std::sync::Arc;
use std::time::Instant;

// -- Local Imports --
use crate::audio::stream::{pcm_queue, StreamControl, StreamInput};
use crate::audio::{PlayerCmd, StreamEndReason};
use crate::plugins::api::stream::hub::{publish, Feed, StreamHub, Teller};
use crate::plugins::api::stream::meta::{clean, TEXT_MAX_CHARS};
use crate::plugins::api::stream::{NowState, StreamEvent, DECODER};

impl StreamHub {
    /// The engine state of pull item `id`; None once it is not the one seated.
    pub(super) fn pull_state(&self, id: i64) -> Option<NowState> {
        let session = self.lock();
        session
            .item
            .as_ref()
            .filter(|item| item.id == id)
            .map(|item| item.state)
    }

    /// Takes pull item `id`'s first head: what it is, and its decoding started. A finite item drops
    /// its live line. False when the item went, or ended because its decoding could not start.
    pub(super) fn pull_head(
        &self,
        id: i64,
        live: bool,
        seekable: bool,
        input: StreamInput,
    ) -> bool {
        let Some(link) = self.link() else {
            return false;
        };
        let mut session = self.lock();
        let Some(item) = session.item.as_mut().filter(|item| item.id == id) else {
            return false;
        };
        let Feed::Pull { queue } = &mut item.feed else {
            return false;
        };
        let Some(queue) = queue.take() else {
            return false;
        };
        item.live = live;
        item.seekable = seekable;
        if !live {
            item.meta.now = None;
        }
        // The reconnect is over before the decoding starts, so no `Playing` from the new audio can
        // reach the hub while the item still counts as reconnecting.
        let shown = item.shown();
        if item.reconnecting {
            item.reconnecting = false;
            if !item.heard {
                item.accepted = self.clock().now();
            }
        }
        item.rev += 1;
        link.send(PlayerCmd::StreamFacts {
            id,
            live,
            seekable,
            duration_secs: None,
        });
        publish(&*link, item);
        let state = item.shown();
        if state != shown {
            link.owner(&item.plugin_id, StreamEvent::State { item: id, state });
        }
        if link.decode(input, queue, self.on_end(id)).is_ok() {
            return true;
        }
        eprintln!("plugins: a stream decode helper could not start");
        let reason = StreamEndReason::Unsupported;
        let now = self.clock().now();
        self.end_current(
            &mut session,
            &*link,
            id,
            reason,
            Some(DECODER),
            Teller::Hub,
            now,
        );
        false
    }

    /// Pull item `id` starts or stops reconnecting. A reconnect that lands before any audio came
    /// restarts the item's audio clock at `now`.
    pub(super) fn pull_reconnecting(&self, id: i64, on: bool, now: Instant) {
        let Some(link) = self.link() else {
            return;
        };
        let mut session = self.lock();
        let Some(item) = session.item.as_mut().filter(|item| item.id == id) else {
            return;
        };
        if item.reconnecting == on {
            return;
        }
        if !on && !item.heard {
            item.accepted = now;
        }
        let shown = item.shown();
        item.reconnecting = on;
        let state = item.shown();
        if state != shown {
            item.rev += 1;
            link.now(Some(&item.snapshot()));
            link.owner(&item.plugin_id, StreamEvent::State { item: id, state });
        }
    }

    /// An ICY title for pull item `id`, shown as its live line; empty clears it.
    pub(super) fn icy_title(&self, id: i64, raw: &str) {
        let Some(link) = self.link() else {
            return;
        };
        let mut session = self.lock();
        let Some(item) = session
            .item
            .as_mut()
            .filter(|item| item.id == id && item.live)
        else {
            return;
        };
        let text: String = clean(raw).chars().take(TEXT_MAX_CHARS).collect();
        let now = (!text.is_empty()).then_some(text);
        if item.meta.now != now {
            item.meta.now = now;
            item.rev += 1;
            publish(&*link, item);
        }
    }

    /// Ends pull item `id` for a reason its fetch found. An item whose plugin no longer serves is
    /// left to `forget`, which ends it `plugin_gone`.
    pub(super) fn pull_end(&self, id: i64, reason: StreamEndReason, detail: Option<&'static str>) {
        let Some(link) = self.link() else {
            return;
        };
        let now = self.clock().now();
        let mut session = self.lock();
        let Some(item) = session.item.as_ref().filter(|item| item.id == id) else {
            return;
        };
        if !self.serves(&item.plugin_id) {
            return;
        }
        self.end_current(&mut session, &*link, id, reason, detail, Teller::Hub, now);
    }

    /// Gives pull item `id` a fresh epoch: a new control and PCM queue, the engine switched to
    /// them, and the old control cancelled, which ends the old decoding and byte buffer at once.
    /// The queue's producer half waits for the next head; until then the item's clocks rest, and
    /// it shows as reconnecting until the engine plays again. Returns the new control; None when
    /// the item went or the engine is gone.
    pub(super) fn pull_epoch(&self, id: i64) -> Option<Arc<StreamControl>> {
        let link = self.link()?;
        let mut session = self.lock();
        let item = session.item.as_mut().filter(|item| item.id == id)?;
        if !matches!(item.feed, Feed::Pull { .. }) {
            return None;
        }
        let control = Arc::new(StreamControl::new());
        let (queue, pcm) = pcm_queue(Arc::clone(&control));
        let epoch = PlayerCmd::StreamEpoch {
            id,
            pcm,
            control: Arc::clone(&control),
        };
        if !link.send(epoch) {
            return None;
        }
        std::mem::replace(&mut item.control, Arc::clone(&control)).cancel();
        item.feed = Feed::Pull { queue: Some(queue) };
        item.heard = false;
        item.waiting_since = None;
        let shown = item.shown();
        item.reconnecting = true;
        item.awaiting_audio = true;
        item.rev += 1;
        link.now(Some(&item.snapshot()));
        let state = item.shown();
        if state != shown {
            link.owner(&item.plugin_id, StreamEvent::State { item: id, state });
        }
        Some(control)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;

    use crate::audio::stream::{byte_ring, StreamControl, StreamInput, LIVE_RING};
    use crate::plugins::api::stream::test_link::{Bench, Call, Plugin, A, RADIO};
    use crate::plugins::api::stream::{NowState, StreamEvent};
    use crate::plugins::manifest::{Capability, Tier};

    #[test]
    fn a_head_ends_the_reconnect_before_its_decoding_starts() {
        let grants = &[Capability::PlaybackStream, Capability::Network];
        let bench = Bench::new(&[Plugin(A, Tier::Ui, grants)]);
        // The bench has no network engine, so the item has no feeder: the test plays its part.
        let play = json!({ "source": { "url": format!("{RADIO}/live") }, "title": "Radio" });
        let reply = bench.call(A, "stream.play", play).unwrap();
        let id = reply["item"].as_i64().unwrap();
        let hub = bench.api().streams().clone();
        hub.pull_reconnecting(id, true, hub.clock().now());
        bench.link.calls.lock().unwrap().clear();

        let (_writer, ring) = byte_ring(LIVE_RING, Arc::new(StreamControl::new()));
        let input = StreamInput::Media {
            source: Box::new(ring),
            hint: None,
        };
        assert!(hub.pull_head(id, true, false, input));
        let calls = bench.link.calls.lock().unwrap().clone();
        let decode = calls.iter().position(|call| *call == Call::Decode);
        let decode = decode.expect("the head starts decoding");
        let published = calls[..decode].iter().rev().find_map(|call| match call {
            Call::Now(state) => Some(*state),
            _ => None,
        });
        assert_eq!(published, Some(Some(NowState::Connecting)), "{calls:?}");
        let told = Call::Owner(StreamEvent::State {
            item: id,
            state: NowState::Connecting,
        });
        assert!(calls[..decode].contains(&told), "{calls:?}");
    }
}
