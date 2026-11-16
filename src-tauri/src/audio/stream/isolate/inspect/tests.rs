/*
 * Opened files inspected by a real helper in its container: what comes back of their tags and
 * covers, what a hostile picture or a helper death costs, and that a burst shares one helper. Each
 * test runs on a session of its own, so no record, launch count or warning of another test reaches
 * it.
 */

use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
use lofty::config::WriteOptions;
use lofty::mp4::{Atom, AtomData, AtomIdent, Ilst};
use lofty::prelude::{Accessor, TagExt};

use super::*;
use crate::audio::stream::isolate::file::use_test_session;
use crate::audio::stream::isolate::test_faults::{InspectFault, MARKED_TITLE};
use crate::covers::scale_thumb;
use crate::covers::test_support::{minimal_mp4, png_picture};

mod limits;
mod steps;

const EDGES: [u32; 2] = [128, 512];
const WAIT: Duration = Duration::from_secs(15);

/// A throwaway directory, removed on drop.
pub(crate) struct TempDir {
    pub(crate) path: PathBuf,
}

impl TempDir {
    pub(crate) fn new(tag: &str) -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path =
            std::env::temp_dir().join(format!("plisto_inspect_{tag}_{}_{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        Self { path }
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// A byte source whose every read waits until its channel's sender is dropped, then fails: a file
/// on storage that stopped answering.
pub(crate) struct Stalled(pub(crate) crossbeam_channel::Receiver<()>);

impl Read for Stalled {
    fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
        let _ = self.0.recv();
        Err(io::ErrorKind::BrokenPipe.into())
    }
}

impl Seek for Stalled {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        match pos {
            SeekFrom::Start(at) => Ok(at),
            _ => Err(io::ErrorKind::Unsupported.into()),
        }
    }
}

/// A PNG of `width x height` in one colour with a darker left half, so scaling has edges to keep.
pub(crate) fn png(width: u32, height: u32) -> Vec<u8> {
    let img = RgbImage::from_fn(width, height, |x, _| {
        if x < width / 2 {
            Rgb([20, 60, 140])
        } else {
            Rgb([200, 120, 30])
        }
    });
    let mut buf = std::io::Cursor::new(Vec::new());
    DynamicImage::ImageRgb8(img)
        .write_to(&mut buf, ImageFormat::Png)
        .unwrap();
    buf.into_inner()
}

/// Writes an M4A at `path` titled `title` by `artist`, with track ReplayGain tags and `picture` as
/// its embedded cover.
pub(crate) fn tagged_m4a(path: &Path, title: &str, artist: &str, picture: Option<Vec<u8>>) {
    std::fs::write(path, minimal_mp4()).unwrap();
    let mut ilst = Ilst::new();
    ilst.set_title(title.to_string());
    ilst.set_artist(artist.to_string());
    for (name, value) in [
        ("replaygain_track_gain", "-6.52 dB"),
        ("replaygain_track_peak", "0.988553"),
    ] {
        ilst.insert(Atom::new(
            AtomIdent::Freeform {
                mean: "com.apple.iTunes".into(),
                name: name.into(),
            },
            AtomData::UTF8(value.to_string()),
        ));
    }
    if let Some(picture) = picture {
        ilst.insert_picture(png_picture(picture));
    }
    ilst.save_to_path(path, WriteOptions::default()).unwrap();
}

/// A PNG whose header claims `width x height` pixels, with a valid header checksum, over pixel data
/// for 8 x 8.
pub(crate) fn forged_png(width: u32, height: u32) -> Vec<u8> {
    let mut forged = png(8, 8);
    forged[16..20].copy_from_slice(&width.to_be_bytes());
    forged[20..24].copy_from_slice(&height.to_be_bytes());
    let crc = png_crc(&forged[12..29]);
    forged[29..33].copy_from_slice(&crc.to_be_bytes());
    forged
}

fn read(inspection: Inspection) -> InspectedFile {
    match inspection {
        Inspection::Read(file) => file,
        other => panic!("the file reads in the helper, got {other:?}"),
    }
}

// The pixels the cover cache would scale `bytes` to at `edge` in-process.
fn in_process_thumb(bytes: &[u8], edge: u32) -> RgbImage {
    scale_thumb(&image::load_from_memory(bytes).unwrap(), edge)
}

// The CRC of a PNG chunk over its type and data.
fn png_crc(bytes: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &byte in bytes {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xEDB8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

#[test]
fn tags_and_gain_come_back_from_the_inspect_helper() {
    let session = use_test_session(WAIT);
    let dir = TempDir::new("tags");
    let first = dir.path.join("first.m4a");
    let second = dir.path.join("second.m4a");
    tagged_m4a(&first, "Night Drive", "The Example", None);
    tagged_m4a(&second, "Second Song", "Another", None);

    let mut burst = InspectBurst::new(EDGES);
    let file = read(burst.read_tags(&first));
    let (raw, unreadable) = crate::scan::read_tags(&first);
    assert!(!unreadable);
    assert_eq!(file.title.as_deref(), Some("Night Drive"));
    assert_eq!(file.artist.as_deref(), Some("The Example"));
    assert_eq!(file.track_gain.as_deref(), Some("-6.52 dB"));
    assert_eq!(file.track_peak.as_deref(), Some("0.988553"));
    assert_eq!(
        file.title, raw.title,
        "the helper reads what the scan reads"
    );
    assert_eq!(file.track_gain, raw.rg_track_gain);
    assert_eq!(file.duration_secs, raw.duration_secs);
    assert!(!file.has_picture);

    let file = read(burst.read_tags(&second));
    assert_eq!(file.title.as_deref(), Some("Second Song"));
    assert_eq!(session.launches(), 1, "one helper serves the whole burst");

    // A file that is not audio is unreadable, and the helper goes on.
    let junk = dir.path.join("junk.mp3");
    std::fs::write(&junk, b"not audio at all").unwrap();
    assert!(matches!(burst.read_tags(&junk), Inspection::Unreadable));
    assert!(matches!(burst.read_tags(&first), Inspection::Read(_)));
    assert_eq!(session.launches(), 1);
    assert!(!session.is_faulted(&file_key(&junk)));
}

#[test]
fn embedded_and_adjacent_covers_come_back_as_bounded_thumbnails() {
    use_test_session(WAIT);
    let dir = TempDir::new("covers");
    let mut burst = InspectBurst::new(EDGES);

    let embedded = png(40, 30);
    let own = dir.path.join("own.m4a");
    tagged_m4a(&own, "Own", "A", Some(embedded.clone()));
    let adjacent = png(2000, 1000);
    let folder = dir.path.join("folder.png");
    std::fs::write(&folder, &adjacent).unwrap();
    let bare = dir.path.join("bare.m4a");
    tagged_m4a(&bare, "Bare", "B", None);

    assert!(read(burst.read_tags(&own)).has_picture);
    let cover = burst.cover(None).expect("the embedded cover");
    assert_eq!((cover.width, cover.height), (40, 30));
    for (thumb, edge) in cover.thumbs.iter().zip(EDGES) {
        assert!(thumb.width <= edge && thumb.height <= edge);
        assert_eq!(
            thumb.rgb,
            in_process_thumb(&embedded, edge).into_raw(),
            "the helper scales as the cache does"
        );
    }

    assert!(!read(burst.read_tags(&bare)).has_picture);
    let cover = burst.cover(Some(&folder)).expect("the adjacent cover");
    assert_eq!((cover.width, cover.height), (2000, 1000));
    let sizes: Vec<_> = cover.thumbs.iter().map(|t| (t.width, t.height)).collect();
    assert_eq!(sizes, vec![(128, 64), (512, 256)]);
    assert_eq!(
        cover.thumbs[1].rgb,
        in_process_thumb(&adjacent, 512).into_raw()
    );

    read(burst.read_tags(&bare));
    assert!(burst.cover(None).is_none());
    // An image beside the file that is no image leaves it without a cover.
    let fake = dir.path.join("cover.jpg");
    std::fs::write(&fake, b"not an image").unwrap();
    read(burst.read_tags(&bare));
    assert!(burst.cover(Some(&fake)).is_none());
    // A cover is only for the file just read.
    assert!(burst.cover(Some(&folder)).is_none());
}

#[test]
fn a_forged_picture_size_drops_only_the_cover() {
    let session = use_test_session(WAIT);
    let dir = TempDir::new("forged");
    // A header claiming 60,000 x 60,000 pixels: decoding it would take about 10 GiB.
    let forged = forged_png(60_000, 60_000);
    let path = dir.path.join("forged.m4a");
    tagged_m4a(&path, "Forged Art", "Someone", Some(forged.clone()));
    let image = dir.path.join("cover.png");
    std::fs::write(&image, &forged).unwrap();
    let bare = dir.path.join("bare.m4a");
    tagged_m4a(&bare, "Bare", "B", None);

    let mut burst = InspectBurst::new(EDGES);
    let file = read(burst.read_tags(&path));
    assert_eq!(
        file.title.as_deref(),
        Some("Forged Art"),
        "the tags still read"
    );
    assert!(burst.cover(None).is_none(), "the forged cover is dropped");
    read(burst.read_tags(&bare));
    assert!(burst.cover(Some(&image)).is_none());
    assert_eq!(session.launches(), 1, "the helper lived through both");
    assert!(!session.is_faulted(&file_key(&path)));
}

#[test]
fn an_inspect_helper_death_drops_one_file_and_continues_the_burst() {
    let session = use_test_session(WAIT);
    let dir = TempDir::new("death");
    let before = dir.path.join("before.m4a");
    let fatal = dir.path.join("fatal.m4a");
    let after = dir.path.join("after.m4a");
    tagged_m4a(&before, "Before", "A", None);
    tagged_m4a(&fatal, MARKED_TITLE, "X", None);
    tagged_m4a(&after, "After", "B", None);

    let mut burst = InspectBurst::new(EDGES);
    burst.args = InspectFault::Abort.args();
    assert!(matches!(burst.read_tags(&before), Inspection::Read(_)));
    // The reused helper dies, and so does the fresh one it is tried in.
    assert!(matches!(burst.read_tags(&fatal), Inspection::Faulted));
    let file = read(burst.read_tags(&after));
    assert_eq!(file.title.as_deref(), Some("After"));
    assert_eq!(
        session.launches(),
        3,
        "a retry, then a new helper for the rest"
    );
    assert!(session.is_faulted(&file_key(&fatal)));
    assert!(!session.is_faulted(&file_key(&before)));
    assert!(!session.is_faulted(&file_key(&after)));

    // With no helper to be had, the faulted file is still never read in-process.
    session.fail_setup.store(true, Ordering::Release);
    let mut burst = InspectBurst::new(EDGES);
    assert!(matches!(burst.read_tags(&fatal), Inspection::Faulted));
    assert!(matches!(burst.read_tags(&after), Inspection::InProcess));
}

#[test]
fn container_setup_failure_reads_opened_files_in_process_and_logs() {
    let session = use_test_session(WAIT);
    let dir = TempDir::new("setup");
    let path = dir.path.join("song.m4a");
    tagged_m4a(&path, "Song", "A", None);

    session.fail_setup.store(true, Ordering::Release);
    let mut burst = InspectBurst::new(EDGES);
    assert!(matches!(burst.read_tags(&path), Inspection::InProcess));
    assert!(matches!(burst.read_tags(&path), Inspection::InProcess));
    assert_eq!(
        session.launches(),
        1,
        "no launch is tried until the retry time"
    );
    assert!(session.warned(), "the session logged it");

    // A missing file is unreadable before any helper is asked.
    let missing = dir.path.join("missing.m4a");
    assert!(matches!(burst.read_tags(&missing), Inspection::Unreadable));
}
