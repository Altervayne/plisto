/*
 * The pull feeder's slots, headers, resumes and later heads against the local test server, and the
 * end paths that must leave nothing behind: a replaced item's connection, a plugin that stopped
 * serving, an ended item's artwork fetch.
 */

// -- Library Imports --
use std::sync::atomic::Ordering;
use std::time::Duration;

use serde_json::{json, Map, Value};

// -- Local Imports --
use super::test_link::{pcm, A};
use super::tests_pull::{until, Pull, SETTLE};
use super::Gone;
use crate::audio::stream::RECONNECT_BACKOFF_MS;
use crate::audio::StreamEndReason;
use crate::plugins::api::error::ApiCode;
use crate::plugins::api::net::state::MAX_STREAMS;
use crate::plugins::api::net::test_server::{FILE_DATE, FILE_ETAG, FILE_LEN, RADIO_METAINT};
use crate::plugins::api::net::{MAX_HEADERS, MAX_HEADERS_TOTAL};
use crate::plugins::api::{Kind, Running};

/// Where `/file?drop=` cuts the first body.
const CUT: usize = 50_000;

fn page_stream(p: &Pull, id: &str) -> Running {
    let net = p.bench.api().net();
    net.open(id, Kind::Stream, None, Box::new(|_| {})).unwrap()
}

fn read(p: &Pull) -> usize {
    p.bench.link.media_read.load(Ordering::Acquire) as usize
}

/// `MAX_HEADERS` plugin headers that fill `MAX_HEADERS_TOTAL` to within a few bytes.
fn full_headers() -> Value {
    let value_len = MAX_HEADERS_TOTAL / MAX_HEADERS - 5;
    let headers: Map<String, Value> = (0..MAX_HEADERS)
        .map(|n| (format!("x-h{n:02}"), json!("v".repeat(value_len))))
        .collect();
    Value::Object(headers)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_self_replace_with_a_page_stream_open_connects_at_once() {
    let p = Pull::new().await;
    let _page = page_stream(&p, A);
    p.play(&p.fx.url("/radio"), json!({})).unwrap();
    assert!(until(|| p.fx.server().streamed() > 0).await);
    p.play(&p.fx.url("/radio"), json!({})).unwrap();
    assert!(until(|| p.fx.connections() == 2).await);
    assert!(until(|| p.facts().len() == 2).await);
    assert_eq!(p.ends(), [(StreamEndReason::Replaced, None)]);

    let finite = json!({ "live": false });
    p.play(&p.fx.url("/file?stall=1000"), finite.clone())
        .unwrap();
    assert!(until(|| p.facts().len() == 3).await);
    p.play(&p.fx.url("/file?stall=1000"), finite).unwrap();
    assert!(until(|| p.facts().len() == 4).await);
    assert_eq!(p.fx.connections(), 4);
    assert!(p
        .ends()
        .iter()
        .all(|end| *end == (StreamEndReason::Replaced, None)));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_app_wide_stream_cap_answers_busy_at_play() {
    let p = Pull::new().await;
    let _pages: Vec<Running> = (0..MAX_STREAMS)
        .map(|n| page_stream(&p, &format!("com.example.p{n}")))
        .collect();
    let refused = p.play(&p.fx.url("/radio"), json!({})).err();
    assert_eq!(refused, Some(ApiCode::Busy));
    assert_eq!(p.fx.connections(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn thirty_two_plugin_headers_connect() {
    let p = Pull::new().await;
    let source = json!({ "url": p.fx.url("/radio"), "headers": full_headers(), "icy": true });
    p.play(&p.fx.url("/radio"), json!({ "source": source }))
        .unwrap();
    assert!(until(|| p.fx.server().streamed() > 0).await);
    let head = &p.fx.server().heads()[0];
    assert!(head.header("x-h31").is_some());
    assert!(head.header("accept").is_some());
    assert_eq!(head.header("icy-metadata"), Some("1"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_finite_resume_works_at_the_header_limit() {
    let p = Pull::new().await;
    let url = p.fx.url(&format!("/file?drop={CUT}"));
    let source = json!({ "url": url, "headers": full_headers() });
    p.play(&url, json!({ "source": source })).unwrap();
    assert!(until(|| read(&p) == FILE_LEN).await, "read {}", read(&p));
    let heads = p.fx.server().heads();
    assert_eq!(heads[1].header("range"), Some(&*format!("bytes={CUT}-")));
    assert_eq!(heads[1].header("if-range"), Some(FILE_ETAG));
    assert!(heads[1].header("x-h31").is_some());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_weak_etag_falls_back_to_last_modified() {
    let p = Pull::new().await;
    p.play(&p.fx.url(&format!("/file?drop={CUT}&weak")), json!({}))
        .unwrap();
    assert!(until(|| read(&p) == FILE_LEN).await, "read {}", read(&p));
    assert_eq!(p.fx.server().heads()[1].header("if-range"), Some(FILE_DATE));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_full_body_or_a_wrong_range_answer_to_a_resume_ends_without_repeating() {
    for answer in ["resume=200", "resume=badrange"] {
        let p = Pull::new().await;
        p.play(&p.fx.url(&format!("/file?drop={CUT}&{answer}")), json!({}))
            .unwrap();
        let closed = (StreamEndReason::Network, Some("closed"));
        assert!(
            until(|| p.ends() == [closed]).await,
            "{answer}: {:?}",
            p.ends()
        );
        assert_eq!(p.fx.connections(), 2, "{answer}");
        assert!(read(&p) <= CUT, "{answer}: read {}", read(&p));
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_reconnect_head_of_another_type_ends_unsupported_format() {
    let p = Pull::new().await;
    p.play(&p.fx.url("/shift"), json!({})).unwrap();
    assert!(until(|| p.shown() == Some(super::NowState::Reconnecting)).await);
    p.clock
        .advance(Duration::from_millis(RECONNECT_BACKOFF_MS[0]));
    let format = (StreamEndReason::Unsupported, Some("format"));
    assert!(until(|| p.ends() == [format]).await, "{:?}", p.ends());
    assert_eq!(p.fx.connections(), 2);
    assert!(read(&p) <= RADIO_METAINT, "no byte of the new type");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_plugin_not_serving_at_reconnect_yields_only_plugin_gone() {
    let p = Pull::new().await;
    p.play(&p.fx.url("/radio-drop?ms=100"), json!({})).unwrap();
    assert!(until(|| p.shown() == Some(super::NowState::Reconnecting)).await);
    let withdrawn = p.bench.plugins.withdraw(A);
    for wait in RECONNECT_BACKOFF_MS {
        p.clock.advance(Duration::from_millis(wait));
    }
    tokio::time::sleep(SETTLE).await;
    assert!(p.ends().is_empty(), "{:?}", p.ends());
    assert_eq!(p.fx.connections(), 1);
    p.bench.plugins.stop_because(A, Gone::Off);
    drop(withdrawn);
    assert_eq!(p.ends(), [(StreamEndReason::PluginGone, None)]);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_out_of_range_icy_metaint_ends_unsupported_format() {
    let p = Pull::new().await;
    p.play(&p.fx.url("/bad-icy"), json!({})).unwrap();
    let format = (StreamEndReason::Unsupported, Some("format"));
    assert!(until(|| p.ends() == [format]).await, "{:?}", p.ends());
    assert!(p.fx.server().saw_close(1).await);
    assert!(p.facts().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn stream_now_carries_live_seekable_and_rev_after_the_head() {
    let p = Pull::new().await;
    let hub = p.bench.api().streams();
    p.play(&p.fx.url("/file?stall=1000"), json!({ "now": "Intro" }))
        .unwrap();
    assert!(until(|| p.facts().len() == 1).await);
    let now = hub.now().unwrap();
    assert!(!now.live && now.seekable);
    assert!(now.rev >= 2);
    assert_eq!(now.now, None, "a finite item has no live line");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_ended_item_cancels_its_artwork_fetch() {
    let p = Pull::new().await;
    let args = |url: String| json!({ "source": { "push": pcm() }, "title": "T", "artwork": { "url": url } });
    let first = p
        .bench
        .call(A, "stream.play", args(p.fx.url("/hang")))
        .unwrap()["item"]
        .clone();
    assert!(until(|| p.fx.connections() == 1).await);
    p.bench
        .call(A, "stream.stop", json!({ "item": first }))
        .unwrap();
    assert!(p.fx.server().saw_close(1).await, "the fetch is cut");
    p.bench
        .call(A, "stream.play", args(p.fx.url("/art.png")))
        .unwrap();
    let hub = p.bench.api().streams();
    assert!(until(|| hub.now().is_some_and(|now| now.art_rev == 1)).await);
}
