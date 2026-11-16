/*
 * A pull item across the pause hold and across a plugin that leaves the serving set for a moment:
 * the fresh epoch's limits, a second hold, and a reconnect that waits the plugin out.
 */

// -- Library Imports --
use std::sync::atomic::Ordering;
use std::time::Duration;

use serde_json::json;

// -- Local Imports --
use super::test_link::A;
use super::tests_pull::{until, until_epoch, Pull, SETTLE};
use super::NowState;
use crate::audio::stream::{LIVE_PAUSE_HOLD_MS, NO_AUDIO_MS, RECONNECT_BACKOFF_MS};
use crate::audio::{StreamEndReason, StreamItem, StreamPhase};

/// Pauses the seated item past the hold, takes the fresh epoch, and resumes it as the engine does:
/// with no source attached, in buffering.
async fn hold_and_resume(p: &Pull, seat: &StreamItem, connections: usize) {
    p.signal(seat, StreamPhase::Paused);
    // The feeder sees the pause before the clock passes the hold.
    assert!(until(|| p.fx.server().streamed() > 0).await);
    tokio::time::sleep(SETTLE).await;
    p.clock.advance(Duration::from_millis(LIVE_PAUSE_HOLD_MS));
    let _ = until_epoch(p).await;
    p.signal(seat, StreamPhase::Buffering);
    assert_eq!(p.shown(), Some(NowState::Reconnecting));
    assert!(until(|| p.fx.connections() == connections).await);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_epoch_whose_new_head_yields_no_audio_ends_no_audio() {
    let p = Pull::new().await;
    let (_, seat) = p.play(&p.fx.url("/radio"), json!({})).unwrap();
    hold_and_resume(&p, &seat, 2).await;
    assert!(
        until(|| p.facts().len() == 2).await,
        "the new epoch decodes"
    );
    // The audio clock restarted at the new head.
    p.clock.advance(Duration::from_millis(NO_AUDIO_MS - 1));
    p.drain();
    assert!(p.ends().is_empty());
    p.clock.advance(Duration::from_millis(1));
    p.drain();
    assert_eq!(p.ends(), [(StreamEndReason::NoAudio, None)]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_second_hold_still_reconnects() {
    let p = Pull::new().await;
    let (_, seat) = p.play(&p.fx.url("/radio"), json!({})).unwrap();
    hold_and_resume(&p, &seat, 2).await;
    p.signal(&seat, StreamPhase::Playing);
    assert_eq!(p.shown(), Some(NowState::Playing));
    hold_and_resume(&p, &seat, 3).await;
    p.signal(&seat, StreamPhase::Playing);
    assert_eq!(p.shown(), Some(NowState::Playing));
    assert!(p.ends().is_empty());
    assert_eq!(p.bench.link.media_decodes.load(Ordering::Acquire), 3);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_plugin_back_in_the_serving_set_reconnects_and_plays() {
    let p = Pull::new().await;
    p.play(&p.fx.url("/radio-drop?ms=100"), json!({})).unwrap();
    assert!(until(|| p.shown() == Some(NowState::Reconnecting)).await);
    let withdrawn = p.bench.plugins.withdraw(A);
    p.clock
        .advance(Duration::from_millis(RECONNECT_BACKOFF_MS[0]));
    tokio::time::sleep(SETTLE).await;
    assert_eq!(p.fx.connections(), 1, "no connect while out of the set");
    drop(withdrawn);
    p.clock
        .advance(Duration::from_millis(RECONNECT_BACKOFF_MS[1]));
    assert!(until(|| p.fx.connections() == 2).await);
    let read = || p.bench.link.media_read.load(Ordering::Acquire);
    let before = read();
    assert!(until(|| read() > before).await, "it plays again");
    assert!(p.ends().is_empty(), "{:?}", p.ends());
}
