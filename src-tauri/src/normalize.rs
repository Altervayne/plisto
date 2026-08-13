/*
 * The single boundary from a raw tag set to a persistable row. Everything here is pure and
 * deterministic: no disk, no clock, no globals. The clock and file stats are injected by the
 * caller so the same inputs always yield the same TrackRecord, which is what the tests lean on.
 */

// -- Library Imports --
use std::path::Path;

// -- Type Imports --
use crate::model::{RawTags, TrackRecord};

// The audio extensions we index. Lowercase; membership is tested case-insensitively.
const AUDIO_EXTS: &[&str] = &[
    "mp3", "flac", "m4a", "aac", "alac", "opus", "ogg", "wav", "wma", "ape",
];

/// Builds the normalized row for one file from its raw tags and file stats. `source_path` is
/// the on-disk path; `size_bytes`/`mtime` come from the file, `scanned_at` from the caller's
/// clock. Empty or whitespace tags collapse to None, numerics are parsed from their leading
/// integer, `ext` is lowercased and `source_path` is stored as its canonical dedup key.
pub fn normalize_track(
    source_path: &str,
    size_bytes: i64,
    mtime: i64,
    scanned_at: i64,
    raw: &RawTags,
) -> TrackRecord {
    let path = Path::new(source_path);
    let filename = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = path
        .extension()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    TrackRecord {
        source_path: normalize_path_key(source_path),
        filename,
        ext,
        size_bytes,
        mtime,
        duration_secs: raw.duration_secs,
        raw_title: clean_text(&raw.title),
        raw_artist: clean_text(&raw.artist),
        raw_album: clean_text(&raw.album),
        raw_album_artist: clean_text(&raw.album_artist),
        raw_track_no: parse_leading_int(&raw.track_no),
        raw_disc_no: parse_leading_int(&raw.disc_no),
        raw_year: parse_leading_int(&raw.year),
        raw_genre: clean_text(&raw.genre),
        has_embedded_cover: raw.has_embedded_cover,
        scanned_at,
    }
}

/// Lexical canonicalization for the dedup key only. Purely string-level so it never touches
/// disk and works on paths whose file no longer exists. On Windows separators fold to `\` and
/// the whole path lowercases, so one file cannot land as two rows under different casing.
/// Idempotent: running it on its own output changes nothing.
pub fn normalize_path_key(path: &str) -> String {
    #[cfg(windows)]
    {
        path.replace('/', "\\").to_lowercase()
    }
    #[cfg(not(windows))]
    {
        path.to_string()
    }
}

/// True when `ext` is one of the audio extensions we index. Case-insensitive and tolerant of
/// a leading dot.
pub fn is_audio(ext: &str) -> bool {
    let ext = ext.trim_start_matches('.').to_lowercase();
    AUDIO_EXTS.contains(&ext.as_str())
}

/// True when a stored file's (size, mtime) differs from what is on disk now, meaning the row
/// must be re-read. Unchanged stats mean the row can be skipped without reopening the file.
pub fn needs_rescan(stored: (i64, i64), current: (i64, i64)) -> bool {
    stored != current
}

/// True when a row must be re-read: either its stats changed, or its art was never examined.
/// `art_known` is false for a row whose `has_embedded_cover` is still NULL, so a legacy row is
/// re-read once to fill the flag and skipped on every later pass once it is non-NULL.
pub fn needs_reread(stored: (i64, i64), current: (i64, i64), art_known: bool) -> bool {
    needs_rescan(stored, current) || !art_known
}

/// Trims a tag and drops it to None when empty. A blank or whitespace-only tag is the same as
/// no tag: we never persist an empty string.
fn clean_text(opt: &Option<String>) -> Option<String> {
    opt.as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Parses the leading integer out of a messy numeric tag: "3/12" -> 3, "1997-01-01" -> 1997,
/// "" or a non-numeric value -> None. Only leading ASCII digits are read.
fn parse_leading_int(opt: &Option<String>) -> Option<i64> {
    let raw = opt.as_deref()?.trim();
    let digits: String = raw.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        None
    } else {
        digits.parse::<i64>().ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tags() -> RawTags {
        RawTags::default()
    }

    #[test]
    fn empty_and_whitespace_tags_become_none() {
        let raw = RawTags {
            title: Some(String::new()),
            artist: Some("   ".to_string()),
            album: Some("\t\n".to_string()),
            ..tags()
        };
        let rec = normalize_track("/music/song.mp3", 10, 20, 99, &raw);
        assert_eq!(rec.raw_title, None);
        assert_eq!(rec.raw_artist, None);
        assert_eq!(rec.raw_album, None);
    }

    #[test]
    fn tags_are_trimmed() {
        let raw = RawTags {
            title: Some("  Hello  ".to_string()),
            ..tags()
        };
        let rec = normalize_track("/music/song.mp3", 10, 20, 99, &raw);
        assert_eq!(rec.raw_title.as_deref(), Some("Hello"));
    }

    #[test]
    fn track_no_parses_leading_integer() {
        let raw = RawTags {
            track_no: Some("3/12".to_string()),
            ..tags()
        };
        let rec = normalize_track("/music/song.mp3", 10, 20, 99, &raw);
        assert_eq!(rec.raw_track_no, Some(3));
    }

    #[test]
    fn year_parses_leading_integer() {
        let raw = RawTags {
            year: Some("1997-01-01".to_string()),
            ..tags()
        };
        let rec = normalize_track("/music/song.mp3", 10, 20, 99, &raw);
        assert_eq!(rec.raw_year, Some(1997));
    }

    #[test]
    fn non_numeric_numeric_tag_is_none() {
        let raw = RawTags {
            disc_no: Some("side A".to_string()),
            year: Some("unknown".to_string()),
            ..tags()
        };
        let rec = normalize_track("/music/song.mp3", 10, 20, 99, &raw);
        assert_eq!(rec.raw_disc_no, None);
        assert_eq!(rec.raw_year, None);
    }

    #[test]
    fn ext_is_lowercased_and_filename_derived() {
        let rec = normalize_track("/music/Folder/Song.FLAC", 10, 20, 99, &tags());
        assert_eq!(rec.ext, "flac");
        assert_eq!(rec.filename, "Song.FLAC");
    }

    #[test]
    fn path_key_is_idempotent() {
        let once = normalize_path_key("/Music/Sub/Song.mp3");
        let twice = normalize_path_key(&once);
        assert_eq!(once, twice);
    }

    #[test]
    fn path_key_case_folds_on_windows() {
        let a = normalize_path_key("C:\\Music\\Song.mp3");
        let b = normalize_path_key("c:\\music\\song.MP3");
        if cfg!(windows) {
            assert_eq!(a, b);
        } else {
            assert_ne!(a, b);
        }
    }

    #[test]
    fn audio_membership_is_case_insensitive() {
        assert!(is_audio("mp3"));
        assert!(is_audio("FLAC"));
        assert!(is_audio(".Opus"));
        assert!(is_audio("ape"));
        assert!(!is_audio("txt"));
        assert!(!is_audio("jpg"));
        assert!(!is_audio(""));
    }

    #[test]
    fn rescan_only_when_stats_change() {
        assert!(!needs_rescan((100, 200), (100, 200)));
        assert!(needs_rescan((100, 200), (101, 200)));
        assert!(needs_rescan((100, 200), (100, 201)));
    }

    #[test]
    fn reread_drains_unexamined_art_then_settles() {
        // Unchanged stats, art already examined: nothing to do.
        assert!(!needs_reread((100, 200), (100, 200), true));
        // Unchanged stats, art never examined: re-read once to fill the flag.
        assert!(needs_reread((100, 200), (100, 200), false));
        // Changed stats always re-read, whatever the art state.
        assert!(needs_reread((100, 200), (101, 200), true));
        assert!(needs_reread((100, 200), (101, 200), false));
    }
}
