/*
 * The stream methods: who may start a stream, what a call is checked against, pushed bytes and their
 * flow control, metadata, and what other plugins read.
 */

// -- Library Imports --
use std::time::Instant;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::{json, Value};

// -- Local Imports --
use super::test_link::{pcm, until, Bench, Plugin, A, B, RADIO};
use super::StreamEvent;
use crate::audio::stream::LIVE_RING;
use crate::plugins::api::error::ApiCode;
use crate::plugins::api::{method_names, Caller};
use crate::plugins::manifest::{Capability, Tier};

fn code(
    result: Result<Value, crate::plugins::api::error::ApiError>,
) -> (ApiCode, Option<&'static str>) {
    let error = result.unwrap_err();
    (error.code, error.reason)
}

fn pull(url: &str) -> Value {
    json!({ "source": { "url": url }, "title": "Radio" })
}

const STREAM_AND_NET: &[Capability] = &[Capability::PlaybackStream, Capability::Network];

#[test]
fn play_needs_the_capability() {
    let bench = Bench::new(&[
        Plugin(
            A,
            Tier::Ui,
            &[Capability::PlaybackControl, Capability::PlaybackRead],
        ),
        Plugin(B, Tier::Ui, &[Capability::PlaybackStream]),
    ]);
    let args = json!({ "source": { "push": pcm() }, "title": "T" });
    assert_eq!(
        code(bench.call(A, "stream.play", args.clone())).0,
        ApiCode::Denied
    );
    for method in [
        "stream.state",
        "stream.stop",
        "stream.push",
        "stream.update",
    ] {
        assert_eq!(
            code(bench.call(A, method, json!({ "item": -1 }))).0,
            ApiCode::Denied
        );
    }
    assert!(bench.link.starts().is_empty());
    assert!(bench.call(B, "stream.play", args).is_ok());
    assert_eq!(bench.link.starts().len(), 1);
}

#[test]
fn a_url_needs_network_and_a_listed_origin() {
    let bench = Bench::new(&[
        Plugin(A, Tier::Ui, &[Capability::PlaybackStream]),
        Plugin(B, Tier::Ui, STREAM_AND_NET),
    ]);
    // Without `network`, any URL is denied; a push needs nothing more.
    assert_eq!(
        code(bench.call(A, "stream.play", pull(RADIO))),
        (ApiCode::Denied, None)
    );
    let unlisted = code(bench.call(B, "stream.play", pull("https://other.example.com/live")));
    assert_eq!(unlisted, (ApiCode::Denied, Some("origin_not_listed")));
    let dev = code(bench.call(B, "stream.play", pull("http://127.0.0.1:8090/radio")));
    assert_eq!(dev, (ApiCode::Denied, Some("origin_not_listed")));
    for bad in [
        "file:///C:/music/a.mp3",
        "data:audio/mpeg;base64,AAAA",
        "not a url",
    ] {
        assert_eq!(
            code(bench.call(B, "stream.play", pull(bad))).0,
            ApiCode::InvalidArgs,
            "{bad}"
        );
    }
    let mut headers = pull(&format!("{RADIO}/live"));
    headers["source"]["headers"] = json!({ "host": "x" });
    assert_eq!(
        code(bench.call(B, "stream.play", headers)).0,
        ApiCode::InvalidArgs
    );
    // Artwork by URL follows the same rules.
    let art = json!({ "source": { "push": pcm() }, "title": "T", "artwork": { "url": RADIO } });
    assert_eq!(code(bench.call(A, "stream.play", art)).0, ApiCode::Denied);
    assert!(
        bench.link.starts().is_empty(),
        "a refused play seats nothing"
    );

    let reply = bench
        .call(B, "stream.play", pull(&format!("{RADIO}/live")))
        .unwrap();
    assert_eq!(reply["state"], "connecting");
    let seat = bench.link.starts().pop().unwrap();
    assert_eq!(seat.id, reply["item"].as_i64().unwrap());
    assert!(seat.id < 0 && seat.live && !seat.seekable);
}

#[test]
fn play_from_a_background_caller_with_no_page_is_accepted() {
    let bench = Bench::one();
    // No page is open and no gesture was made.
    assert_eq!(bench.api().open_page(), None);
    let (item, _) = bench.push_item(A, pcm());
    assert!(item < 0);
    assert_eq!(
        bench.call(A, "stream.state", json!({})).unwrap()["item"],
        item
    );
}

#[test]
fn play_from_a_native_child_with_no_page_is_accepted() {
    let bench = Bench::new(&[Plugin(A, Tier::Native, &[Capability::PlaybackStream])]);
    let args = json!({ "source": { "push": pcm() }, "title": "Child" });
    let reply = bench
        .call_as(Caller::Child, A, "stream.play", args)
        .unwrap();
    assert_eq!(
        bench.link.starts().pop().unwrap().id,
        reply["item"].as_i64().unwrap()
    );
}

#[test]
fn native_host_call_reaches_stream_methods() {
    let bench = Bench::new(&[Plugin(A, Tier::Native, &[Capability::PlaybackStream])]);
    // A child's call takes the frame's path with `Caller::Child`; no `stream.*` name is held back.
    for method in method_names()
        .into_iter()
        .filter(|m| m.starts_with("stream."))
    {
        let result = bench.call_as(Caller::Child, A, method, json!({ "item": -1 }));
        if let Err(error) = result {
            assert_ne!(error.code, ApiCode::UnknownMethod, "{method}");
            assert_ne!(error.code, ApiCode::Denied, "{method}");
        }
    }
}

#[test]
fn play_from_a_plugin_not_serving_is_unavailable() {
    let bench = Bench::one();
    let args = json!({ "source": { "push": pcm() }, "title": "T" });
    // Admitted while serving, then withdrawn before the hub accepts it.
    let enabled = bench.plugins.enabled_set();
    let call = args.to_string();
    let admitted = crate::plugins::api::admit(
        &enabled,
        bench.api(),
        A,
        "stream.play",
        call.len(),
        Instant::now(),
    )
    .unwrap();
    let withdrawn = bench.plugins.withdraw(A);
    let result = crate::plugins::api::run(&admitted, &call, bench.data(), &bench.host, bench.api());
    assert_eq!(code(result).0, ApiCode::Unavailable);
    drop(withdrawn);
    assert!(bench.link.starts().is_empty(), "the music plays on");
    // A plugin the runtime does not serve never gets that far.
    assert_eq!(
        code(bench.call(B, "stream.play", args)).0,
        ApiCode::Unavailable
    );
}

#[test]
fn now_is_refused_on_a_finite_item() {
    let bench = Bench::one();
    let finite = json!({ "source": { "push": pcm() }, "title": "T", "live": false, "now": "Song" });
    assert_eq!(
        code(bench.call(A, "stream.play", finite)).0,
        ApiCode::InvalidArgs
    );
    let args = json!({ "source": { "push": pcm() }, "title": "T", "live": false });
    let item = bench.call(A, "stream.play", args).unwrap()["item"].clone();
    let refused = bench.call(A, "stream.update", json!({ "item": item, "now": "Song" }));
    assert_eq!(code(refused).0, ApiCode::InvalidArgs);
    // Clearing it is allowed.
    assert!(bench
        .call(A, "stream.update", json!({ "item": item, "now": null }))
        .is_ok());
    // A live item takes it.
    let live = json!({ "source": { "push": pcm() }, "title": "T", "now": "Song" });
    assert!(bench.call(A, "stream.play", live).is_ok());
}

#[test]
fn push_writes_and_reports_room() {
    let bench = Bench::one();
    let (item, _seat) = bench.push_item(A, json!({ "format": "mp3" }));
    let data = STANDARD.encode(vec![0u8; 1000]);
    let reply = bench
        .call(A, "stream.push", json!({ "item": item, "data_b64": data }))
        .unwrap();
    assert_eq!(reply["room"].as_u64().unwrap() as usize, LIVE_RING - 1000);
    assert!(reply["buffered_ms"].is_u64());
    // The bytes reach the decoder.
    assert!(until(|| bench
        .link
        .media_read
        .load(std::sync::atomic::Ordering::Acquire)
        == 1000));

    let empty = json!({ "item": item, "data_b64": "" });
    assert_eq!(
        code(bench.call(A, "stream.push", empty)).0,
        ApiCode::InvalidArgs
    );
    let big = json!({ "item": item, "data_b64": STANDARD.encode(vec![0u8; 65_537]) });
    assert_eq!(code(bench.call(A, "stream.push", big)).0, ApiCode::TooLarge);
    let full = json!({ "item": item, "data_b64": STANDARD.encode(vec![0u8; 65_536]) });
    assert!(bench.call(A, "stream.push", full).is_ok());
    let bad = json!({ "item": item, "data_b64": "***" });
    assert_eq!(
        code(bench.call(A, "stream.push", bad)).0,
        ApiCode::InvalidArgs
    );
}

#[test]
fn a_full_ring_is_busy_then_a_room_event() {
    let bench = Bench::one();
    // `pcm_s16le` decodes for real; nobody drains the PCM queue, so the ring fills.
    let (item, seat) = bench.push_item(A, pcm());
    let chunk = STANDARD.encode(vec![0u8; 65_536]);
    let push = || bench.call(A, "stream.push", json!({ "item": item, "data_b64": chunk }));
    let mut busy = false;
    for _ in 0..64 {
        match push() {
            Ok(_) => {}
            Err(error) => {
                assert_eq!(error.code, ApiCode::Busy);
                busy = true;
                break;
            }
        }
    }
    assert!(busy, "the ring never filled");
    bench.api().streams().drain(Instant::now());
    let room_events = |bench: &Bench| {
        bench
            .link
            .owner_events(A)
            .into_iter()
            .filter(|e| matches!(e, StreamEvent::Room { .. }))
            .count()
    };
    assert_eq!(room_events(&bench), 0, "no room yet");
    // The engine takes audio; the decoder drains the ring.
    let drained = until(|| {
        while seat.pcm.try_next().is_some() {}
        bench.api().streams().drain(Instant::now());
        room_events(&bench) == 1
    });
    assert!(drained, "no room event");
    let events = bench.link.owner_events(A);
    let room = events.iter().find_map(|e| match e {
        StreamEvent::Room { item: i, room } => Some((*i, *room)),
        _ => None,
    });
    let (room_item, room) = room.unwrap();
    assert_eq!(room_item, item);
    assert!(room >= LIVE_RING / 2);
    // Once only.
    bench.api().streams().drain(Instant::now());
    assert_eq!(room_events(&bench), 1);
}

#[test]
fn a_foreign_or_old_item_is_not_found() {
    let bench = Bench::new(&[
        Plugin(A, Tier::Ui, &[Capability::PlaybackStream]),
        Plugin(B, Tier::Ui, &[Capability::PlaybackStream]),
    ]);
    let (item, _) = bench.push_item(A, pcm());
    let data = STANDARD.encode([1u8; 4]);
    for (method, args) in [
        ("stream.push", json!({ "item": item, "data_b64": data })),
        ("stream.end", json!({ "item": item })),
        ("stream.pause", json!({ "item": item })),
        ("stream.resume", json!({ "item": item })),
        ("stream.stop", json!({ "item": item })),
        ("stream.update", json!({ "item": item, "title": "Mine" })),
    ] {
        assert_eq!(
            code(bench.call(B, method, args.clone())).0,
            ApiCode::NotFound,
            "{method}"
        );
        let other = json!({ "item": item - 1000, "title": "x", "data_b64": data });
        assert_eq!(
            code(bench.call(A, method, other)).0,
            ApiCode::NotFound,
            "{method}"
        );
    }
    // Another plugin reads nothing of it.
    assert_eq!(
        bench.call(B, "stream.state", json!({})).unwrap()["item"],
        Value::Null
    );
    // An ended item is gone for good.
    bench
        .call(A, "stream.stop", json!({ "item": item }))
        .unwrap();
    let old = bench.call(A, "stream.pause", json!({ "item": item }));
    assert_eq!(code(old).0, ApiCode::NotFound);
}

#[test]
fn the_stash_holds_the_display_pair_and_is_cleared() {
    let bench = Bench::one();
    let args = json!({
        "source": { "push": pcm() }, "title": " Station\u{202E} ", "artist": "Host", "album": "Show",
    });
    let item = bench.call(A, "stream.play", args).unwrap()["item"]
        .as_i64()
        .unwrap();
    let pair = |bench: &Bench| {
        let stash = bench.link.stash.lock().unwrap();
        stash
            .get(&item)
            .map(|t| (t.title.clone(), t.artist.clone()))
    };
    assert_eq!(pair(&bench), Some(("Station".into(), Some("Host".into()))));
    let now = bench
        .link
        .nows
        .lock()
        .unwrap()
        .last()
        .cloned()
        .flatten()
        .unwrap();
    assert_eq!(
        (now.item, now.plugin_id.as_str(), now.plugin_name.as_str()),
        (item, A, A)
    );
    assert_eq!(now.album.as_deref(), Some("Show"));

    let rev = now.rev;
    bench
        .call(
            A,
            "stream.update",
            json!({ "item": item, "now": "Song - Band" }),
        )
        .unwrap();
    assert_eq!(
        pair(&bench),
        Some(("Song - Band".into(), Some("Station".into())))
    );
    bench
        .call(
            A,
            "stream.update",
            json!({ "item": item, "now": null, "artist": null }),
        )
        .unwrap();
    assert_eq!(pair(&bench), Some(("Station".into(), None)));
    let now = bench.api().streams().now().unwrap();
    assert_eq!(now.rev, rev + 2);
    assert_eq!(
        code(bench.call(A, "stream.update", json!({ "item": item }))).0,
        ApiCode::InvalidArgs
    );
    let clear_title = bench.call(A, "stream.update", json!({ "item": item, "title": null }));
    assert_eq!(code(clear_title).0, ApiCode::InvalidArgs);

    bench
        .call(A, "stream.stop", json!({ "item": item }))
        .unwrap();
    assert_eq!(pair(&bench), None);
    assert_eq!(
        bench.link.nows.lock().unwrap().last().cloned().flatten(),
        None
    );
}

#[test]
fn playback_state_reports_stream_without_paths() {
    let bench = Bench::new(&[
        Plugin(A, Tier::Ui, STREAM_AND_NET),
        Plugin(B, Tier::Ui, &[Capability::PlaybackRead]),
    ]);
    let none = bench.call(B, "playback.state", json!({})).unwrap();
    assert_eq!(none["stream"], Value::Null);
    let args = json!({ "source": { "url": format!("{RADIO}/secret?token=abc"), "headers": { "authorization": "Bearer k" } },
                       "title": "Radio", "artist": "DJ" });
    let item = bench.call(A, "stream.play", args).unwrap()["item"]
        .as_i64()
        .unwrap();
    let state = bench.call(B, "playback.state", json!({})).unwrap();
    assert_eq!(
        state["stream"],
        json!({ "title": "Radio", "artist": "DJ", "live": true, "mine": false })
    );
    assert_eq!(state["track_id"], Value::Null);
    let own = bench.call(A, "stream.state", json!({})).unwrap();
    assert_eq!(own["item"], item);
    for text in [state.to_string(), own.to_string()] {
        for needle in ["radio.example", "secret", "token", "Bearer", "http"] {
            assert!(!text.contains(needle), "{needle} in {text}");
        }
    }
}

#[test]
fn app_methods_lists_eight_stream_names() {
    let bench = Bench::one();
    let methods = bench.call(A, "app.methods", json!({})).unwrap();
    let names: Vec<&str> = methods["methods"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .filter(|name| name.starts_with("stream."))
        .collect();
    assert_eq!(
        names,
        [
            "stream.end",
            "stream.pause",
            "stream.play",
            "stream.push",
            "stream.resume",
            "stream.state",
            "stream.stop",
            "stream.update"
        ]
    );
}
