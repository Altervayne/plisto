/*
 * Reading one file's tags with lofty. Numeric tags (track, disc, year) are pulled as their
 * raw strings, not lofty's parsed integers, so the single numeric-parsing boundary stays in
 * normalize.rs. A file lofty cannot open is not dropped: it yields default (all-None) tags and
 * an error flag, so the caller still indexes it from its path and stats and counts it.
 */

// -- Library Imports --
use std::path::Path;

use lofty::file::FileType;
use lofty::prelude::{Accessor, AudioFile, ItemKey, TaggedFileExt};
use lofty::tag::Tag;

// -- Cover Imports --
use crate::covers::{art_key, read_with_art};

// -- Type Imports --
use crate::model::RawTags;

/// Reads the primary tag and duration from one file. Returns the tags plus a flag that is true
/// when lofty could not parse the file, in which case the tags are all None and only the
/// duration is missing. `has_embedded_cover` is always set here (Some) - any file lofty opens,
/// tags or not, and any file it cannot, counts as examined, so the row never stays NULL.
pub fn read_tags(path: &Path) -> (RawTags, bool) {
    let art = match read_with_art(path) {
        Ok(a) => a,
        Err(_) => {
            return (
                RawTags {
                    has_embedded_cover: Some(false),
                    ..RawTags::default()
                },
                true,
            )
        }
    };

    let tagged = art.tagged();
    let mut raw = RawTags {
        duration_secs: Some(tagged.properties().duration().as_secs_f64()),
        has_embedded_cover: Some(false),
        ..RawTags::default()
    };

    if let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
        raw.title = tag.title().map(|c| c.into_owned());
        raw.artist = tag.artist().map(|c| c.into_owned());
        raw.album = tag.album().map(|c| c.into_owned());
        raw.genre = tag.genre().map(|c| c.into_owned());
        raw.album_artist = tag.get_string(ItemKey::AlbumArtist).map(str::to_string);
        raw.track_no = tag.get_string(ItemKey::TrackNumber).map(str::to_string);
        raw.disc_no = tag.get_string(ItemKey::DiscNumber).map(str::to_string);
        raw.year = tag
            .get_string(ItemKey::Year)
            .or_else(|| tag.get_string(ItemKey::RecordingDate))
            .map(str::to_string);
        read_replaygain(tag, tagged.file_type() == FileType::Opus, &mut raw);
    }

    // Rides the file already read, so it costs no extra read: one hash pass over the picture bytes
    // and a header parse, no decode.
    let cover = art.cover();
    raw.has_embedded_cover = Some(cover.is_some());
    raw.cover_art = cover.and_then(|picture| art_key(picture.data()));

    (raw, false)
}

/// Fills the four ReplayGain fields from the tag. lofty maps `REPLAYGAIN_*` for ID3v2 (TXXX), Vorbis
/// comments (FLAC, Ogg) and MP4 freeform atoms; other containers read as untagged. Opus ignores the
/// `REPLAYGAIN_*` gains, as its spec does, and reads `R128_TRACK_GAIN` / `R128_ALBUM_GAIN` instead: a
/// Q7.8 fixed-point integer relative to -23 LUFS, stored as plain dB with no reference shift.
fn read_replaygain(tag: &Tag, opus: bool, raw: &mut RawTags) {
    let text = |key| tag.get_string(key).map(str::to_string);
    raw.rg_track_peak = text(ItemKey::ReplayGainTrackPeak);
    raw.rg_album_peak = text(ItemKey::ReplayGainAlbumPeak);
    if opus {
        raw.rg_track_gain = r128_db(tag.get_string(ItemKey::R128TrackGain));
        raw.rg_album_gain = r128_db(tag.get_string(ItemKey::R128AlbumGain));
    } else {
        raw.rg_track_gain = text(ItemKey::ReplayGainTrackGain);
        raw.rg_album_gain = text(ItemKey::ReplayGainAlbumGain);
    }
}

/// An R128 gain tag (a Q7.8 integer, 256 units per dB) as a "<db> dB" string; None when not an integer.
fn r128_db(value: Option<&str>) -> Option<String> {
    let q78 = value?.trim().parse::<i32>().ok()?;
    Some(format!("{} dB", f64::from(q78) / 256.0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::covers::test_support::{
        minimal_mp4, png_bytes, png_picture, write_mp4_with_pictures,
    };
    use lofty::config::WriteOptions;
    use lofty::mp4::{Atom, AtomData, AtomIdent, Ilst};
    use lofty::prelude::TagExt;
    use lofty::tag::TagType;

    // A temp file path unique to this test, removed when dropped.
    struct TempFile(std::path::PathBuf);

    impl TempFile {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir();
            Self(dir.join(format!("plisto_rg_{}_{name}", std::process::id())))
        }
    }

    impl Drop for TempFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    // Three silent MPEG-1 Layer III frames (128 kbps, 44.1 kHz), enough for lofty to open the file.
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

    // The Ogg page CRC: polynomial 0x04C11DB7, no reflection, zero start.
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

    // One Ogg page holding a single packet.
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

    // A minimal Ogg Opus stream whose OpusTags carry `comments`, plus one audio page for the length.
    fn opus_with_comments(comments: &[&str]) -> Vec<u8> {
        let mut head = b"OpusHead".to_vec();
        head.extend_from_slice(&[1, 2]);
        head.extend_from_slice(&312u16.to_le_bytes());
        head.extend_from_slice(&48_000u32.to_le_bytes());
        head.extend_from_slice(&0u16.to_le_bytes());
        head.push(0);

        let mut tags = b"OpusTags".to_vec();
        let vendor = b"plisto-test";
        tags.extend_from_slice(&(vendor.len() as u32).to_le_bytes());
        tags.extend_from_slice(vendor);
        tags.extend_from_slice(&(comments.len() as u32).to_le_bytes());
        for comment in comments {
            tags.extend_from_slice(&(comment.len() as u32).to_le_bytes());
            tags.extend_from_slice(comment.as_bytes());
        }

        let mut file = ogg_page(0x02, 0, 0, &head);
        file.extend(ogg_page(0, 0, 1, &tags));
        file.extend(ogg_page(0x04, 48_000, 2, &[0xF8, 0xFF, 0xFE]));
        file
    }

    // Writes `bytes` to a temp file, tags it with the four ReplayGain keys through lofty, and reads it.
    fn tagged_read(name: &str, bytes: Vec<u8>, tag_type: TagType) -> RawTags {
        let file = TempFile::new(name);
        std::fs::write(&file.0, bytes).unwrap();
        let mut tag = Tag::new(tag_type);
        tag.insert_text(ItemKey::ReplayGainTrackGain, "-6.52 dB".to_string());
        tag.insert_text(ItemKey::ReplayGainTrackPeak, "0.988553".to_string());
        tag.insert_text(ItemKey::ReplayGainAlbumGain, "-7.10 dB".to_string());
        tag.insert_text(ItemKey::ReplayGainAlbumPeak, "0.999".to_string());
        tag.save_to_path(&file.0, WriteOptions::default()).unwrap();
        let (raw, errored) = read_tags(&file.0);
        assert!(!errored, "{name} should parse");
        raw
    }

    fn assert_four(raw: &RawTags) {
        assert_eq!(raw.rg_track_gain.as_deref(), Some("-6.52 dB"));
        assert_eq!(raw.rg_track_peak.as_deref(), Some("0.988553"));
        assert_eq!(raw.rg_album_gain.as_deref(), Some("-7.10 dB"));
        assert_eq!(raw.rg_album_peak.as_deref(), Some("0.999"));
    }

    #[test]
    fn id3v2_txxx_replaygain_reads_back() {
        assert_four(&tagged_read("a.mp3", minimal_mp3(), TagType::Id3v2));
    }

    #[test]
    fn flac_vorbis_comment_replaygain_reads_back() {
        assert_four(&tagged_read(
            "a.flac",
            minimal_flac(),
            TagType::VorbisComments,
        ));
    }

    #[test]
    fn m4a_freeform_replaygain_reads_back() {
        let file = TempFile::new("a.m4a");
        std::fs::write(&file.0, minimal_mp4()).unwrap();
        let mut ilst = Ilst::new();
        for (name, value) in [
            ("replaygain_track_gain", "-6.52 dB"),
            ("replaygain_track_peak", "0.988553"),
            ("replaygain_album_gain", "-7.10 dB"),
            ("replaygain_album_peak", "0.999"),
        ] {
            ilst.insert(Atom::new(
                AtomIdent::Freeform {
                    mean: "com.apple.iTunes".into(),
                    name: name.into(),
                },
                AtomData::UTF8(value.to_string()),
            ));
        }
        ilst.save_to_path(&file.0, WriteOptions::default()).unwrap();

        let (raw, errored) = read_tags(&file.0);
        assert!(!errored);
        assert_four(&raw);
    }

    #[test]
    fn opus_r128_gain_reads_as_unshifted_db() {
        let file = TempFile::new("a.opus");
        // -1280 / 256 = -5 dB; the REPLAYGAIN_TRACK_GAIN here is ignored for Opus.
        std::fs::write(
            &file.0,
            opus_with_comments(&[
                "R128_TRACK_GAIN=-1280",
                "R128_ALBUM_GAIN=384",
                "REPLAYGAIN_TRACK_GAIN=-9.00 dB",
                "REPLAYGAIN_TRACK_PEAK=0.75",
            ]),
        )
        .unwrap();

        let (raw, errored) = read_tags(&file.0);

        assert!(!errored);
        assert_eq!(raw.rg_track_gain.as_deref(), Some("-5 dB"));
        assert_eq!(raw.rg_album_gain.as_deref(), Some("1.5 dB"));
        assert_eq!(raw.rg_track_peak.as_deref(), Some("0.75"));
        assert_eq!(raw.rg_album_peak, None);
    }

    #[test]
    fn an_untagged_file_has_no_replaygain() {
        let file = TempFile::new("plain.flac");
        std::fs::write(&file.0, minimal_flac()).unwrap();

        let (raw, errored) = read_tags(&file.0);

        assert!(!errored);
        assert_eq!(raw.rg_track_gain, None);
        assert_eq!(raw.rg_album_peak, None);
    }

    #[test]
    fn r128_db_rejects_non_integers() {
        assert_eq!(r128_db(Some("-1280")).as_deref(), Some("-5 dB"));
        assert_eq!(r128_db(Some("loud")), None);
        assert_eq!(r128_db(None), None);
    }

    #[test]
    fn an_mp4_cover_reads_as_embedded() {
        let path = std::env::temp_dir().join(format!("plisto_scan_tags_{}.m4a", std::process::id()));
        write_mp4_with_pictures(&path, vec![png_picture(png_bytes(8, 8))]);

        let (raw, errored) = read_tags(&path);
        let _ = std::fs::remove_file(&path);

        assert!(!errored);
        assert_eq!(raw.has_embedded_cover, Some(true));
    }

    #[test]
    fn the_cover_key_is_the_picture_the_resolver_reads() {
        let path = std::env::temp_dir().join(format!("plisto_scan_key_{}.m4a", std::process::id()));
        write_mp4_with_pictures(&path, vec![png_picture(png_bytes(12, 6))]);

        let (raw, _) = read_tags(&path);
        let resolved = crate::covers::read_embedded_cover_bytes(&path);
        let _ = std::fs::remove_file(&path);

        let key = raw.cover_art.expect("the cover is keyed");
        assert_eq!(Some(key.clone()), resolved.as_deref().and_then(art_key));
        assert_eq!((key.width, key.height), (12, 6));
    }

    #[test]
    fn a_file_without_a_cover_has_no_key() {
        let file = TempFile::new("nokey.flac");
        std::fs::write(&file.0, minimal_flac()).unwrap();

        let (raw, _) = read_tags(&file.0);

        assert_eq!(raw.has_embedded_cover, Some(false));
        assert_eq!(raw.cover_art, None);
    }
}
