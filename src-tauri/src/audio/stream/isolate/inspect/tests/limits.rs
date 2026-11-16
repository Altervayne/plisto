/*
 * What each step's limits cost a file, who gets blamed when a helper dies, and what main refuses of
 * a step on its own side. The limits are shortened on the burst, never waited out in full.
 */

use std::io::Cursor;
use std::time::Instant;

use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{ExtendedColorType, ImageEncoder, RgbaImage};

use super::*;
use crate::audio::stream::isolate::bridge::inspect::{checked, pick, Offered, Served, StepLimits};
use crate::audio::stream::isolate::inspect::serve::scaled_with;
use crate::audio::stream::isolate::wire::ReadSource;
use crate::audio::stream::Fault;

#[test]
fn an_image_over_the_pixel_cap_is_skipped_without_a_decode() {
    let over = forged_png(10_001, 10_000);
    assert!(scaled_with(&over, EDGES, |_| panic!(
        "an image over the cap was decoded"
    ))
    .is_none());

    let mut decoded = false;
    let at_cap = forged_png(10_000, 10_000);
    let cover = scaled_with(&at_cap, EDGES, |bytes| {
        decoded = true;
        image::load_from_memory(&bytes[..8])
    });
    assert!(decoded, "an image at the cap is decoded");
    assert!(cover.is_none(), "a decode that fails is no cover");

    let real = png(300, 200);
    let cover = scaled_with(&real, EDGES, image::load_from_memory).expect("a real cover");
    assert_eq!((cover.width, cover.height), (300, 200));
}

#[test]
fn a_tag_step_past_its_wall_limit_drops_only_that_file() {
    let session = use_test_session(WAIT);
    let dir = TempDir::new("slow");
    let slow = dir.path.join("slow.m4a");
    let next = dir.path.join("next.m4a");
    tagged_m4a(&slow, "Slow", "A", None);
    tagged_m4a(&next, "Next", "B", None);

    let mut burst = InspectBurst::new(EDGES);
    burst.limits.tags.wall = Duration::from_millis(500);
    // Main's own read of the file never returns: the step still ends at its limit.
    let (release, stall) = crossbeam_channel::bounded::<()>(0);
    burst.stall_reads = Some(stall);
    let started = Instant::now();
    assert!(matches!(burst.read_tags(&slow), Inspection::Slow));
    assert!(started.elapsed() < WAIT, "the stuck read is abandoned");
    burst.stall_reads = None;
    assert_eq!(read(burst.read_tags(&next)).title.as_deref(), Some("Next"));
    assert!(
        !session.is_faulted(&file_key(&slow)),
        "slow storage is not blamed"
    );
    assert_eq!(
        session.launches(),
        2,
        "the helper of the slow file was replaced"
    );
    drop(release);
}

#[test]
fn a_reused_helper_death_retries_the_file_in_a_fresh_helper() {
    let session = use_test_session(WAIT);
    let dir = TempDir::new("retry");
    let before = dir.path.join("before.m4a");
    let marked = dir.path.join("marked.m4a");
    tagged_m4a(&before, "Before", "A", None);
    tagged_m4a(&marked, MARKED_TITLE, "B", None);

    // The helper dies on the file only once it has answered another: a fresh one reads it.
    let mut burst = InspectBurst::new(EDGES);
    burst.args = InspectFault::AbortReused.args();
    read(burst.read_tags(&before));
    let file = read(burst.read_tags(&marked));
    assert_eq!(file.title.as_deref(), Some(MARKED_TITLE));
    assert_eq!(session.launches(), 2);
    assert!(!session.is_faulted(&file_key(&marked)));
    assert!(!session.is_faulted(&file_key(&before)));
}

#[test]
fn a_helper_dying_between_two_files_is_replaced_and_neither_is_blamed() {
    let session = use_test_session(WAIT);
    let dir = TempDir::new("between");
    let first = dir.path.join("first.m4a");
    let second = dir.path.join("second.m4a");
    tagged_m4a(&first, MARKED_TITLE, "A", None);
    tagged_m4a(&second, "Second", "B", None);

    // The helper exits right after answering the first file; the second starts once it is gone.
    let mut burst = InspectBurst::new(EDGES);
    burst.args = InspectFault::ExitAfter.args();
    read(burst.read_tags(&first));
    let started = Instant::now();
    while burst.helper_alive() {
        assert!(started.elapsed() < WAIT, "the helper exits");
        std::thread::yield_now();
    }
    assert_eq!(
        read(burst.read_tags(&second)).title.as_deref(),
        Some("Second")
    );
    assert_eq!(
        burst.retries, 0,
        "the dead helper was seen before the second file was asked"
    );
    assert_eq!(session.launches(), 2);
    assert!(!session.is_faulted(&file_key(&first)));
    assert!(!session.is_faulted(&file_key(&second)));
}

#[test]
fn main_refuses_an_oversized_thumbnail_and_an_unoffered_image_and_holds_back_a_large_image() {
    let thumb = |width, height| Thumb {
        width,
        height,
        rgb: vec![0; (width * height * 3) as usize],
    };
    let cover = |small: Thumb| InspectedCover {
        width: 1000,
        height: 1000,
        thumbs: [small, thumb(512, 512)],
    };
    assert!(checked(Some(cover(thumb(128, 128))), EDGES).is_ok());
    assert!(checked(None, EDGES).is_ok());
    assert_eq!(
        checked(Some(cover(thumb(129, 64))), EDGES),
        Err(Fault::Protocol)
    );

    let audio = Offered::new(Served::new(Cursor::new(vec![0u8; 16]), 16));
    let served = [Some(audio), None];
    assert!(pick(&served, ReadSource::Audio).is_ok());
    assert_eq!(
        pick(&served, ReadSource::Image).err(),
        Some(Fault::Protocol),
        "an image read with no image offered"
    );

    let image = |len| Served::new(Cursor::new(Vec::<u8>::new()), len);
    assert!(offered(image(ADJACENT_IMAGE_MAX)).is_some());
    assert!(offered(image(ADJACENT_IMAGE_MAX + 1)).is_none());
}

// A 100,000,000-pixel RGBA image, the largest a cover may be, with incompressible noise in one
// channel so its decode does real work and its file stays under the adjacent image limit.
fn largest_admitted() -> RgbaImage {
    let edge = 10_000u32;
    assert_eq!(u64::from(edge).pow(2), COVER_PIXELS_MAX);
    RgbaImage::from_fn(edge, edge, |x, y| {
        let noise = (x.wrapping_mul(2_654_435_761) ^ y.wrapping_mul(40_503)).rotate_left(13);
        image::Rgba([(noise >> 24) as u8, (x / 40) as u8, (y / 40) as u8, 255])
    })
}

// Measures the cover step of the largest admitted image, as PNG and as JPEG, through a real helper.
// Run in both builds: cargo test [--release] cover_step_of_the_largest_admitted_image -- --ignored
#[test]
#[ignore]
fn cover_step_of_the_largest_admitted_image() {
    use_test_session(WAIT);
    let dir = TempDir::new("largest");
    let image = largest_admitted();
    let mut png = Vec::new();
    PngEncoder::new_with_quality(&mut png, CompressionType::Fast, FilterType::Sub)
        .write_image(image.as_raw(), 10_000, 10_000, ExtendedColorType::Rgba8)
        .unwrap();
    let rgb = DynamicImage::ImageRgba8(image).to_rgb8();
    let mut jpeg = Vec::new();
    JpegEncoder::new_with_quality(&mut jpeg, 90)
        .write_image(rgb.as_raw(), 10_000, 10_000, ExtendedColorType::Rgb8)
        .unwrap();
    drop(rgb);
    let bare = dir.path.join("bare.m4a");
    tagged_m4a(&bare, "Bare", "A", None);

    let mut burst = InspectBurst::new(EDGES);
    burst.limits.cover = StepLimits {
        cpu: Duration::from_secs(3_600),
        wall: Duration::from_secs(3_600),
        quiet: Duration::from_secs(3_600),
    };
    for (name, bytes) in [("cover.png", png), ("cover.jpg", jpeg)] {
        let path = dir.path.join(name);
        std::fs::write(&path, &bytes).unwrap();
        assert!((bytes.len() as u64) <= ADJACENT_IMAGE_MAX);
        read(burst.read_tags(&bare));
        let started = Instant::now();
        let cover = burst.cover(Some(&path));
        eprintln!(
            "{name} ({} MiB, 10,000 x 10,000): cover step {:?}; budget {COVER_CPU_MS} ms CPU",
            bytes.len() >> 20,
            started.elapsed()
        );
        assert!(cover.is_some(), "{name} decodes");
    }
}
