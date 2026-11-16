/*
 * Stream artwork on disk: bounded per item, gone with the item and at start-up, never touching a
 * library cover, and a decode that panics costs only that artwork.
 */

// -- Library Imports --
use std::io::Cursor;
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Instant;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
use serde_json::{json, Value};

// -- Local Imports --
use super::art::ART_GAP;
use super::art_store::{ART_KEPT, ART_PREFIX};
use super::test_link::{pcm, until, Bench, A};
use super::StreamHub;
use crate::commands::covers::{DETAIL_EDGE, THUMB_EDGE};
use crate::covers::thumb_cache_path;

fn png(shade: u8) -> Vec<u8> {
    let mut out = Cursor::new(Vec::new());
    DynamicImage::ImageRgb8(RgbImage::from_pixel(16, 16, Rgb([shade, 90, 160])))
        .write_to(&mut out, ImageFormat::Png)
        .unwrap();
    out.into_inner()
}

fn art(bytes: &[u8]) -> Value {
    json!({ "data_b64": STANDARD.encode(bytes) })
}

/// The stream artwork files in the covers folder.
fn stream_files(covers: &Path) -> usize {
    std::fs::read_dir(covers)
        .unwrap()
        .flatten()
        .filter(|entry| entry.file_name().to_string_lossy().starts_with(ART_PREFIX))
        .count()
}

fn art_rev(bench: &Bench) -> u64 {
    bench.api().streams().now().map_or(0, |now| now.art_rev)
}

/// Plays a push item showing `bytes` and waits for the artwork to land.
fn play_with(bench: &Bench, bytes: &[u8]) -> Value {
    let args = json!({ "source": { "push": pcm() }, "title": "T", "artwork": art(bytes) });
    let item = bench.call(A, "stream.play", args).unwrap()["item"].clone();
    assert!(until(|| art_rev(bench) == 1));
    item
}

/// Replaces the item's artwork `count` times, each one decoded in turn.
fn replace(bench: &Bench, item: &Value, count: u8) {
    let start = Instant::now();
    for n in 1..=count {
        let update = json!({ "item": item, "artwork": art(&png(n)) });
        bench.call(A, "stream.update", update).unwrap();
        bench.api().streams().drain(start + ART_GAP * u32::from(n));
        assert!(until(|| art_rev(bench) == 1 + u64::from(n)));
    }
}

#[test]
fn replaced_artwork_leaves_a_bounded_number_of_files() {
    let bench = Bench::one();
    let item = play_with(&bench, &png(0));
    // Four artworks in all, inside the item's 20 s without audio.
    replace(&bench, &item, 3);
    assert!(until(|| !bench.api().streams().lock().art_busy));
    assert_eq!(stream_files(&bench.link.covers), ART_KEPT * 2);
    // The shown artwork is one of them.
    let item = item.as_i64().unwrap();
    let shown = bench.link.stash.lock().unwrap()[&item]
        .cover
        .clone()
        .unwrap();
    assert!(thumb_cache_path(&bench.link.covers, &shown.hash, DETAIL_EDGE).is_file());
}

#[test]
fn ending_the_item_removes_its_files() {
    let bench = Bench::one();
    let item = play_with(&bench, &png(0));
    replace(&bench, &item, 1);
    assert!(stream_files(&bench.link.covers) > 0);
    bench
        .call(A, "stream.stop", json!({ "item": item }))
        .unwrap();
    assert_eq!(stream_files(&bench.link.covers), 0);
}

#[test]
fn start_up_empties_the_store_and_keeps_library_covers() {
    let bench = Bench::one();
    let covers = &bench.link.covers;
    let hash = blake3::hash(&png(0)).to_hex().to_string();
    let library = thumb_cache_path(covers, &hash, THUMB_EDGE);
    std::fs::write(&library, b"library").unwrap();
    let left = thumb_cache_path(covers, &format!("{ART_PREFIX}7-{hash}"), THUMB_EDGE);
    std::fs::write(&left, b"stream").unwrap();
    std::fs::write(left.with_extension("palette"), b"[]").unwrap();

    StreamHub::default().attach(Arc::clone(&bench.link) as _);
    assert_eq!(stream_files(covers), 0);
    assert!(library.is_file());
}

#[test]
fn a_library_cover_with_the_same_bytes_survives() {
    let bench = Bench::one();
    let bytes = png(0);
    let hash = blake3::hash(&bytes).to_hex().to_string();
    let library: Vec<_> = [THUMB_EDGE, DETAIL_EDGE]
        .map(|edge| thumb_cache_path(&bench.link.covers, &hash, edge))
        .into();
    for path in &library {
        std::fs::write(path, b"library").unwrap();
    }
    let item = play_with(&bench, &bytes);
    bench
        .call(A, "stream.stop", json!({ "item": item }))
        .unwrap();
    assert_eq!(stream_files(&bench.link.covers), 0);
    for path in &library {
        assert_eq!(std::fs::read(path).unwrap(), b"library");
    }
}

#[test]
fn a_panicking_decode_leaves_artwork_working_for_the_next_item() {
    let bench = Bench::one();
    bench.link.art_panic.store(true, Ordering::Release);
    let args = json!({ "source": { "push": pcm() }, "title": "T", "artwork": art(&png(0)) });
    bench.call(A, "stream.play", args).unwrap();
    assert!(until(|| !bench.api().streams().lock().art_busy));
    assert_eq!(art_rev(&bench), 0, "the failed artwork shows nothing");
    assert_eq!(stream_files(&bench.link.covers), 0);

    bench.link.art_panic.store(false, Ordering::Release);
    play_with(&bench, &png(1));
}
