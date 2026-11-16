/*
 * The app-wide artwork budget: a burst of decodes at once, then one per refill, shared by every
 * plugin, and spent by a decode that fails as much as by one that lands.
 */

// -- Library Imports --
use std::io::Cursor;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
use serde_json::json;

// -- Local Imports --
use super::art::{ART_BURST, ART_REFILL};
use super::test_link::{pcm, until, Bench, Plugin, A, B};
use crate::plugins::api::net::proxy::{Clock, TestClock};
use crate::plugins::manifest::{Capability, Tier};

fn png(shade: u8) -> Vec<u8> {
    let mut out = Cursor::new(Vec::new());
    DynamicImage::ImageRgb8(RgbImage::from_pixel(16, 16, Rgb([shade, 90, 160])))
        .write_to(&mut out, ImageFormat::Png)
        .unwrap();
    out.into_inner()
}

/// A bench of `A` and `B` on a clock the test moves.
fn bench() -> (Bench, Arc<TestClock>) {
    let grants = &[Capability::PlaybackStream];
    let bench = Bench::new(&[Plugin(A, Tier::Ui, grants), Plugin(B, Tier::Ui, grants)]);
    let clock = Arc::new(TestClock::new());
    bench.api().streams().set_clock(clock.clone());
    (bench, clock)
}

fn art_rev(bench: &Bench) -> u64 {
    bench.api().streams().now().map_or(0, |now| now.art_rev)
}

/// Plays a push item of `id` with artwork; true when its artwork landed, false when it was not
/// decoded once the artwork thread is idle.
fn play_with_art(bench: &Bench, id: &str, shade: u8) -> bool {
    let art = json!({ "data_b64": STANDARD.encode(png(shade)) });
    let args = json!({ "source": { "push": pcm() }, "title": "T", "artwork": art });
    bench.call(id, "stream.play", args).unwrap();
    assert!(until(|| !bench.api().streams().lock().art_busy));
    art_rev(bench) == 1
}

#[test]
fn a_burst_of_plays_decodes_at_once_then_waits_for_the_refill() {
    let (bench, clock) = bench();
    for shade in 0..ART_BURST {
        assert!(play_with_art(&bench, A, shade as u8), "play {shade}");
    }
    assert!(!play_with_art(&bench, A, 9), "over the budget");
    // The request waits; the refill starts it.
    clock.advance(ART_REFILL);
    bench.api().streams().drain(clock.now());
    assert!(until(|| art_rev(&bench) == 1));
}

#[test]
fn the_budget_is_shared_by_every_plugin() {
    let (bench, clock) = bench();
    assert!(play_with_art(&bench, A, 0));
    assert!(play_with_art(&bench, B, 1));
    assert!(play_with_art(&bench, A, 2));
    assert!(!play_with_art(&bench, B, 3));
    clock.advance(ART_REFILL);
    bench.api().streams().drain(clock.now());
    assert!(until(|| art_rev(&bench) == 1));
}

#[test]
fn a_failed_decode_spends_its_share() {
    let (bench, clock) = bench();
    bench.link.art_panic.store(true, Ordering::Release);
    for shade in 0..ART_BURST {
        assert!(!play_with_art(&bench, A, shade as u8));
    }
    bench.link.art_panic.store(false, Ordering::Release);
    assert!(
        !play_with_art(&bench, A, 9),
        "the failed decodes spent the burst"
    );
    clock.advance(ART_REFILL);
    bench.api().streams().drain(clock.now());
    assert!(until(|| art_rev(&bench) == 1));
}
