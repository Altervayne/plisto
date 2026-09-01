/*
 * A tolerant .cue sheet parser: pure, deterministic, and dependency-free, mirroring the filename
 * extractor. It reads the disc performer and each track's number, title, performer, and start time,
 * and returns whatever parsed. Unknown lines are ignored and malformed values fall back to a default,
 * so a partial or lightly non-standard sheet still imports what it can rather than failing whole.
 */

// -- Library Imports --
use std::path::Path;

// -- Local Imports --
use crate::dto::{CueSheet, CueTrack};

// A cue sheet counts time in frames of 1/75 of a second (the CD sector rate).
const CUE_FRAMES_PER_SEC: f64 = 75.0;

/// Why a cue sheet could not be read. The parse itself never fails - it returns what it could read -
/// so the only failure is not being able to open the file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CueError {
    Read,
}

impl std::fmt::Display for CueError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("could not read the cue sheet")
    }
}

impl std::error::Error for CueError {}

/// Reads and parses the cue sheet at `path`. The bytes are decoded lossily, so a Latin-1 sheet (a
/// common encoding) still parses rather than being rejected as non-UTF-8.
pub fn parse_cue(path: &Path) -> Result<CueSheet, CueError> {
    let bytes = std::fs::read(path).map_err(|_| CueError::Read)?;
    let text = String::from_utf8_lossy(&bytes);
    Ok(parse(&text))
}

/// Parses cue sheet text. A PERFORMER or TITLE before the first TRACK belongs to the disc; after a
/// TRACK it belongs to that track. INDEX 01 sets the track's start time. Anything else is ignored.
fn parse(text: &str) -> CueSheet {
    let mut disc_performer = None;
    let mut tracks: Vec<CueTrack> = Vec::new();
    let mut current: Option<CueTrack> = None;

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let (command, rest) = split_first_word(trimmed);

        match command.to_ascii_uppercase().as_str() {
            "TRACK" => {
                if let Some(prev) = current.take() {
                    tracks.push(prev);
                }
                let number = rest
                    .split_whitespace()
                    .next()
                    .and_then(|n| n.parse().ok())
                    .unwrap_or(0);
                current = Some(CueTrack {
                    number,
                    title: None,
                    performer: None,
                    start_secs: 0.0,
                });
            }
            "TITLE" => {
                if let Some(track) = current.as_mut() {
                    track.title = Some(unquote(rest));
                }
            }
            "PERFORMER" => {
                let value = unquote(rest);
                match current.as_mut() {
                    Some(track) => track.performer = Some(value),
                    None => disc_performer = Some(value),
                }
            }
            "INDEX" => {
                let mut parts = rest.split_whitespace();
                if parts.next() == Some("01") {
                    if let (Some(track), Some(stamp)) = (current.as_mut(), parts.next()) {
                        track.start_secs = parse_msf(stamp);
                    }
                }
            }
            _ => {}
        }
    }

    if let Some(prev) = current.take() {
        tracks.push(prev);
    }

    CueSheet {
        performer: disc_performer,
        tracks,
    }
}

/// Splits a line into its leading command word and the remainder, both trimmed.
fn split_first_word(line: &str) -> (&str, &str) {
    match line.split_once(char::is_whitespace) {
        Some((first, rest)) => (first, rest.trim()),
        None => (line, ""),
    }
}

/// Strips one pair of surrounding double quotes when present, else returns the trimmed text. Cue
/// values are conventionally quoted, but an unquoted value is tolerated.
fn unquote(value: &str) -> String {
    let trimmed = value.trim();
    match trimmed.strip_prefix('"').and_then(|s| s.strip_suffix('"')) {
        Some(inner) => inner.to_string(),
        None => trimmed.to_string(),
    }
}

/// Parses a `mm:ss:ff` timestamp to seconds, where `ff` is CD frames (1/75 s). A malformed field
/// reads as zero, so a garbled stamp yields a zero start rather than dropping the track.
fn parse_msf(stamp: &str) -> f64 {
    let mut parts = stamp.split(':');
    let minutes: f64 = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0.0);
    let seconds: f64 = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0.0);
    let frames: f64 = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0.0);
    minutes * 60.0 + seconds + frames / CUE_FRAMES_PER_SEC
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHEET: &str = r#"PERFORMER "Disc Artist"
TITLE "The Album"
FILE "album.wav" WAVE
  TRACK 01 AUDIO
    TITLE "First Song"
    PERFORMER "Track One Artist"
    INDEX 01 00:00:00
  TRACK 02 AUDIO
    TITLE "Second Song"
    INDEX 01 03:30:37
"#;

    #[test]
    fn parses_disc_and_track_fields() {
        let sheet = parse(SHEET);
        assert_eq!(sheet.performer.as_deref(), Some("Disc Artist"));
        assert_eq!(sheet.tracks.len(), 2);

        let first = &sheet.tracks[0];
        assert_eq!(first.number, 1);
        assert_eq!(first.title.as_deref(), Some("First Song"));
        assert_eq!(first.performer.as_deref(), Some("Track One Artist"));
        assert_eq!(first.start_secs, 0.0);

        let second = &sheet.tracks[1];
        assert_eq!(second.number, 2);
        assert_eq!(second.title.as_deref(), Some("Second Song"));
        // A track that names no performer inherits none here; the disc performer is separate.
        assert_eq!(second.performer, None);
        // 3:30 and 37 CD frames: 210 + 37/75 seconds.
        assert!((second.start_secs - (210.0 + 37.0 / 75.0)).abs() < 1e-9);
    }

    #[test]
    fn tolerates_unknown_lines_and_missing_quotes() {
        let text = "REM GENRE Ambient\nTRACK 01 AUDIO\nTITLE Unquoted Title\nINDEX 01 00:01:00\n";
        let sheet = parse(text);
        assert_eq!(sheet.performer, None);
        assert_eq!(sheet.tracks.len(), 1);
        assert_eq!(sheet.tracks[0].title.as_deref(), Some("Unquoted Title"));
        assert!((sheet.tracks[0].start_secs - 1.0).abs() < 1e-9);
    }

    #[test]
    fn an_empty_sheet_yields_no_tracks() {
        let sheet = parse("");
        assert_eq!(sheet.performer, None);
        assert!(sheet.tracks.is_empty());
    }
}
