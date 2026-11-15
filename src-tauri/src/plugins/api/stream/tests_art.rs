/*
 * A stream's artwork from bytes: cached by hash when it is an image within the limits, ignored
 * otherwise, and the item plays on either way.
 */

// -- Library Imports --
use std::io::Cursor;
use std::sync::atomic::Ordering;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
use serde_json::json;

// -- Local Imports --
use super::test_link::{pcm, until, Bench, A};
use crate::commands::covers::{DETAIL_EDGE, THUMB_EDGE};
use crate::covers::thumb_cache_path;
use crate::plugins::api::error::ApiCode;

fn png(width: u32, height: u32) -> Vec<u8> {
    let mut out = Cursor::new(Vec::new());
    DynamicImage::ImageRgb8(RgbImage::from_pixel(width, height, Rgb([20, 90, 160])))
        .write_to(&mut out, ImageFormat::Png)
        .unwrap();
    out.into_inner()
}

#[test]
fn artwork_bytes_land_in_the_cache_by_hash() {
    let bench = Bench::one();
    let bytes = png(64, 48);
    let hash = blake3::hash(&bytes).to_hex().to_string();
    let args = json!({
        "source": { "push": pcm() }, "title": "T", "artwork": { "data_b64": STANDARD.encode(&bytes) },
    });
    let item = bench.call(A, "stream.play", args).unwrap()["item"]
        .as_i64()
        .unwrap();
    let cached = until(|| {
        let stash = bench.link.stash.lock().unwrap();
        stash.get(&item).and_then(|t| t.cover.clone()).is_some()
    });
    assert!(cached, "the artwork never landed");
    let cover = bench.link.stash.lock().unwrap()[&item]
        .cover
        .clone()
        .unwrap();
    assert_eq!(
        (cover.hash.as_str(), cover.width, cover.height),
        (hash.as_str(), 64, 48)
    );
    for edge in [THUMB_EDGE, DETAIL_EDGE] {
        assert!(thumb_cache_path(&bench.link.covers, &hash, edge).is_file());
    }
    assert_eq!(bench.api().streams().now().unwrap().art_rev, 1);
    // Over the size cap before any decode.
    let big = STANDARD.encode(vec![0u8; 524_289]);
    let update = json!({ "item": item, "artwork": { "data_b64": big } });
    let refused = bench.call(A, "stream.update", update).unwrap_err();
    assert_eq!(refused.code, ApiCode::TooLarge);
}

#[test]
fn an_artwork_clear_racing_a_running_decode_leaves_it_cleared() {
    let bench = Bench::one();
    *bench.link.art_hold.lock().unwrap() = Duration::from_millis(200);
    let art = json!({ "data_b64": STANDARD.encode(png(16, 16)) });
    let args = json!({ "source": { "push": pcm() }, "title": "T", "artwork": art });
    let item = bench.call(A, "stream.play", args).unwrap()["item"].clone();
    assert!(
        bench.api().streams().lock().art_busy,
        "the decode is running"
    );
    bench
        .call(A, "stream.update", json!({ "item": item, "artwork": null }))
        .unwrap();
    assert!(until(|| !bench.api().streams().lock().art_busy));
    let item = item.as_i64().unwrap();
    assert!(bench.link.stash.lock().unwrap()[&item].cover.is_none());
    assert_eq!(bench.api().streams().now().unwrap().art_rev, 0);
}

#[test]
fn artwork_decodes_never_overlap_across_items() {
    let bench = Bench::one();
    *bench.link.art_hold.lock().unwrap() = Duration::from_millis(100);
    let mut items = Vec::new();
    for colour in [16, 17, 18] {
        let art = json!({ "data_b64": STANDARD.encode(png(colour, 16)) });
        let args = json!({ "source": { "push": pcm() }, "title": "T", "artwork": art });
        items.push(
            bench.call(A, "stream.play", args).unwrap()["item"]
                .as_i64()
                .unwrap(),
        );
    }
    // The last item's request waits for the decode of the first, then lands; the replaced items'
    // results are dropped.
    let last = *items.last().unwrap();
    let landed = until(|| {
        let stash = bench.link.stash.lock().unwrap();
        stash.get(&last).is_some_and(|t| t.cover.is_some())
    });
    assert!(landed);
    assert!(until(|| !bench.api().streams().lock().art_busy));
    assert_eq!(bench.link.art_most.load(Ordering::Acquire), 1);
    assert_eq!(bench.api().streams().now().unwrap().art_rev, 1);
}

#[test]
fn svg_and_oversize_artwork_fail_quietly() {
    let bench = Bench::one();
    let svg = br#"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>"#;
    let wide = png(8_193, 1);
    let mut item = 0;
    for bytes in [svg.to_vec(), wide] {
        let art = json!({ "data_b64": STANDARD.encode(&bytes) });
        let args = json!({ "source": { "push": pcm() }, "title": "T", "artwork": art });
        let reply = bench.call(A, "stream.play", args).unwrap();
        item = reply["item"].as_i64().unwrap();
        // The decode runs off the call; give it time to finish.
        let settled = until(|| !bench.api().streams().lock().art_busy);
        assert!(settled);
        assert_eq!(bench.api().streams().now().unwrap().art_rev, 0);
        assert!(bench.link.stash.lock().unwrap()[&item].cover.is_none());
    }
    // The item plays on.
    assert_eq!(
        bench.call(A, "stream.state", json!({})).unwrap()["item"],
        item
    );
}
