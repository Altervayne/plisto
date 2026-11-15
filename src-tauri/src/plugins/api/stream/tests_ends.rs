/*
 * How a stream item ends: every path, its reason and detail, who is told, and that each end lands
 * once whoever reports it first.
 */

// -- Library Imports --
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::{json, Value};

// -- Local Imports --
use super::test_link::{pcm, until, Bench, Plugin, A, B, RADIO};

/// Room for the hub's own start time, read a moment after the test's.
const SLACK: Duration = Duration::from_secs(1);
use super::{Gone, Producer, StreamEvent, DECODER, FORMAT};
use crate::audio::stream::{DecodeEnd, Fault, Segment, Unsupported, NO_AUDIO_MS, STALL_MS};
use crate::audio::{StreamEndReason, StreamPhase, StreamSignal};
use crate::plugins::api::error::ApiCode;
use crate::plugins::api::Caller;
use crate::plugins::lifecycle::disable;
use crate::plugins::manifest::{Capability, Tier};
use crate::plugins::test_kit::{ui, Kit, ID};

/// Every end notice sent so far, as reason and detail.
fn ends(bench: &Bench) -> Vec<(StreamEndReason, Option<&'static str>)> {
    let ends = bench.link.ends.lock().unwrap();
    ends.iter().map(|end| (end.reason, end.detail)).collect()
}

/// The `ended` events plugin `id` was sent, as item, reason and detail.
fn ended(bench: &Bench, id: &str) -> Vec<(i64, StreamEndReason, Option<&'static str>)> {
    bench
        .link
        .owner_events(id)
        .into_iter()
        .filter_map(|event| match event {
            StreamEvent::Ended {
                item,
                reason,
                detail,
            } => Some((item, reason, detail)),
            _ => None,
        })
        .collect()
}

fn last_end(bench: &Bench, id: &str) -> Value {
    bench.call(id, "stream.state", json!({})).unwrap()["last_end"].clone()
}

#[test]
fn push_end_finishes() {
    let bench = Bench::one();
    let (item, seat) = bench.push_item(A, pcm());
    let data = STANDARD.encode(vec![0u8; 8_000]);
    bench
        .call(A, "stream.push", json!({ "item": item, "data_b64": data }))
        .unwrap();
    bench
        .call(A, "stream.end", json!({ "item": item }))
        .unwrap();
    // The decoder queues the audio and the end; the engine plays it out and reports the end.
    let mut ended_at_end = false;
    let played = until(|| {
        while let Some(segment) = seat.pcm.try_next() {
            ended_at_end |= matches!(segment, Segment::End);
        }
        ended_at_end
    });
    assert!(played, "the end never reached the queue");
    let pushed_after = json!({ "item": item, "data_b64": STANDARD.encode([0u8; 2]) });
    assert_eq!(
        bench.call(A, "stream.push", pushed_after).unwrap_err().code,
        ApiCode::InvalidArgs
    );
    seat.signals
        .send(StreamSignal::Ended(item, StreamEndReason::Finished))
        .unwrap();
    bench.api().streams().drain(Instant::now());
    assert_eq!(ended(&bench, A), [(item, StreamEndReason::Finished, None)]);
    assert!(
        bench.link.stream_ends().is_empty(),
        "the engine already knows"
    );
    assert_eq!(
        last_end(&bench, A),
        json!({ "reason": "finished", "detail": null })
    );
}

#[test]
fn a_second_play_replaces_and_tells_the_first_owner() {
    let bench = Bench::new(&[
        Plugin(A, Tier::Ui, &[Capability::PlaybackStream]),
        Plugin(B, Tier::Ui, &[Capability::PlaybackStream]),
    ]);
    let (first, first_seat) = bench.push_item(A, pcm());
    let (second, _) = bench.push_item(B, pcm());
    assert!(first_seat.control.is_cancelled());
    assert_eq!(ended(&bench, A), [(first, StreamEndReason::Replaced, None)]);
    assert!(ended(&bench, B).is_empty());
    // The new `StreamStart` drops the old seat; no `StreamEnd` races it.
    assert!(bench.link.stream_ends().is_empty());
    assert_eq!(bench.api().streams().now().unwrap().item, second);
    // The engine's own report of the replacement changes nothing more.
    first_seat
        .signals
        .send(StreamSignal::Ended(first, StreamEndReason::Replaced))
        .unwrap();
    bench.api().streams().drain(Instant::now());
    assert_eq!(ended(&bench, A).len(), 1);
    assert_eq!(bench.api().streams().now().unwrap().item, second);
}

#[test]
fn the_replaced_owner_reads_replaced_in_last_end() {
    let bench = Bench::one();
    let (first, _) = bench.push_item(A, pcm());
    let (second, _) = bench.push_item(A, pcm());
    let state = bench.call(A, "stream.state", json!({})).unwrap();
    assert_eq!(state["item"], second);
    assert_eq!(
        state["last_end"],
        json!({ "reason": "replaced", "detail": null })
    );
    let old = bench.call(A, "stream.stop", json!({ "item": first }));
    assert_eq!(old.unwrap_err().code, ApiCode::NotFound);
    // A local play: the engine ends the item and reports it.
    let hub = bench.api().streams().clone();
    hub.handle(
        StreamSignal::Ended(second, StreamEndReason::Replaced),
        Instant::now(),
    );
    assert_eq!(
        last_end(&bench, A),
        json!({ "reason": "replaced", "detail": null })
    );
    assert_eq!(
        bench.call(A, "stream.state", json!({})).unwrap()["item"],
        Value::Null
    );
    // Held for a minute only.
    hub.tick(Instant::now() + Duration::from_secs(61));
    assert_eq!(last_end(&bench, A), Value::Null);
}

#[test]
fn finish_is_idempotent_from_engine_and_hub() {
    let bench = Bench::one();
    let (item, seat) = bench.push_item(A, pcm());
    let hub = bench.api().streams().clone();
    // The engine and the hub both end it; the first one counts.
    hub.handle(
        StreamSignal::Ended(item, StreamEndReason::User),
        Instant::now(),
    );
    hub.finish(item, StreamEndReason::Stopped, None);
    hub.decode_ended(item, DecodeEnd::Corrupt, Instant::now());
    assert_eq!(ends(&bench), [(StreamEndReason::User, None)]);
    assert_eq!(ended(&bench, A), [(item, StreamEndReason::User, None)]);
    assert!(bench.link.stream_ends().is_empty());
    assert!(seat.control.is_cancelled());

    // The hub first: the engine is told once, and its own late report changes nothing.
    let (item, _) = bench.push_item(A, pcm());
    hub.finish(item, StreamEndReason::Stopped, None);
    hub.finish(item, StreamEndReason::Stopped, None);
    hub.handle(
        StreamSignal::Ended(item, StreamEndReason::User),
        Instant::now(),
    );
    assert_eq!(bench.link.stream_ends(), [(item, StreamEndReason::Stopped)]);
    assert_eq!(ended(&bench, A).len(), 2);
}

#[test]
fn helper_faults_map_to_their_end_reasons() {
    let bench = Bench::one();
    let hub = bench.api().streams().clone();
    let cases = [
        (
            DecodeEnd::Isolated(Fault::Spawn),
            StreamEndReason::Unsupported,
            Some(DECODER),
        ),
        (
            DecodeEnd::Isolated(Fault::Memory),
            StreamEndReason::Unsupported,
            Some(FORMAT),
        ),
        (
            DecodeEnd::Isolated(Fault::Crashed),
            StreamEndReason::Unsupported,
            Some(FORMAT),
        ),
        (
            DecodeEnd::Isolated(Fault::Spun),
            StreamEndReason::Unsupported,
            Some(FORMAT),
        ),
        (
            DecodeEnd::Isolated(Fault::Protocol),
            StreamEndReason::Unsupported,
            Some(FORMAT),
        ),
        (
            DecodeEnd::Isolated(Fault::Hung),
            StreamEndReason::Stalled,
            None,
        ),
        (
            DecodeEnd::Panicked,
            StreamEndReason::Unsupported,
            Some(FORMAT),
        ),
        (
            DecodeEnd::Corrupt,
            StreamEndReason::Unsupported,
            Some(FORMAT),
        ),
        (
            DecodeEnd::Failed(Unsupported::Codec),
            StreamEndReason::Unsupported,
            Some("codec"),
        ),
        (
            DecodeEnd::Failed(Unsupported::Playlist),
            StreamEndReason::Unsupported,
            Some("playlist"),
        ),
        (DecodeEnd::SourceBroken, StreamEndReason::ProducerGone, None),
    ];
    for (end, reason, detail) in cases {
        let (item, _) = bench.push_item(A, pcm());
        hub.decode_ended(item, end, Instant::now());
        assert_eq!(
            ended(&bench, A).last(),
            Some(&(item, reason, detail)),
            "{end:?}"
        );
        assert_eq!(
            bench.link.stream_ends().last(),
            Some(&(item, reason)),
            "{end:?}"
        );
    }
    // These end nothing: the item plays out, or whoever cancelled has already ended it.
    for end in [
        DecodeEnd::Finished,
        DecodeEnd::Cancelled,
        DecodeEnd::ReaderGone,
    ] {
        let (item, _) = bench.push_item(A, pcm());
        hub.decode_ended(item, end, Instant::now());
        assert_eq!(bench.api().streams().now().unwrap().item, item, "{end:?}");
    }
}

#[test]
fn a_push_whose_bytes_never_decode_ends_no_audio() {
    let bench = Bench::one();
    let accepted = Instant::now();
    let (item, seat) = bench.push_item(A, json!({ "format": "mp3" }));
    let hub = bench.api().streams().clone();
    // Bytes keep arriving and the decoder keeps reading them, but no audio ever comes out.
    let data = STANDARD.encode(vec![0x55u8; 4_096]);
    for step in 0..20u64 {
        bench
            .call(A, "stream.push", json!({ "item": item, "data_b64": data }))
            .unwrap();
        hub.drain(accepted + Duration::from_millis(step * 900));
    }
    assert!(until(|| bench
        .link
        .media_read
        .load(std::sync::atomic::Ordering::Acquire)
        > 0));
    assert!(ended(&bench, A).is_empty());
    hub.drain(accepted + Duration::from_millis(NO_AUDIO_MS) + SLACK);
    assert_eq!(ended(&bench, A), [(item, StreamEndReason::NoAudio, None)]);
    assert_eq!(bench.link.stream_ends(), [(item, StreamEndReason::NoAudio)]);
    assert!(seat.control.is_cancelled(), "the decoder is cancelled");
}

#[test]
fn a_push_left_buffering_ends_stalled() {
    let bench = Bench::one();
    let (item, seat) = bench.push_item(A, pcm());
    let hub = bench.api().streams().clone();
    let data = STANDARD.encode(vec![0u8; 32_000]);
    bench
        .call(A, "stream.push", json!({ "item": item, "data_b64": data }))
        .unwrap();
    assert!(until(|| seat.control.chunks_queued() > 0));
    let t0 = Instant::now();
    hub.drain(t0);
    seat.signals
        .send(StreamSignal::Phase(item, StreamPhase::Playing))
        .unwrap();
    seat.signals
        .send(StreamSignal::Phase(item, StreamPhase::Buffering))
        .unwrap();
    hub.drain(t0);
    assert!(bench.link.owner_events(A).contains(&StreamEvent::State {
        item,
        state: super::NowState::Buffering
    }));
    hub.drain(t0 + Duration::from_millis(STALL_MS - 100));
    assert!(ended(&bench, A).is_empty());
    hub.drain(t0 + Duration::from_millis(STALL_MS + 100));
    assert_eq!(ended(&bench, A), [(item, StreamEndReason::Stalled, None)]);
}

#[test]
fn forget_when_not_serving_ends_with_plugin_gone() {
    let bench = Bench::one();
    for (gone, detail) in [
        (Gone::Off, None),
        (Gone::Update, Some("update")),
        (Gone::Consent, Some("consent")),
        (Gone::SafeMode, Some("safe_mode")),
    ] {
        let (item, _) = bench.push_item(A, pcm());
        let withdrawn = bench.plugins.withdraw(A);
        bench.plugins.stop_because(A, gone);
        drop(withdrawn);
        assert_eq!(
            ends(&bench).last(),
            Some(&(StreamEndReason::PluginGone, detail))
        );
        assert_eq!(
            bench.link.stream_ends().last(),
            Some(&(item, StreamEndReason::PluginGone))
        );
        // A plugin that is gone is not told.
        assert!(ended(&bench, A).iter().all(|(i, _, _)| *i != item));
    }
}

#[test]
fn forget_while_serving_ends_push_and_keeps_pull() {
    let bench = Bench::new(&[Plugin(
        A,
        Tier::Native,
        &[Capability::PlaybackStream, Capability::Network],
    )]);
    let hub = bench.api().streams().clone();
    // A pushed item from the child ends when the child goes; a frame going leaves it alone.
    let args = json!({ "source": { "push": pcm() }, "title": "Child" });
    let item = bench
        .call_as(Caller::Child, A, "stream.play", args)
        .unwrap()["item"]
        .as_i64()
        .unwrap();
    hub.forget(A, Gone::Off, Producer::Frame);
    assert_eq!(hub.now().unwrap().item, item);
    bench.api().forget_run(A);
    assert_eq!(
        ended(&bench, A),
        [(item, StreamEndReason::ProducerGone, None)]
    );

    // A fetched item plays on through a crash.
    let pull = json!({ "source": { "url": format!("{RADIO}/live") }, "title": "Radio" });
    let item = bench
        .call_as(Caller::Child, A, "stream.play", pull)
        .unwrap()["item"]
        .as_i64()
        .unwrap();
    bench.api().forget_run(A);
    bench.api().forget(A);
    assert_eq!(hub.now().unwrap().item, item);
    assert_eq!(ended(&bench, A).len(), 1);
}

#[test]
fn a_play_racing_forget_is_unavailable_or_ends_plugin_gone() {
    for _ in 0..8 {
        let kit = Kit::new();
        kit.install(&ui("1.0.0", &["playback.stream"]));
        kit.enable(&["playback.stream"]);
        let link = std::sync::Arc::new(super::test_link::FakeLink::default());
        let api = kit.plugins.api().clone();
        api.streams().attach(link.clone());
        let enabled = kit.plugins.enabled_set();
        let args = json!({ "source": { "push": pcm() }, "title": "Race" }).to_string();
        let admitted = crate::plugins::api::admit(
            &enabled,
            &api,
            ID,
            "stream.play",
            args.len(),
            Instant::now(),
        )
        .unwrap();
        let host = crate::plugins::api::FakeHost::default();
        let data = kit.data.clone();
        let play = std::thread::spawn(move || {
            crate::plugins::api::run(&admitted, &args, &data, &host, &api)
        });
        disable(&kit.data, &kit.plugins, ID).unwrap();
        let result = play.join().unwrap();
        match result {
            Err(error) => {
                assert_eq!(error.code, ApiCode::Unavailable);
                assert!(link.starts().is_empty());
            }
            Ok(reply) => {
                let item = reply["item"].as_i64().unwrap();
                let notices = link.ends.lock().unwrap().clone();
                assert_eq!(notices.len(), 1, "seated, then ended");
                assert_eq!(notices[0].reason, StreamEndReason::PluginGone);
                assert_eq!(notices[0].detail, None);
                assert_eq!(notices[0].plugin_name, "Demo");
                assert_eq!(link.stream_ends(), [(item, StreamEndReason::PluginGone)]);
            }
        }
        assert!(
            kit.plugins.api().streams().now().is_none(),
            "nothing outlives the plugin"
        );
    }
}

#[test]
fn a_frame_gone_ends_only_what_its_frames_pushed() {
    let bench = Bench::one();
    let (item, _) = bench.push_item(A, pcm());
    bench.api().streams().forget(A, Gone::Off, Producer::Child);
    assert_eq!(bench.api().streams().now().unwrap().item, item);
    bench.api().streams().forget(A, Gone::Off, Producer::Frame);
    assert_eq!(
        ended(&bench, A),
        [(item, StreamEndReason::ProducerGone, None)]
    );
}
