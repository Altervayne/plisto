// Round trips for the year `tag_file` writes: each format is tagged, then read back through the scan
// reader, and the raw bytes are checked for the key that actually landed on disk.

use super::*;
use crate::covers::test_support::minimal_mp4;
use crate::scan::read_tags;
use std::fs;
use std::path::PathBuf;

struct TempFile(PathBuf);

impl TempFile {
    fn new(name: &str) -> Self {
        Self(std::env::temp_dir().join(format!("plisto_year_{}_{name}", std::process::id())))
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn minimal_mp3() -> Vec<u8> {
    let mut v = Vec::new();
    for _ in 0..3 {
        v.extend_from_slice(&[0xFF, 0xFB, 0x90, 0x00]);
        v.extend_from_slice(&[0u8; 413]);
    }
    v
}

fn minimal_flac() -> Vec<u8> {
    let mut v = b"fLaC".to_vec();
    v.push(0x80);
    v.extend_from_slice(&[0x00, 0x00, 0x22]);
    v.extend_from_slice(&[0u8; 34]);
    v
}

fn ogg_crc(data: &[u8]) -> u32 {
    let mut crc = 0u32;
    for &byte in data {
        crc ^= u32::from(byte) << 24;
        for _ in 0..8 {
            crc = if crc & 0x8000_0000 != 0 {
                (crc << 1) ^ 0x04C1_1DB7
            } else {
                crc << 1
            };
        }
    }
    crc
}

fn ogg_page(flags: u8, granule: u64, seq: u32, packet: &[u8]) -> Vec<u8> {
    let mut segments = vec![255u8; packet.len() / 255];
    segments.push((packet.len() % 255) as u8);
    let mut page = b"OggS".to_vec();
    page.push(0);
    page.push(flags);
    page.extend_from_slice(&granule.to_le_bytes());
    page.extend_from_slice(&1u32.to_le_bytes());
    page.extend_from_slice(&seq.to_le_bytes());
    page.extend_from_slice(&0u32.to_le_bytes());
    page.push(segments.len() as u8);
    page.extend_from_slice(&segments);
    page.extend_from_slice(packet);
    let crc = ogg_crc(&page);
    page[22..26].copy_from_slice(&crc.to_le_bytes());
    page
}

// A minimal Ogg Opus stream with an empty OpusTags packet and one audio page for the length.
fn minimal_opus() -> Vec<u8> {
    let mut head = b"OpusHead".to_vec();
    head.extend_from_slice(&[1, 2]);
    head.extend_from_slice(&312u16.to_le_bytes());
    head.extend_from_slice(&48_000u32.to_le_bytes());
    head.extend_from_slice(&0u16.to_le_bytes());
    head.push(0);
    let mut tags = b"OpusTags".to_vec();
    tags.extend_from_slice(&0u32.to_le_bytes());
    tags.extend_from_slice(&0u32.to_le_bytes());
    let mut file = ogg_page(0x02, 0, 0, &head);
    file.extend(ogg_page(0, 0, 1, &tags));
    file.extend(ogg_page(0x04, 48_000, 2, &[0xF8, 0xFF, 0xFE]));
    file
}

fn tags_with_year(year: Option<i64>) -> TrackTags<'static> {
    TrackTags {
        title: Some("T"),
        artist: None,
        album: None,
        album_artist: None,
        year,
        genres: &[],
        track_no: None,
        disc_no: None,
    }
}

fn has(bytes: &[u8], needle: &[u8]) -> bool {
    bytes.windows(needle.len()).any(|w| w == needle)
}

// Tags `bytes` with `year`, then returns the scan reader's year and the file's raw bytes.
fn tag_and_read(name: &str, bytes: Vec<u8>, year: Option<i64>) -> (Option<String>, Vec<u8>) {
    let file = TempFile::new(name);
    fs::write(&file.0, bytes).unwrap();
    tag_file(&file.0, &tags_with_year(year), None).unwrap();
    let (raw, errored) = read_tags(&file.0);
    assert!(!errored, "{name} should parse");
    (raw.year, fs::read(&file.0).unwrap())
}

#[test]
fn mp3_year_lands_as_tdrc() {
    let (year, bytes) = tag_and_read("a.mp3", minimal_mp3(), Some(2021));
    assert_eq!(year.as_deref(), Some("2021"));
    assert!(has(&bytes, b"TDRC"), "the year is a TDRC frame");
}

#[test]
fn m4a_year_lands_as_the_day_atom() {
    let (year, bytes) = tag_and_read("a.m4a", minimal_mp4(), Some(2021));
    assert_eq!(year.as_deref(), Some("2021"));
    assert!(has(&bytes, b"\xA9day"), "the year is a day atom");
}

#[test]
fn flac_year_lands_as_date_and_never_year() {
    let (year, bytes) = tag_and_read("a.flac", minimal_flac(), Some(2021));
    assert_eq!(year.as_deref(), Some("2021"));
    assert!(has(&bytes, b"DATE=2021"));
    assert!(!has(&bytes, b"YEAR="), "only one of DATE and YEAR is written");
}

#[test]
fn opus_year_lands_as_date() {
    let (year, bytes) = tag_and_read("a.opus", minimal_opus(), Some(2021));
    assert_eq!(year.as_deref(), Some("2021"));
    assert!(has(&bytes, b"DATE=2021"));
    assert!(!has(&bytes, b"YEAR="));
}

// A FLAC carrying YEAR=1999 and DATE=1999-05-01, as another tagger might leave it.
fn flac_dated_1999(file: &TempFile) {
    fs::write(&file.0, minimal_flac()).unwrap();
    let mut tag = match open_tags(&file.0).unwrap() {
        OpenedTags::Other(t) => t
            .primary_tag()
            .cloned()
            .unwrap_or_else(|| Tag::new(TagType::VorbisComments)),
        OpenedTags::Mp4(_) => unreachable!(),
    };
    tag.insert_text(ItemKey::Year, "1999".to_string());
    tag.insert_text(ItemKey::RecordingDate, "1999-05-01".to_string());
    tag.save_to_path(&file.0, WriteOptions::default()).unwrap();
}

#[test]
fn a_none_year_clears_both_keys() {
    let file = TempFile::new("clear.flac");
    flac_dated_1999(&file);

    tag_file(&file.0, &tags_with_year(None), None).unwrap();

    let (raw, _) = read_tags(&file.0);
    assert_eq!(raw.year, None, "no stale year survives");
    let bytes = fs::read(&file.0).unwrap();
    assert!(!has(&bytes, b"YEAR=") && !has(&bytes, b"DATE="));
}

#[test]
fn a_full_date_with_the_same_year_is_kept() {
    let file = TempFile::new("keep.flac");
    flac_dated_1999(&file);

    tag_file(&file.0, &tags_with_year(Some(1999)), None).unwrap();

    let bytes = fs::read(&file.0).unwrap();
    assert!(has(&bytes, b"DATE=1999-05-01"), "the full date survives");
    assert!(!has(&bytes, b"YEAR="));
}

#[test]
fn a_full_date_with_another_year_is_replaced() {
    let file = TempFile::new("replace.flac");
    flac_dated_1999(&file);

    tag_file(&file.0, &tags_with_year(Some(2001)), None).unwrap();

    let (raw, bytes) = (read_tags(&file.0).0, fs::read(&file.0).unwrap());
    assert_eq!(raw.year.as_deref(), Some("2001"));
    assert!(has(&bytes, b"DATE=2001") && !has(&bytes, b"1999-05-01"));
}

#[test]
fn a_longer_year_with_the_same_start_is_not_kept() {
    let file = TempFile::new("prefix.flac");
    flac_dated_1999(&file);

    tag_file(&file.0, &tags_with_year(Some(199)), None).unwrap();

    let bytes = fs::read(&file.0).unwrap();
    assert!(!has(&bytes, b"1999-05-01"), "199 does not match 1999");
    assert_eq!(read_tags(&file.0).0.year.as_deref(), Some("199"));
}
