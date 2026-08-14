/*
 * The path derivation engine: pure, deterministic, no disk and no clock. It turns resolved
 * container and track fields into the on-disk layout - folder components and filenames - with
 * null fields falling back to fixed labels, Windows-strict sanitization on every component, and
 * deterministic collision suffixes so a re-export lands the exact same tree. Determinism is what
 * makes re-export idempotent: two runs over the same plan produce byte-identical paths.
 */

// -- Library Imports --
use std::collections::HashMap;
use std::path::PathBuf;

use unicode_normalization::UnicodeNormalization;

// -- Local Imports --
use super::plan::{ContainerKind, ExportContainer};
use crate::normalize::normalize_path_key;

// The labels a null or all-illegal field falls back to, so a folder or file always has a name.
const UNKNOWN_ARTIST: &str = "Unknown Artist";
const UNKNOWN_ALBUM: &str = "Unknown Album";
const UNTITLED: &str = "Untitled";

// The literal parent every single's subfolder sits under.
const SINGLES_ROOT: &str = "Singles";

// The characters Windows forbids in a path component, plus control chars stripped separately.
const ILLEGAL: &[char] = &['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

// The reserved DOS device names. A component whose stem matches one (case-insensitively) cannot be
// a real file, so it is broken with a trailing underscore.
const RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

// The per-component character cap and the whole-path budget guarding MAX_PATH (260 with the null
// terminator), leaving a small margin for a collision suffix.
const MAX_COMPONENT: usize = 255;
const MAX_PATH_BUDGET: usize = 255;

/// One container's resolved on-disk layout: its relative directory under the destination and each
/// track's final filename, in the container's own track order. Paired with its plan container by
/// position, so it carries no album id of its own.
#[derive(Debug, Clone)]
pub struct ContainerLayout {
    pub rel_dir: PathBuf,
    pub tracks: Vec<TrackLayout>,
}

/// One track's resolved filename, paired with its id so the worker zips it back to the plan.
#[derive(Debug, Clone)]
pub struct TrackLayout {
    pub track_id: i64,
    pub filename: String,
}

/// Derives the whole export layout from the plan. `dest_len` is the destination path's character
/// count, used to keep full paths inside MAX_PATH. Container folders are deduplicated across the
/// whole tree by album id; filenames are deduplicated within their container by track id. Both
/// preserve the plan's order so the worker can zip layouts back to containers and tracks by index.
pub fn derive_layout(containers: &[ExportContainer], dest_len: usize) -> Vec<ContainerLayout> {
    // Provisional folder components per container, then a global dedupe by folded path.
    let mut dirs: Vec<Vec<String>> = containers.iter().map(container_components).collect();
    dedupe_dirs(containers, &mut dirs);

    containers
        .iter()
        .zip(dirs)
        .map(|(container, comps)| {
            let rel_len = comps.iter().map(|c| c.len() + 1).sum::<usize>();
            let filenames = track_filenames(container, dest_len + rel_len);
            let tracks = dedupe_filenames(container, filenames);
            ContainerLayout {
                rel_dir: comps.iter().collect(),
                tracks,
            }
        })
        .collect()
}

/// The provisional folder components for one container: `<Artist>/<Album>` for an album, or
/// `Singles/<Artist> - <Title>` for a single. Each field falls back to its label and is sanitized.
fn container_components(container: &ExportContainer) -> Vec<String> {
    match container.kind {
        ContainerKind::Album => vec![
            component(container.album_artist.as_deref(), UNKNOWN_ARTIST),
            component(container.title.as_deref(), UNKNOWN_ALBUM),
        ],
        ContainerKind::Single => {
            let artist = value_or(container.album_artist.as_deref(), UNKNOWN_ARTIST);
            let title = value_or(container.title.as_deref(), UNTITLED);
            let name = sanitize_or(&format!("{artist} - {title}"), UNTITLED);
            vec![SINGLES_ROOT.to_string(), name]
        }
    }
}

/// The provisional filenames for one container's tracks, in track order. An album track reads
/// `<track_no:02> - <title>.<ext>`; a single track reads `<artist> - <title>.<ext>`, since a
/// number is meaningless in a folder of one. Each stem is sanitized and length-guarded.
fn track_filenames(container: &ExportContainer, prefix_len: usize) -> Vec<(i64, String)> {
    container
        .tracks
        .iter()
        .enumerate()
        .map(|(i, track)| {
            let ext = clean_ext(&track.ext);
            let stem = match container.kind {
                ContainerKind::Album => {
                    let no = track.track_no.unwrap_or((i as i64) + 1);
                    let title = value_or(track.title.as_deref(), UNTITLED);
                    format!("{no:02} - {title}")
                }
                ContainerKind::Single => {
                    let artist = value_or(track.artist.as_deref(), UNKNOWN_ARTIST);
                    let title = value_or(track.title.as_deref(), UNTITLED);
                    format!("{artist} - {title}")
                }
            };
            let stem = sanitize_or(&stem, UNTITLED);
            let stem = fit_stem(&stem, prefix_len, ext.len());
            (track.track_id, join_ext(&stem, &ext))
        })
        .collect()
}

/// Deduplicates container folders across the whole tree. Two containers whose folded relative path
/// matches collide; the lowest album id keeps the base name and each later one gets a ` (n)` suffix
/// on its last component. Ordering by album id makes the assignment stable across runs.
fn dedupe_dirs(containers: &[ExportContainer], dirs: &mut [Vec<String>]) {
    let mut order: Vec<usize> = (0..containers.len()).collect();
    order.sort_by_key(|&i| containers[i].album_id);

    let mut seen: HashMap<String, usize> = HashMap::new();
    for &i in &order {
        let key = folded_path(&dirs[i]);
        let n = *seen.get(&key).unwrap_or(&0);
        if n > 0 {
            if let Some(last) = dirs[i].last_mut() {
                *last = suffixed(last, n + 1);
            }
        }
        seen.insert(key, n + 1);
    }
}

/// Deduplicates filenames within one container. Two tracks whose folded filename matches collide;
/// the lowest track id keeps the base name and each later one gets a ` (n)` suffix before the
/// extension. Ordering by track id makes the assignment stable across runs; the result stays in
/// the container's track order.
fn dedupe_filenames(container: &ExportContainer, names: Vec<(i64, String)>) -> Vec<TrackLayout> {
    let mut order: Vec<usize> = (0..names.len()).collect();
    order.sort_by_key(|&i| names[i].0);

    let mut resolved: Vec<Option<String>> = vec![None; names.len()];
    let mut seen: HashMap<String, usize> = HashMap::new();
    for &i in &order {
        let base = &names[i].1;
        let key = normalize_path_key(base);
        let n = *seen.get(&key).unwrap_or(&0);
        let name = if n > 0 {
            suffix_filename(base, n + 1)
        } else {
            base.clone()
        };
        seen.insert(key, n + 1);
        resolved[i] = Some(name);
    }

    container
        .tracks
        .iter()
        .zip(resolved)
        .map(|(track, name)| TrackLayout {
            track_id: track.track_id,
            filename: name.unwrap_or_default(),
        })
        .collect()
}

/// A field turned into a sanitized folder component, falling back to `label` when it is null,
/// blank, or sanitizes away to nothing.
fn component(value: Option<&str>, label: &str) -> String {
    sanitize_or(value_or(value, label), label)
}

/// The trimmed field text, or `label` when it is null or blank. Not yet sanitized.
fn value_or<'a>(value: Option<&'a str>, label: &'a str) -> &'a str {
    match value.map(str::trim) {
        Some(s) if !s.is_empty() => s,
        _ => label,
    }
}

/// Sanitizes `raw`, falling back to a sanitized `label` when the result is empty.
fn sanitize_or(raw: &str, label: &str) -> String {
    let s = sanitize_component(raw);
    if s.is_empty() {
        sanitize_component(label)
    } else {
        s
    }
}

/// Windows-strict sanitization of one path component: NFC-normalize, strip the forbidden
/// characters and control chars, drop trailing dots and spaces, break a reserved device name, and
/// cap the length. May return empty (all-illegal input); callers substitute a label.
fn sanitize_component(raw: &str) -> String {
    let nfc: String = raw.nfc().collect();
    let stripped: String = nfc
        .chars()
        .filter(|c| !ILLEGAL.contains(c) && !c.is_control())
        .collect();
    let trimmed = stripped.trim().trim_end_matches(['.', ' ']).trim_end();
    let broken = break_reserved(trimmed);
    cap_chars(&broken, MAX_COMPONENT)
}

/// Appends an underscore to a component whose stem is a reserved device name, so `CON` becomes
/// `CON_` and `NUL.txt` becomes `NUL_.txt`-safe. The check is on the portion before the first dot,
/// case-insensitively.
fn break_reserved(component: &str) -> String {
    let stem = component.split('.').next().unwrap_or(component);
    if RESERVED.iter().any(|r| r.eq_ignore_ascii_case(stem)) {
        format!("{component}_")
    } else {
        component.to_string()
    }
}

/// The extension cleaned of any forbidden or control characters. Already lowercased upstream.
fn clean_ext(ext: &str) -> String {
    ext.chars()
        .filter(|c| !ILLEGAL.contains(c) && !c.is_control() && *c != '.')
        .collect()
}

/// Joins a stem and extension, dropping the dot when there is no extension.
fn join_ext(stem: &str, ext: &str) -> String {
    if ext.is_empty() {
        stem.to_string()
    } else {
        format!("{stem}.{ext}")
    }
}

/// Trims a filename stem so the full path stays inside MAX_PATH. `prefix_len` is the destination
/// plus relative-directory length; `ext_len` is reserved for the extension. Best-effort: it keeps
/// at least one character so a name never vanishes.
fn fit_stem(stem: &str, prefix_len: usize, ext_len: usize) -> String {
    let budget = MAX_PATH_BUDGET.saturating_sub(prefix_len + ext_len + 1);
    let budget = budget.max(1);
    cap_chars(stem, budget.min(MAX_COMPONENT))
}

/// Caps a string to at most `max` characters on a char boundary.
fn cap_chars(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// The folded key for a relative path, so two components differing only in case collide on the
/// filesystems that fold it.
fn folded_path(components: &[String]) -> String {
    normalize_path_key(&components.join("\\"))
}

/// A component with a ` (n)` collision suffix appended.
fn suffixed(component: &str, n: usize) -> String {
    format!("{component} ({n})")
}

/// A filename with a ` (n)` collision suffix inserted before its extension.
fn suffix_filename(filename: &str, n: usize) -> String {
    match filename.rsplit_once('.') {
        Some((stem, ext)) => format!("{stem} ({n}).{ext}"),
        None => format!("{filename} ({n})"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::export::plan::{CoverPlan, ExportTrack};

    fn track(track_id: i64, title: &str, artist: &str, track_no: Option<i64>) -> ExportTrack {
        ExportTrack {
            track_id,
            source: format!("/m/{track_id}.mp3"),
            ext: "mp3".into(),
            title: (!title.is_empty()).then(|| title.to_string()),
            artist: (!artist.is_empty()).then(|| artist.to_string()),
            track_no,
            disc_no: None,
            has_embedded: false,
        }
    }

    fn album(album_id: i64, artist: Option<&str>, title: Option<&str>, tracks: Vec<ExportTrack>) -> ExportContainer {
        ExportContainer {
            album_id,
            kind: ContainerKind::Album,
            album_artist: artist.map(str::to_string),
            title: title.map(str::to_string),
            year: None,
            genre: None,
            cover: CoverPlan::None,
            tracks,
            skipped: Vec::new(),
        }
    }

    fn single(album_id: i64, artist: Option<&str>, title: Option<&str>, track: ExportTrack) -> ExportContainer {
        ExportContainer {
            album_id,
            kind: ContainerKind::Single,
            album_artist: artist.map(str::to_string),
            title: title.map(str::to_string),
            year: None,
            genre: None,
            cover: CoverPlan::None,
            tracks: vec![track],
            skipped: Vec::new(),
        }
    }

    fn rel(layout: &ContainerLayout) -> String {
        layout.rel_dir.to_string_lossy().replace('/', "\\")
    }

    #[test]
    fn album_layout_uses_the_track_no_template() {
        let c = album(1, Some("Artist"), Some("Album"), vec![track(1, "Song", "Artist", Some(4))]);
        let out = derive_layout(&[c], 0);
        assert_eq!(rel(&out[0]), "Artist\\Album");
        assert_eq!(out[0].tracks[0].filename, "04 - Song.mp3");
    }

    #[test]
    fn single_layout_uses_the_singles_subfolder_and_artist_title_name() {
        let c = single(7, Some("Artist"), Some("Hit"), track(1, "Hit", "Artist", None));
        let out = derive_layout(&[c], 0);
        assert_eq!(rel(&out[0]), "Singles\\Artist - Hit");
        assert_eq!(out[0].tracks[0].filename, "Artist - Hit.mp3");
    }

    #[test]
    fn null_fields_fall_back_to_labels() {
        let album_c = album(1, None, None, vec![track(1, "", "", None)]);
        let out = derive_layout(&[album_c], 0);
        assert_eq!(rel(&out[0]), "Unknown Artist\\Unknown Album");
        assert_eq!(out[0].tracks[0].filename, "01 - Untitled.mp3");

        let single_c = single(2, None, None, track(1, "", "", None));
        let out = derive_layout(&[single_c], 0);
        assert_eq!(rel(&out[0]), "Singles\\Unknown Artist - Untitled");
    }

    #[test]
    fn illegal_characters_are_stripped() {
        let c = album(1, Some("AC/DC"), Some("Back:In?Black"), vec![track(1, "T/N*R", "AC/DC", Some(1))]);
        let out = derive_layout(&[c], 0);
        assert_eq!(rel(&out[0]), "ACDC\\BackInBlack");
        assert_eq!(out[0].tracks[0].filename, "01 - TNR.mp3");
    }

    #[test]
    fn reserved_device_names_are_broken() {
        let c = album(1, Some("CON"), Some("nul"), vec![track(1, "PRN", "CON", Some(1))]);
        let out = derive_layout(&[c], 0);
        assert_eq!(rel(&out[0]), "CON_\\nul_");
        assert_eq!(out[0].tracks[0].filename, "01 - PRN.mp3", "the stem here is the track_no, not PRN");
    }

    #[test]
    fn trailing_dots_and_spaces_are_dropped() {
        let c = album(1, Some("Artist "), Some("Album..."), vec![track(1, "Song. ", "Artist", Some(1))]);
        let out = derive_layout(&[c], 0);
        assert_eq!(rel(&out[0]), "Artist\\Album");
        assert_eq!(out[0].tracks[0].filename, "01 - Song.mp3");
    }

    #[test]
    fn colliding_filenames_get_deterministic_suffixes_by_track_id() {
        // Two tracks resolve to the same name; the lower track id keeps the base, the higher gets (2).
        let c = album(
            1,
            Some("A"),
            Some("B"),
            vec![track(5, "Same", "A", Some(1)), track(2, "Same", "A", Some(1))],
        );
        let out = derive_layout(&[c], 0);
        // Track order is preserved: index 0 is track 5, index 1 is track 2.
        assert_eq!(out[0].tracks[0].track_id, 5);
        assert_eq!(out[0].tracks[0].filename, "01 - Same (2).mp3");
        assert_eq!(out[0].tracks[1].track_id, 2);
        assert_eq!(out[0].tracks[1].filename, "01 - Same.mp3");
    }

    #[test]
    fn colliding_container_folders_get_suffixes_by_album_id() {
        let one = album(9, Some("Artist"), Some("Album"), vec![track(1, "X", "Artist", Some(1))]);
        let two = album(3, Some("Artist"), Some("Album"), vec![track(2, "Y", "Artist", Some(1))]);
        let out = derive_layout(&[one, two], 0);
        // Album id 3 wins the base name; album id 9 is suffixed. Input order is preserved.
        assert_eq!(rel(&out[0]), "Artist\\Album (2)", "album 9 comes second by id");
        assert_eq!(rel(&out[1]), "Artist\\Album", "album 3 keeps the base");
    }

    #[test]
    fn sibling_artists_do_not_collide() {
        let one = album(1, Some("Artist"), Some("Album One"), vec![track(1, "X", "Artist", Some(1))]);
        let two = album(2, Some("Artist"), Some("Album Two"), vec![track(2, "Y", "Artist", Some(1))]);
        let out = derive_layout(&[one, two], 0);
        assert_eq!(rel(&out[0]), "Artist\\Album One");
        assert_eq!(rel(&out[1]), "Artist\\Album Two");
    }

    #[test]
    fn colliding_singles_dedupe_across_the_singles_folder() {
        let one = single(8, Some("Artist"), Some("Hit"), track(1, "Hit", "Artist", None));
        let two = single(4, Some("Artist"), Some("Hit"), track(2, "Hit", "Artist", None));
        let out = derive_layout(&[one, two], 0);
        assert_eq!(rel(&out[0]), "Singles\\Artist - Hit (2)", "single 8 comes second by id");
        assert_eq!(rel(&out[1]), "Singles\\Artist - Hit");
    }

    #[test]
    fn long_component_is_capped() {
        let long = "x".repeat(400);
        let c = album(1, Some(&long), Some("Album"), vec![track(1, "S", "A", Some(1))]);
        let out = derive_layout(&[c], 0);
        let first = out[0].rel_dir.components().next().unwrap();
        assert_eq!(first.as_os_str().to_string_lossy().chars().count(), MAX_COMPONENT);
    }
}
