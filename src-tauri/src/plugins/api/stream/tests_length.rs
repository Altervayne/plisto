/*
 * A finite pull item's length: taken from what its decoder reported on the item's control, checked,
 * shown in `stream.state` and `StreamNow`, and sent to the engine in a second `StreamFacts`.
 */

// -- Library Imports --
use serde_json::{json, Value};

// -- Local Imports --
use super::test_link::A;
use super::tests_pull::{until, Pull};
use super::watch::DURATION_MAX_SECS;
use crate::audio::{PlayerCmd, StreamItem};

/// The lengths of every `StreamFacts` the engine was sent.
fn lengths(p: &Pull) -> Vec<Option<f64>> {
    let sent = p.bench.link.sent.lock().unwrap();
    sent.iter()
        .filter_map(|cmd| match cmd {
            PlayerCmd::StreamFacts { duration_secs, .. } => Some(*duration_secs),
            _ => None,
        })
        .collect()
}

fn state_length(p: &Pull) -> Value {
    let state = p.bench.call(A, "stream.state", json!({})).unwrap();
    state["duration_secs"].clone()
}

/// Plays a finite `/file` item and waits for its head.
async fn finite(p: &Pull) -> StreamItem {
    let before = lengths(p).len();
    let (_, seat) = p.play(&p.fx.url("/file?stall=1000"), json!({})).unwrap();
    assert!(until(|| lengths(p).len() == before + 1).await);
    seat
}

#[tokio::test(flavor = "multi_thread")]
async fn a_finite_item_reports_the_length_its_file_states() {
    let p = Pull::new().await;
    let seat = finite(&p).await;
    let rev = p.bench.api().streams().now().unwrap().rev;
    assert_eq!(state_length(&p), Value::Null);
    assert!(seat.control.report_media(Some(42.5)));
    p.drain();
    assert_eq!(lengths(&p), [None, Some(42.5)]);
    assert_eq!(state_length(&p), json!(42.5));
    let now = p.bench.api().streams().now().unwrap();
    assert_eq!(now.duration_secs, Some(42.5));
    assert!(now.rev > rev);
    // Taken once.
    p.drain();
    assert_eq!(lengths(&p).len(), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unusable_length_is_dropped() {
    let p = Pull::new().await;
    for secs in [0.0, -1.0, f64::NAN, f64::INFINITY, DURATION_MAX_SECS + 1.0] {
        let seat = finite(&p).await;
        seat.control.report_media(Some(secs));
        p.drain();
        assert_eq!(lengths(&p).last(), Some(&None), "{secs}");
        assert_eq!(state_length(&p), Value::Null, "{secs}");
    }
    let seat = finite(&p).await;
    seat.control.report_media(Some(DURATION_MAX_SECS));
    p.drain();
    assert_eq!(lengths(&p).last(), Some(&Some(DURATION_MAX_SECS)));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_live_item_ignores_a_length() {
    let p = Pull::new().await;
    let (_, seat) = p.play(&p.fx.url("/radio"), json!({})).unwrap();
    assert!(until(|| lengths(&p).len() == 1).await);
    seat.control.report_media(Some(42.5));
    p.drain();
    assert_eq!(lengths(&p), [None]);
    assert_eq!(state_length(&p), Value::Null);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_report_from_a_replaced_item_changes_nothing() {
    let p = Pull::new().await;
    let first = finite(&p).await;
    finite(&p).await;
    first.control.report_media(Some(42.5));
    p.drain();
    assert_eq!(lengths(&p), [None, None]);
    assert_eq!(state_length(&p), Value::Null);
}
