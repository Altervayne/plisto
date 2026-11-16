/*
 * Staging through a real inspect helper: the cover cache entries main writes from the helper's
 * thumbnails, what a failing cover or a panic costs a burst, the folder work it does, and the
 * in-process read that stands in only when no helper can be set up.
 */

use std::sync::atomic::Ordering;
use std::time::Duration;

use super::*;
use crate::audio::stream::isolate::file::{file_key, use_test_session};
use crate::audio::stream::isolate::inspect::tests::{png, tagged_m4a, TempDir};
use crate::audio::stream::isolate::test_faults::{InspectFault, MARKED_TITLE};
use crate::covers::{ensure_thumb, scale_thumb, scaled_cover_key, thumb_cache_path};

const WAIT: Duration = Duration::from_secs(15);

fn strings(paths: &[&Path]) -> Vec<String> {
    paths
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

fn stage(covers: &Path, paths: &[&Path]) -> Vec<(String, AdHocTrack, f32)> {
    read_ad_hoc_tracks(covers, &InFlightGuard::default(), strings(paths))
}

fn titles(staged: &[(String, AdHocTrack, f32)]) -> Vec<&str> {
    staged.iter().map(|(_, t, _)| t.title.as_str()).collect()
}

#[test]
fn the_cache_key_is_main_computed() {
    let session = use_test_session(WAIT);
    let covers = TempDir::new("staging_covers");
    let music = TempDir::new("staging_music");
    let picture = png(300, 200);
    let path = music.path.join("song.m4a");
    tagged_m4a(&path, "Song", "Artist", Some(picture.clone()));

    let staged = stage(&covers.path, &[&path]);
    assert_eq!(staged.len(), 1);
    let (_, track, gain_db) = &staged[0];
    assert_eq!(track.title, "Song");
    assert_eq!(track.artist.as_deref(), Some("Artist"));
    assert!(*gain_db < 0.0, "the tagged gain rides the track");
    let cover = track.cover.as_ref().expect("the embedded cover is cached");
    assert_eq!((cover.width, cover.height), (300, 200));

    // The key is the hash of the pixels main holds, never the picture's own hash a library cover
    // of the same art is cached under.
    let decoded = image::load_from_memory(&picture).unwrap();
    let scaled: Vec<_> = AD_HOC_EDGES
        .into_iter()
        .map(|edge| (edge, scale_thumb(&decoded, edge)))
        .collect();
    assert_eq!(cover.hash, scaled_cover_key(&scaled));
    assert_ne!(cover.hash, blake3::hash(&picture).to_hex().to_string());
    let library = TempDir::new("staging_library_covers");
    for edge in AD_HOC_EDGES {
        let thumb = thumb_cache_path(&covers.path, &cover.hash, edge);
        let written = std::fs::read(&thumb).expect("both sizes are cached");
        let in_process = ensure_thumb(
            &library.path,
            "art",
            &picture,
            edge,
            &InFlightGuard::default(),
        )
        .unwrap();
        assert_eq!(
            written,
            std::fs::read(in_process).unwrap(),
            "main encodes what the cache encodes from the picture itself"
        );
    }
    assert_eq!(session.launches(), 1);
}

#[test]
fn staging_reads_in_process_only_without_a_helper() {
    let session = use_test_session(WAIT);
    let covers = TempDir::new("staging_fallback_covers");
    let music = TempDir::new("staging_fallback_music");
    let path = music.path.join("song.m4a");
    tagged_m4a(&path, "Fallback", "Artist", Some(png(40, 30)));

    session.fail_setup.store(true, Ordering::Release);
    let staged = stage(&covers.path, &[&path, &path]);
    assert_eq!(titles(&staged), vec!["Fallback", "Fallback"]);
    assert!(staged[0].1.cover.is_some());
    assert_eq!(session.launches(), 1);
    assert!(session.warned());
}

#[test]
fn an_unreadable_file_drops_only_itself_from_the_burst() {
    use_test_session(WAIT);
    let covers = TempDir::new("staging_unreadable_covers");
    let music = TempDir::new("staging_unreadable_music");
    let first = music.path.join("first.m4a");
    let second = music.path.join("second.m4a");
    tagged_m4a(&first, "First", "A", None);
    tagged_m4a(&second, "Second", "B", None);

    let mut paths = strings(&[&first, &second]);
    // A path with a NUL is refused by the file system, so it reads as unreadable.
    paths.insert(1, "bad\0path.m4a".to_string());
    let staged = read_ad_hoc_tracks(&covers.path, &InFlightGuard::default(), paths);
    assert_eq!(titles(&staged), vec!["First", "Second"]);
}

#[test]
fn a_cover_that_spins_or_blows_the_memory_cap_costs_only_the_cover() {
    for fault in [InspectFault::CoverSpin, InspectFault::CoverHog] {
        let session = use_test_session(WAIT);
        let covers = TempDir::new("staging_cover_fault_covers");
        let music = TempDir::new("staging_cover_fault_music");
        let pictured = music.path.join("pictured.m4a");
        let plain = music.path.join("plain.m4a");
        tagged_m4a(&pictured, "Pictured", "A", Some(png(40, 30)));
        tagged_m4a(&plain, "Plain", "B", None);

        let mut burst = InspectBurst::new(AD_HOC_EDGES);
        burst.args = fault.args();
        burst.limits.cover.cpu = Duration::from_millis(500);
        let staged = read_with(
            &covers.path,
            &InFlightGuard::default(),
            strings(&[&pictured, &plain]),
            &mut burst,
            &mut Folders::default(),
        );
        assert_eq!(titles(&staged), vec!["Pictured", "Plain"], "{fault:?}");
        assert!(staged[0].1.cover.is_none(), "{fault:?} costs the cover");
        assert!(staged[0].2 < 0.0, "the tags still came back");
        assert!(!session.is_faulted(&file_key(&pictured)), "{fault:?}");
        assert_eq!(session.launches(), 2, "{fault:?} replaced the helper");
    }
}

#[test]
fn a_panic_while_staging_resets_the_helper_and_keeps_the_rest() {
    let session = use_test_session(WAIT);
    let covers = TempDir::new("staging_panic_covers");
    let music = TempDir::new("staging_panic_music");
    let first = music.path.join("first.m4a");
    let second = music.path.join("second.m4a");
    let third = music.path.join("third.m4a");
    for (path, title) in [(&first, "First"), (&second, "Second"), (&third, "Third")] {
        tagged_m4a(path, title, "A", None);
    }

    PANIC_ON.set(Some(second.to_string_lossy().into_owned()));
    let staged = stage(&covers.path, &[&first, &second, &third]);
    PANIC_ON.set(None);
    assert_eq!(titles(&staged), vec!["First", "Third"]);
    assert_eq!(session.launches(), 2, "the panic reset the burst's helper");
}

#[test]
fn a_file_a_helper_died_on_is_never_read_in_process() {
    let session = use_test_session(WAIT);
    let covers = TempDir::new("staging_struck_covers");
    let music = TempDir::new("staging_struck_music");
    let before = music.path.join("before.m4a");
    let marked = music.path.join("marked.m4a");
    let after = music.path.join("after.m4a");
    tagged_m4a(&before, "Before", "A", None);
    tagged_m4a(&marked, MARKED_TITLE, "B", None);
    tagged_m4a(&after, "After", "C", None);

    let guard = InFlightGuard::default();
    let mut burst = InspectBurst::new(AD_HOC_EDGES);
    burst.args = InspectFault::Abort.args();
    let mut folders = Folders::default();
    read_with(
        &covers.path,
        &guard,
        strings(&[&before]),
        &mut burst,
        &mut folders,
    );
    // The reused helper dies on the marked file, and no fresh helper can be had to try it again.
    session.fail_setup.store(true, Ordering::Release);
    let staged = read_with(
        &covers.path,
        &guard,
        strings(&[&marked, &after]),
        &mut burst,
        &mut folders,
    );
    // An in-process read would have staged the marked file: it is readable audio.
    assert_eq!(
        titles(&staged),
        vec!["After"],
        "only the untouched file is read in-process"
    );
    assert!(!session.is_faulted(&file_key(&marked)));
}

#[test]
fn the_folder_is_listed_once_per_burst_and_not_for_a_file_with_its_own_picture() {
    use_test_session(WAIT);
    let covers = TempDir::new("staging_folder_covers");
    let album = TempDir::new("staging_folder_album");
    let single = TempDir::new("staging_folder_single");
    std::fs::write(album.path.join("folder.png"), png(64, 64)).unwrap();
    let a = album.path.join("a.m4a");
    let b = album.path.join("b.m4a");
    tagged_m4a(&a, "A", "X", None);
    tagged_m4a(&b, "B", "X", None);
    let own = single.path.join("own.m4a");
    tagged_m4a(&own, "Own", "Y", Some(png(32, 32)));
    std::fs::write(single.path.join("cover.png"), png(16, 16)).unwrap();

    let mut folders = Folders::default();
    let staged = read_with(
        &covers.path,
        &InFlightGuard::default(),
        strings(&[&a, &b, &own]),
        &mut InspectBurst::new(AD_HOC_EDGES),
        &mut folders,
    );
    assert_eq!(
        folders.listed, 1,
        "the album's folder once, the single's never"
    );
    let sizes: Vec<_> = staged
        .iter()
        .map(|(_, t, _)| t.cover.as_ref().map(|c| (c.width, c.height)))
        .collect();
    assert_eq!(
        sizes,
        vec![Some((64, 64)), Some((64, 64)), Some((32, 32))],
        "the folder's image for the bare files, the file's own picture otherwise"
    );
}
