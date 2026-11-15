/*
 * When the hub refuses a play or ends an item on its own: the hold and the close, a play on its way,
 * the stall clock, pushes the item does not take, and what `playback.state` says to whom.
 */

// -- Library Imports --
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::{json, Value};

// -- Local Imports --
use super::test_link::{pcm, until, Bench, Plugin, A, B, RADIO};
use super::StreamEvent;
use crate::audio::stream::STALL_MS;
use crate::audio::{StreamEndReason, StreamPhase, StreamSignal};
use crate::plugins::api::error::ApiCode;
use crate::plugins::manifest::{Capability, Tier};

fn play_args() -> Value {
    json!({ "source": { "push": pcm() }, "title": "T" })
}

fn stalls(bench: &Bench) -> usize {
    bench
        .link
        .owner_events(A)
        .into_iter()
        .filter(|e| {
            matches!(
                e,
                StreamEvent::Ended {
                    reason: StreamEndReason::Stalled,
                    ..
                }
            )
        })
        .count()
}

/// Pushes half a second of `pcm()` audio and waits until the decoder has queued it.
fn half_a_second(bench: &Bench, item: i64, seat: &crate::audio::StreamItem) {
    let data = STANDARD.encode(vec![0u8; 8_000]);
    let args = json!({ "item": item, "data_b64": data });
    bench.call(A, "stream.push", args).unwrap();
    assert!(until(|| seat.control.chunks_queued() > 0));
}

#[test]
fn a_push_gone_quiet_while_still_connecting_ends_stalled() {
    let bench = Bench::one();
    let (item, seat) = bench.push_item(A, pcm());
    half_a_second(&bench, item, &seat);
    // Too little to start, and nothing more comes: the engine stays connecting.
    let hub = bench.api().streams().clone();
    let t0 = Instant::now();
    hub.drain(t0);
    hub.drain(t0 + Duration::from_millis(STALL_MS - 100));
    assert_eq!(stalls(&bench), 0);
    hub.drain(t0 + Duration::from_millis(STALL_MS + 100));
    assert_eq!(stalls(&bench), 1);
    assert_eq!(bench.link.stream_ends(), [(item, StreamEndReason::Stalled)]);
}

#[test]
fn a_paused_item_is_never_counted_as_stalled() {
    let bench = Bench::one();
    let (item, seat) = bench.push_item(A, pcm());
    half_a_second(&bench, item, &seat);
    let hub = bench.api().streams().clone();
    let t0 = Instant::now();
    seat.signals
        .send(StreamSignal::Phase(item, StreamPhase::Buffering))
        .unwrap();
    hub.drain(t0);
    seat.signals
        .send(StreamSignal::Phase(item, StreamPhase::Paused))
        .unwrap();
    hub.drain(t0 + Duration::from_millis(STALL_MS / 2));
    hub.drain(t0 + Duration::from_millis(STALL_MS * 3));
    assert_eq!(stalls(&bench), 0);
    // Back to waiting, the clock starts again from there.
    let resumed = t0 + Duration::from_millis(STALL_MS * 3);
    seat.signals
        .send(StreamSignal::Phase(item, StreamPhase::Buffering))
        .unwrap();
    hub.drain(resumed);
    hub.drain(resumed + Duration::from_millis(STALL_MS - 100));
    assert_eq!(stalls(&bench), 0);
    hub.drain(resumed + Duration::from_millis(STALL_MS + 100));
    assert_eq!(stalls(&bench), 1);
}

#[test]
fn a_play_during_the_update_hold_is_unavailable_until_released() {
    let bench = Bench::one();
    let (item, _) = bench.push_item(A, pcm());
    let hub = bench.api().streams().clone();
    hub.hold();
    let ends = bench.link.ends.lock().unwrap().clone();
    assert_eq!(ends.len(), 1);
    assert_eq!(
        (ends[0].reason, ends[0].detail),
        (StreamEndReason::PluginGone, Some("update"))
    );
    assert_eq!(
        bench.link.stream_ends(),
        [(item, StreamEndReason::PluginGone)]
    );
    let held = bench.call(A, "stream.play", play_args()).unwrap_err();
    assert_eq!(held.code, ApiCode::Unavailable);
    // The plugins' own shutdown then finds nothing to end as `producer_gone`.
    bench.api().forget_run(A);
    bench.api().forget(A);
    assert_eq!(bench.link.ends.lock().unwrap().len(), 1);
    hub.release();
    assert!(bench.call(A, "stream.play", play_args()).is_ok());
}

#[test]
fn a_play_after_close_is_refused() {
    let bench = Bench::one();
    bench.api().streams().close();
    let refused = bench.call(A, "stream.play", play_args()).unwrap_err();
    assert_eq!(refused.code, ApiCode::Unavailable);
    assert!(bench.link.starts().is_empty());
}

#[test]
fn a_second_play_on_its_way_is_busy_after_the_serving_check() {
    let bench = Bench::new(&[
        Plugin(A, Tier::Ui, &[Capability::PlaybackStream]),
        Plugin(B, Tier::Ui, &[Capability::PlaybackStream]),
    ]);
    let hub = bench.api().streams().clone();
    // A play of A is on its way to its seat.
    let first = hub.begin(A);
    let busy = bench.call(A, "stream.play", play_args()).unwrap_err();
    assert_eq!(busy.code, ApiCode::Busy);
    // Shape comes before busy.
    let bad = bench
        .call(A, "stream.play", json!({ "title": "T" }))
        .unwrap_err();
    assert_eq!(bad.code, ApiCode::InvalidArgs);
    // Another plugin is not held up, and replaces whatever plays.
    assert!(bench.call(B, "stream.play", play_args()).is_ok());
    drop(first);
    assert!(bench.call(A, "stream.play", play_args()).is_ok());
    assert_eq!(bench.link.starts().len(), 2);
}

#[test]
fn the_artwork_shape_is_checked_before_a_url_is_weighed() {
    let bench = Bench::one();
    let args = json!({ "source": { "url": RADIO }, "title": "T", "artwork": { "nope": 1 } });
    let refused = bench.call(A, "stream.play", args).unwrap_err();
    assert_eq!(refused.code, ApiCode::InvalidArgs);
    let args = json!({ "source": { "url": RADIO }, "title": "T" });
    assert_eq!(
        bench.call(A, "stream.play", args).unwrap_err().code,
        ApiCode::Denied
    );
}

#[test]
fn a_push_after_the_end_and_a_push_to_a_pull_item_are_refused() {
    let bench = Bench::new(&[Plugin(
        A,
        Tier::Ui,
        &[Capability::PlaybackStream, Capability::Network],
    )]);
    let (item, _) = bench.push_item(A, pcm());
    bench
        .call(A, "stream.end", json!({ "item": item }))
        .unwrap();
    let data = STANDARD.encode([0u8; 4]);
    let after = bench.call(A, "stream.push", json!({ "item": item, "data_b64": data }));
    assert_eq!(after.unwrap_err().code, ApiCode::InvalidArgs);
    // A second end changes nothing.
    assert!(bench.call(A, "stream.end", json!({ "item": item })).is_ok());

    let pull = json!({ "source": { "url": format!("{RADIO}/live") }, "title": "Radio" });
    let item = bench.call(A, "stream.play", pull).unwrap()["item"].clone();
    let pushed = bench.call(A, "stream.push", json!({ "item": item, "data_b64": data }));
    assert_eq!(pushed.unwrap_err().code, ApiCode::InvalidArgs);
    let ended = bench.call(A, "stream.end", json!({ "item": item }));
    assert_eq!(ended.unwrap_err().code, ApiCode::InvalidArgs);
}

#[test]
fn playback_state_says_mine_to_the_owner_only() {
    let bench = Bench::new(&[
        Plugin(
            A,
            Tier::Ui,
            &[Capability::PlaybackStream, Capability::PlaybackRead],
        ),
        Plugin(B, Tier::Ui, &[Capability::PlaybackRead]),
    ]);
    bench.push_item(A, pcm());
    let mine = bench.call(A, "playback.state", json!({})).unwrap();
    assert_eq!(mine["stream"]["mine"], true);
    let theirs = bench.call(B, "playback.state", json!({})).unwrap();
    assert_eq!(theirs["stream"]["mine"], false);
    assert_eq!(theirs["stream"]["title"], "Push");
}
