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
use super::plan::{Bucket, ContainerKind, CoverPlan, ExportContainer, ExportTrack};
use crate::normalize::normalize_path_key;

// The labels a null or all-illegal field falls back to, so a folder or file always has a name.
const UNKNOWN_ARTIST: &str = "Unknown Artist";
const UNKNOWN_ALBUM: &str = "Unknown Album";
const UNTITLED: &str = "Untitled";

// The literal parent every single's subfolder sits under.
const SINGLES_ROOT: &str = "Singles";

// The one flat folder a playlist's loose tracks land in, beside its album subfolders.
const UNSORTED_ROOT: &str = "Unsorted";

// The general export's top-level sections. Albums move under `Albums/`; each playlist gets its own
// folder under `Playlists/`. A single's `Singles/` parent comes from its kind, not a bucket.
const ALBUMS_ROOT: &str = "Albums";
const PLAYLISTS_ROOT: &str = "Playlists";

// The label a playlist folder falls back to when its name sanitizes to nothing.
const UNKNOWN_PLAYLIST: &str = "Playlist";

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

// The album layout applied when a caller sends no template (a pre-template caller): the artist/album
// folder tree and the `<track_no> - <title>` filename that shipped before templating.
const DEFAULT_FOLDER_PATTERN: &str = "{albumartist}/{album}";
const DEFAULT_FILE_PATTERN: &str = "{track_no} - {title}";

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

/// The album layout a caller chose: a folder pattern (slash-separated segments, empty = flat) and a
/// filename pattern, both in the token language. Singles ignore it and keep their fixed layout.
#[derive(Debug, Clone)]
pub struct AlbumTemplate {
    folder: String,
    file: String,
}

impl AlbumTemplate {
    /// Resolves a caller's patterns. An all-empty config is a pre-template caller and falls back to
    /// the shipped default layout; a blank file pattern alone falls back to the default filename; an
    /// empty folder pattern beside a real file pattern stays the deliberate flat layout.
    pub fn resolve(folder: &str, file: &str) -> Self {
        if folder.is_empty() && file.is_empty() {
            return Self {
                folder: DEFAULT_FOLDER_PATTERN.to_string(),
                file: DEFAULT_FILE_PATTERN.to_string(),
            };
        }
        Self {
            folder: folder.to_string(),
            file: if file.is_empty() {
                DEFAULT_FILE_PATTERN.to_string()
            } else {
                file.to_string()
            },
        }
    }
}

/// Derives the whole export layout from the plan. `dest_len` is the destination path's character
/// count, used to keep full paths inside MAX_PATH. Container folders are deduplicated across the
/// whole tree by album id; filenames are deduplicated within their container by track id. Both
/// preserve the plan's order so the worker can zip layouts back to containers and tracks by index.
pub fn derive_layout(
    containers: &[ExportContainer],
    dest_len: usize,
    template: &AlbumTemplate,
) -> Vec<ContainerLayout> {
    // Provisional folder components per container, then a global dedupe by folded path.
    let mut dirs: Vec<Vec<String>> = containers
        .iter()
        .map(|c| container_components(c, template))
        .collect();
    dedupe_dirs(containers, &mut dirs);

    containers
        .iter()
        .zip(dirs)
        .map(|(container, comps)| {
            let rel_len = comps.iter().map(|c| c.len() + 1).sum::<usize>();
            let filenames = track_filenames(container, dest_len + rel_len, template);
            let tracks = dedupe_filenames(container, filenames);
            ContainerLayout {
                rel_dir: comps.iter().collect(),
                tracks,
            }
        })
        .collect()
}

/// The provisional folder components for one container: its bucket prefix, then its kind's own
/// layout. A flat album stops at the bucket, landing its tracks straight inside; a normal album
/// applies the folder pattern; a single keeps its fixed `Singles/<Artist> - <Title>` layout. Each
/// field falls back to its label and is sanitized.
fn container_components(container: &ExportContainer, template: &AlbumTemplate) -> Vec<String> {
    let mut comps = bucket_components(&container.bucket);
    match container.kind {
        // A flat album gathers its tracks in the bucket dir itself, so it adds no folder of its own.
        ContainerKind::Album if container.flat => {}
        ContainerKind::Album => comps.extend(album_components(container, &template.folder)),
        ContainerKind::Single => {
            let artist = value_or(container.album_artist.as_deref(), UNKNOWN_ARTIST);
            let title = value_or(container.title.as_deref(), UNTITLED);
            let name = sanitize_or(&format!("{artist} - {title}"), UNTITLED);
            comps.push(SINGLES_ROOT.to_string());
            comps.push(name);
        }
        ContainerKind::Unsorted => comps.push(UNSORTED_ROOT.to_string()),
    }
    comps
}

/// The top-level segments a container's bucket prefixes: none for `Root`, `Albums/` for the general
/// export's album section, `Playlists/<name>/` for a playlist's own section. The playlist name is
/// sanitized here, so a bucket carries the raw name and every path rule stays in this engine.
fn bucket_components(bucket: &Bucket) -> Vec<String> {
    match bucket {
        Bucket::Root => Vec::new(),
        Bucket::Albums => vec![ALBUMS_ROOT.to_string()],
        Bucket::Playlist(name) => {
            vec![PLAYLISTS_ROOT.to_string(), sanitize_or(name, UNKNOWN_PLAYLIST)]
        }
    }
}

/// The album folder segments from the folder pattern: split on the literal `/`, substitute each
/// segment's tokens (every value pre-sanitized so it can't inject a separator), sanitize the whole
/// segment, and drop any that resolve to nothing. An empty pattern yields no segments (flat).
fn album_components(container: &ExportContainer, pattern: &str) -> Vec<String> {
    let vals = container_tokens(container);
    pattern
        .split('/')
        .filter_map(|segment| {
            let substituted = substitute(segment, &vals, true);
            let component = sanitize_component(&substituted);
            (!component.is_empty()).then_some(component)
        })
        .collect()
}

/// The provisional filenames for one container's tracks, in track order. An album applies the file
/// pattern; a single reads `<artist> - <title>.<ext>`, since a number is meaningless in a folder of
/// one. Each stem is sanitized and length-guarded.
fn track_filenames(
    container: &ExportContainer,
    prefix_len: usize,
    template: &AlbumTemplate,
) -> Vec<(i64, String)> {
    container
        .tracks
        .iter()
        .enumerate()
        .map(|(i, track)| {
            let ext = clean_ext(&track.ext);
            let filename = match container.kind {
                ContainerKind::Album => {
                    album_filename(&template.file, container, track, i, prefix_len, &ext)
                }
                // A single names its lone file, and each loose Unsorted track its own, by
                // `<artist> - <title>` - a number is meaningless in a folder that never groups them.
                ContainerKind::Single | ContainerKind::Unsorted => {
                    let artist = value_or(track.artist.as_deref(), UNKNOWN_ARTIST);
                    let title = value_or(track.title.as_deref(), UNTITLED);
                    let stem = sanitize_or(&format!("{artist} - {title}"), UNTITLED);
                    let stem = fit_stem(&stem, prefix_len, ext.len());
                    join_ext(&stem, &ext)
                }
            };
            (track.track_id, filename)
        })
        .collect()
}

/// One album track's filename from the file pattern. Tokens substitute against the album fields and
/// this track; a pattern carrying `{ext}` owns the extension, else the real extension is appended.
/// The stem is sanitized and length-guarded, and never empty (falls to `Untitled`).
fn album_filename(
    pattern: &str,
    container: &ExportContainer,
    track: &ExportTrack,
    index: usize,
    prefix_len: usize,
    ext: &str,
) -> String {
    let no = track.track_no.unwrap_or((index as i64) + 1);
    let vals = TokenValues {
        album_artist: container.album_artist.as_deref(),
        album: container.title.as_deref(),
        year: container.year,
        // Genre is per-track now; a filename's `{genre}` reads this track's first managed genre.
        genre: track.genres.first().map(String::as_str),
        artist: track.artist.as_deref(),
        title: track.title.as_deref(),
        track_no: Some(no),
        disc_no: track.disc_no,
        ext: Some(&track.ext),
    };
    // Values go in raw, then the whole stem is sanitized once - a value's separators cannot escape a
    // single filename component, so per-value sanitization is only needed for folder segments.
    let raw = substitute(pattern, &vals, false);
    if pattern.contains("{ext}") {
        // The pattern places the extension itself; keep it as one sanitized, length-guarded name.
        let name = sanitize_or(&raw, UNTITLED);
        fit_stem(&name, prefix_len, 0)
    } else {
        let stem = sanitize_or(&raw, UNTITLED);
        let stem = fit_stem(&stem, prefix_len, ext.len());
        join_ext(&stem, ext)
    }
}

/// The album-level token sources for one container, with the per-track fields left null - a folder
/// belongs to every track, so `{title}`/`{track_no}` and the rest read as their label or empty.
/// Genre is per-track now, so a folder's `{genre}` reads the container's first track's first managed
/// genre - deterministic against the plan's track order, so a re-export lands the same folder.
fn container_tokens(container: &ExportContainer) -> TokenValues<'_> {
    TokenValues {
        album_artist: container.album_artist.as_deref(),
        album: container.title.as_deref(),
        year: container.year,
        genre: container
            .tracks
            .first()
            .and_then(|t| t.genres.first())
            .map(String::as_str),
        artist: None,
        title: None,
        track_no: None,
        disc_no: None,
        ext: None,
    }
}

/// The resolved token sources for one substitution: album-level fields always, per-track fields only
/// when a filename is being built (a folder has no single track, so they read as null).
struct TokenValues<'a> {
    album_artist: Option<&'a str>,
    album: Option<&'a str>,
    year: Option<i64>,
    genre: Option<&'a str>,
    artist: Option<&'a str>,
    title: Option<&'a str>,
    track_no: Option<i64>,
    disc_no: Option<i64>,
    ext: Option<&'a str>,
}

/// One token's substituted text, or None for an unrecognized name (left literal). Artist/album/title
/// fall to their labels when null; `track_no` is zero-padded to two digits; `year`/`disc` are plain;
/// a null `year`/`genre`/`disc`/`ext` reads as empty.
fn token_value(name: &str, vals: &TokenValues) -> Option<String> {
    let text = match name {
        "albumartist" => value_or(vals.album_artist, UNKNOWN_ARTIST).to_string(),
        "album" => value_or(vals.album, UNKNOWN_ALBUM).to_string(),
        "artist" => value_or(vals.artist, UNKNOWN_ARTIST).to_string(),
        "title" => value_or(vals.title, UNTITLED).to_string(),
        "track_no" => match vals.track_no {
            Some(n) => format!("{n:02}"),
            None => String::new(),
        },
        "year" => vals.year.map(|y| y.to_string()).unwrap_or_default(),
        "disc" => vals.disc_no.map(|d| d.to_string()).unwrap_or_default(),
        "genre" => optional(vals.genre).unwrap_or_default().to_string(),
        "ext" => vals.ext.map(clean_ext).unwrap_or_default(),
        _ => return None,
    };
    Some(text)
}

/// Substitutes `{token}` occurrences in `pattern`, leaving unknown tokens and stray braces literal.
/// With `sanitize_values` set, each value is sanitized before insertion so it can never contribute a
/// path separator - used for folder segments; filenames sanitize the whole stem after instead.
fn substitute(pattern: &str, vals: &TokenValues, sanitize_values: bool) -> String {
    let mut out = String::new();
    let mut rest = pattern;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        match after.find('}') {
            Some(close) => {
                let name = &after[..close];
                match token_value(name, vals) {
                    Some(value) if sanitize_values => out.push_str(&sanitize_component(&value)),
                    Some(value) => out.push_str(&value),
                    None => {
                        out.push('{');
                        out.push_str(name);
                        out.push('}');
                    }
                }
                rest = &after[close + 1..];
            }
            None => {
                out.push_str(&rest[open..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
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

/// The trimmed field text, or `label` when it is null or blank. Not yet sanitized.
fn value_or<'a>(value: Option<&'a str>, label: &'a str) -> &'a str {
    match value.map(str::trim) {
        Some(s) if !s.is_empty() => s,
        _ => label,
    }
}

/// The trimmed field text, or None when it is null or blank. For tokens with no fallback label.
fn optional(value: Option<&str>) -> Option<&str> {
    match value.map(str::trim) {
        Some(s) if !s.is_empty() => Some(s),
        _ => None,
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

/// Sanitizes a chosen name into one safe path component, falling back to `label` when it reduces to
/// nothing. The bundled playlist filename reads its name through this.
pub fn safe_component(raw: &str, label: &str) -> String {
    sanitize_or(raw, label)
}

/// The sample path a live preview shows: the real derivation over one synthetic album track,
/// returned with forward slashes. What an export of this album would actually land, sanitization
/// included, so the preview never drifts from the output.
pub fn template_preview(folder: &str, file: &str) -> String {
    let template = AlbumTemplate::resolve(folder, file);
    let track = ExportTrack {
        track_id: 1,
        source: String::new(),
        ext: "mp3".to_string(),
        title: Some("15 Step".to_string()),
        artist: Some("Radiohead".to_string()),
        album_override: None,
        album_artist_override: None,
        year_override: None,
        track_no: Some(1),
        disc_no: Some(1),
        genres: vec!["Alternative".to_string()],
        has_embedded: false,
        keep_own_cover: false,
        own_cover: CoverPlan::None,
    };
    let container = ExportContainer {
        album_id: 1,
        kind: ContainerKind::Album,
        bucket: Bucket::Root,
        flat: false,
        album_artist: Some("Radiohead".to_string()),
        title: Some("In Rainbows".to_string()),
        year: Some(2007),
        cover: CoverPlan::None,
        tracks: vec![track],
        skipped: Vec::new(),
    };
    let layout = derive_layout(&[container], 0, &template);
    let dir = layout[0].rel_dir.to_string_lossy().replace('\\', "/");
    let name = &layout[0].tracks[0].filename;
    if dir.is_empty() {
        name.clone()
    } else {
        format!("{dir}/{name}")
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
            album_override: None,
            album_artist_override: None,
            year_override: None,
            track_no,
            disc_no: None,
            genres: Vec::new(),
            has_embedded: false,
            keep_own_cover: false,
            own_cover: CoverPlan::None,
        }
    }

    fn album(
        album_id: i64,
        artist: Option<&str>,
        title: Option<&str>,
        tracks: Vec<ExportTrack>,
    ) -> ExportContainer {
        ExportContainer {
            album_id,
            kind: ContainerKind::Album,
            bucket: Bucket::Root,
            flat: false,
            album_artist: artist.map(str::to_string),
            title: title.map(str::to_string),
            year: None,
            cover: CoverPlan::None,
            tracks,
            skipped: Vec::new(),
        }
    }

    fn single(
        album_id: i64,
        artist: Option<&str>,
        title: Option<&str>,
        track: ExportTrack,
    ) -> ExportContainer {
        ExportContainer {
            album_id,
            kind: ContainerKind::Single,
            bucket: Bucket::Root,
            flat: false,
            album_artist: artist.map(str::to_string),
            title: title.map(str::to_string),
            year: None,
            cover: CoverPlan::None,
            tracks: vec![track],
            skipped: Vec::new(),
        }
    }

    fn rel(layout: &ContainerLayout) -> String {
        layout.rel_dir.to_string_lossy().replace('/', "\\")
    }

    // The pre-template default layout, used by the regression tests that predate templating.
    fn default_tpl() -> AlbumTemplate {
        AlbumTemplate::resolve("", "")
    }

    #[test]
    fn album_layout_uses_the_track_no_template() {
        let c = album(
            1,
            Some("Artist"),
            Some("Album"),
            vec![track(1, "Song", "Artist", Some(4))],
        );
        let out = derive_layout(&[c], 0, &default_tpl());
        assert_eq!(rel(&out[0]), "Artist\\Album");
        assert_eq!(out[0].tracks[0].filename, "04 - Song.mp3");
    }

    #[test]
    fn single_layout_uses_the_singles_subfolder_and_artist_title_name() {
        let c = single(
            7,
            Some("Artist"),
            Some("Hit"),
            track(1, "Hit", "Artist", None),
        );
        let out = derive_layout(&[c], 0, &default_tpl());
        assert_eq!(rel(&out[0]), "Singles\\Artist - Hit");
        assert_eq!(out[0].tracks[0].filename, "Artist - Hit.mp3");
    }

    #[test]
    fn null_fields_fall_back_to_labels() {
        let album_c = album(1, None, None, vec![track(1, "", "", None)]);
        let out = derive_layout(&[album_c], 0, &default_tpl());
        assert_eq!(rel(&out[0]), "Unknown Artist\\Unknown Album");
        assert_eq!(out[0].tracks[0].filename, "01 - Untitled.mp3");

        let single_c = single(2, None, None, track(1, "", "", None));
        let out = derive_layout(&[single_c], 0, &default_tpl());
        assert_eq!(rel(&out[0]), "Singles\\Unknown Artist - Untitled");
    }

    #[test]
    fn illegal_characters_are_stripped() {
        let c = album(
            1,
            Some("AC/DC"),
            Some("Back:In?Black"),
            vec![track(1, "T/N*R", "AC/DC", Some(1))],
        );
        let out = derive_layout(&[c], 0, &default_tpl());
        assert_eq!(rel(&out[0]), "ACDC\\BackInBlack");
        assert_eq!(out[0].tracks[0].filename, "01 - TNR.mp3");
    }

    #[test]
    fn reserved_device_names_are_broken() {
        let c = album(
            1,
            Some("CON"),
            Some("nul"),
            vec![track(1, "PRN", "CON", Some(1))],
        );
        let out = derive_layout(&[c], 0, &default_tpl());
        assert_eq!(rel(&out[0]), "CON_\\nul_");
        assert_eq!(
            out[0].tracks[0].filename, "01 - PRN.mp3",
            "the stem here is the track_no, not PRN"
        );
    }

    #[test]
    fn trailing_dots_and_spaces_are_dropped() {
        let c = album(
            1,
            Some("Artist "),
            Some("Album..."),
            vec![track(1, "Song. ", "Artist", Some(1))],
        );
        let out = derive_layout(&[c], 0, &default_tpl());
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
            vec![
                track(5, "Same", "A", Some(1)),
                track(2, "Same", "A", Some(1)),
            ],
        );
        let out = derive_layout(&[c], 0, &default_tpl());
        // Track order is preserved: index 0 is track 5, index 1 is track 2.
        assert_eq!(out[0].tracks[0].track_id, 5);
        assert_eq!(out[0].tracks[0].filename, "01 - Same (2).mp3");
        assert_eq!(out[0].tracks[1].track_id, 2);
        assert_eq!(out[0].tracks[1].filename, "01 - Same.mp3");
    }

    #[test]
    fn colliding_container_folders_get_suffixes_by_album_id() {
        let one = album(
            9,
            Some("Artist"),
            Some("Album"),
            vec![track(1, "X", "Artist", Some(1))],
        );
        let two = album(
            3,
            Some("Artist"),
            Some("Album"),
            vec![track(2, "Y", "Artist", Some(1))],
        );
        let out = derive_layout(&[one, two], 0, &default_tpl());
        // Album id 3 wins the base name; album id 9 is suffixed. Input order is preserved.
        assert_eq!(
            rel(&out[0]),
            "Artist\\Album (2)",
            "album 9 comes second by id"
        );
        assert_eq!(rel(&out[1]), "Artist\\Album", "album 3 keeps the base");
    }

    #[test]
    fn sibling_artists_do_not_collide() {
        let one = album(
            1,
            Some("Artist"),
            Some("Album One"),
            vec![track(1, "X", "Artist", Some(1))],
        );
        let two = album(
            2,
            Some("Artist"),
            Some("Album Two"),
            vec![track(2, "Y", "Artist", Some(1))],
        );
        let out = derive_layout(&[one, two], 0, &default_tpl());
        assert_eq!(rel(&out[0]), "Artist\\Album One");
        assert_eq!(rel(&out[1]), "Artist\\Album Two");
    }

    #[test]
    fn colliding_singles_dedupe_across_the_singles_folder() {
        let one = single(
            8,
            Some("Artist"),
            Some("Hit"),
            track(1, "Hit", "Artist", None),
        );
        let two = single(
            4,
            Some("Artist"),
            Some("Hit"),
            track(2, "Hit", "Artist", None),
        );
        let out = derive_layout(&[one, two], 0, &default_tpl());
        assert_eq!(
            rel(&out[0]),
            "Singles\\Artist - Hit (2)",
            "single 8 comes second by id"
        );
        assert_eq!(rel(&out[1]), "Singles\\Artist - Hit");
    }

    #[test]
    fn long_component_is_capped() {
        let long = "x".repeat(400);
        let c = album(
            1,
            Some(&long),
            Some("Album"),
            vec![track(1, "S", "A", Some(1))],
        );
        let out = derive_layout(&[c], 0, &default_tpl());
        let first = out[0].rel_dir.components().next().unwrap();
        assert_eq!(
            first.as_os_str().to_string_lossy().chars().count(),
            MAX_COMPONENT
        );
    }

    // An album with a year and genre set, for the tokens the bare `album` helper leaves null. Genre
    // is per-track now, so the given genre is stamped onto every member's list.
    fn album_full(
        album_id: i64,
        artist: Option<&str>,
        title: Option<&str>,
        year: Option<i64>,
        genre: Option<&str>,
        mut tracks: Vec<ExportTrack>,
    ) -> ExportContainer {
        if let Some(g) = genre {
            for t in &mut tracks {
                t.genres = vec![g.to_string()];
            }
        }
        ExportContainer {
            album_id,
            kind: ContainerKind::Album,
            bucket: Bucket::Root,
            flat: false,
            album_artist: artist.map(str::to_string),
            title: title.map(str::to_string),
            year,
            cover: CoverPlan::None,
            tracks,
            skipped: Vec::new(),
        }
    }

    #[test]
    fn default_patterns_reproduce_the_shipped_album_layout() {
        // The explicit default patterns must land exactly what the pre-template layout did.
        let tpl = AlbumTemplate::resolve("{albumartist}/{album}", "{track_no} - {title}");
        let c = album(
            1,
            Some("Artist"),
            Some("Album"),
            vec![track(1, "Song", "Artist", Some(4))],
        );
        let out = derive_layout(&[c], 0, &tpl);
        assert_eq!(rel(&out[0]), "Artist\\Album");
        assert_eq!(out[0].tracks[0].filename, "04 - Song.mp3");
    }

    #[test]
    fn year_folder_pattern_places_the_year_before_the_album() {
        let tpl = AlbumTemplate::resolve("{albumartist}/{year} - {album}", "{track_no} - {title}");
        let c = album_full(
            1,
            Some("Artist"),
            Some("Album"),
            Some(2007),
            None,
            vec![track(1, "Song", "Artist", Some(1))],
        );
        let out = derive_layout(&[c], 0, &tpl);
        assert_eq!(rel(&out[0]), "Artist\\2007 - Album");
        assert_eq!(out[0].tracks[0].filename, "01 - Song.mp3");
    }

    #[test]
    fn album_only_folder_pattern_drops_the_artist_segment() {
        let tpl = AlbumTemplate::resolve("{album}", "{track_no} - {title}");
        let c = album(
            1,
            Some("Artist"),
            Some("Album"),
            vec![track(1, "Song", "Artist", Some(1))],
        );
        let out = derive_layout(&[c], 0, &tpl);
        assert_eq!(rel(&out[0]), "Album");
    }

    #[test]
    fn flat_pattern_lands_files_at_the_destination_root() {
        // An empty folder pattern with a collision-safe filename pattern writes straight to the root.
        let tpl = AlbumTemplate::resolve("", "{albumartist} - {track_no} - {title}");
        let c = album(
            1,
            Some("Artist"),
            Some("Album"),
            vec![track(1, "Song", "Artist", Some(2))],
        );
        let out = derive_layout(&[c], 0, &tpl);
        assert_eq!(out[0].rel_dir.components().count(), 0, "no album subfolder");
        assert_eq!(out[0].tracks[0].filename, "Artist - 02 - Song.mp3");
    }

    #[test]
    fn tokens_fall_back_to_labels_when_null() {
        let tpl = AlbumTemplate::resolve("{albumartist}/{album}", "{track_no} - {title}");
        let c = album(1, None, None, vec![track(1, "", "", None)]);
        let out = derive_layout(&[c], 0, &tpl);
        assert_eq!(rel(&out[0]), "Unknown Artist\\Unknown Album");
        assert_eq!(out[0].tracks[0].filename, "01 - Untitled.mp3");
    }

    #[test]
    fn a_token_value_cannot_inject_a_subfolder() {
        // A separator inside a field value is sanitized away, never split into an extra segment.
        let tpl = AlbumTemplate::resolve("{album}", "{track_no} - {title}");
        let c = album(
            1,
            Some("Artist"),
            Some("In/Rainbows"),
            vec![track(1, "Song", "Artist", Some(1))],
        );
        let out = derive_layout(&[c], 0, &tpl);
        assert_eq!(
            out[0].rel_dir.components().count(),
            1,
            "the slash does not add a folder"
        );
        assert_eq!(rel(&out[0]), "InRainbows");
    }

    #[test]
    fn file_pattern_can_supply_its_own_extension_token() {
        let tpl = AlbumTemplate::resolve("{album}", "{title}.{ext}");
        let c = album(
            1,
            Some("Artist"),
            Some("Album"),
            vec![track(1, "Song", "Artist", Some(1))],
        );
        let out = derive_layout(&[c], 0, &tpl);
        assert_eq!(
            out[0].tracks[0].filename, "Song.mp3",
            "the ext token supplies the one extension"
        );
    }

    #[test]
    fn a_custom_template_still_dedupes_collisions() {
        // Two tracks resolving to one name still get the deterministic ` (2)` suffix by track id.
        let tpl = AlbumTemplate::resolve("{album}", "{title}");
        let c = album(
            1,
            Some("A"),
            Some("B"),
            vec![track(5, "Same", "A", None), track(2, "Same", "A", None)],
        );
        let out = derive_layout(&[c], 0, &tpl);
        assert_eq!(out[0].tracks[0].filename, "Same (2).mp3");
        assert_eq!(out[0].tracks[1].filename, "Same.mp3");
    }

    #[test]
    fn singles_ignore_the_album_template() {
        // A wild album template must not change a single's fixed Singles/<Artist> - <Title> layout,
        // even with the track carrying a genre the `{genre}` token could otherwise render.
        let tpl = AlbumTemplate::resolve("{genre}/{year}", "{disc} {title}");
        let mut tk = track(1, "Hit", "Artist", None);
        tk.genres = vec!["Rock".into()];
        let c = single(7, Some("Artist"), Some("Hit"), tk);
        let out = derive_layout(&[c], 0, &tpl);
        assert_eq!(rel(&out[0]), "Singles\\Artist - Hit");
        assert_eq!(out[0].tracks[0].filename, "Artist - Hit.mp3");
    }

    #[test]
    fn empty_config_falls_back_to_the_default_layout() {
        // A pre-template caller sends both patterns empty and still gets the shipped album layout.
        let tpl = AlbumTemplate::resolve("", "");
        let c = album(
            1,
            Some("Artist"),
            Some("Album"),
            vec![track(1, "Song", "Artist", Some(3))],
        );
        let out = derive_layout(&[c], 0, &tpl);
        assert_eq!(rel(&out[0]), "Artist\\Album");
        assert_eq!(out[0].tracks[0].filename, "03 - Song.mp3");
    }

    #[test]
    fn preview_renders_the_sample_album_path() {
        let path = template_preview("{albumartist}/{album}", "{track_no} - {title}");
        assert_eq!(path, "Radiohead/In Rainbows/01 - 15 Step.mp3");
    }

    #[test]
    fn preview_reflects_a_flat_pattern() {
        let path = template_preview("", "{albumartist} - {title}");
        assert_eq!(path, "Radiohead - 15 Step.mp3");
    }

    #[test]
    fn unsorted_lands_flat_files_under_one_folder() {
        // A loose track's container is the shared Unsorted folder, its file named artist - title with
        // no track number, and a second loose track sits beside it rather than in its own subfolder.
        let c = ExportContainer {
            album_id: 0,
            kind: ContainerKind::Unsorted,
            bucket: Bucket::Root,
            flat: false,
            album_artist: None,
            title: None,
            year: None,
            cover: CoverPlan::None,
            tracks: vec![track(1, "Loose", "Artist", None), track(2, "Other", "Band", None)],
            skipped: Vec::new(),
        };
        let out = derive_layout(&[c], 0, &default_tpl());
        assert_eq!(rel(&out[0]), "Unsorted");
        assert_eq!(out[0].tracks[0].filename, "Artist - Loose.mp3");
        assert_eq!(out[0].tracks[1].filename, "Band - Other.mp3");
    }

    #[test]
    fn the_albums_bucket_prefixes_an_album_folder() {
        let mut c = album(
            1,
            Some("Artist"),
            Some("Album"),
            vec![track(1, "Song", "Artist", Some(1))],
        );
        c.bucket = Bucket::Albums;
        let out = derive_layout(&[c], 0, &default_tpl());
        assert_eq!(rel(&out[0]), "Albums\\Artist\\Album");
        assert_eq!(out[0].tracks[0].filename, "01 - Song.mp3");
    }

    #[test]
    fn a_playlist_bucket_prefixes_its_members_and_singles() {
        // An album member and a single both sit under the playlist's own folder, the single keeping
        // its `Singles/` parent from its kind.
        let mut member = album(
            1,
            Some("Artist"),
            Some("Album"),
            vec![track(1, "Song", "Artist", Some(1))],
        );
        member.bucket = Bucket::Playlist("Mix".into());
        let mut hit = single(2, Some("Solo"), Some("Hit"), track(2, "Hit", "Solo", None));
        hit.bucket = Bucket::Playlist("Mix".into());
        let out = derive_layout(&[member, hit], 0, &default_tpl());
        assert_eq!(rel(&out[0]), "Playlists\\Mix\\Artist\\Album");
        assert_eq!(rel(&out[1]), "Playlists\\Mix\\Singles\\Solo - Hit");
    }

    #[test]
    fn a_flat_mimic_lands_its_tracks_straight_in_the_playlist_folder() {
        // A flat album adds no folder of its own: the tracks land in `Playlists/<name>/`, numbered by
        // the file pattern, not split into Artist/Album subfolders.
        let mut c = album(
            1,
            Some("Various Artists"),
            Some("Mix"),
            vec![track(1, "One", "A", Some(1)), track(2, "Two", "B", Some(2))],
        );
        c.bucket = Bucket::Playlist("Mix".into());
        c.flat = true;
        let out = derive_layout(&[c], 0, &default_tpl());
        assert_eq!(rel(&out[0]), "Playlists\\Mix");
        assert_eq!(out[0].tracks[0].filename, "01 - One.mp3");
        assert_eq!(out[0].tracks[1].filename, "02 - Two.mp3");
    }

    #[test]
    fn an_all_illegal_playlist_name_falls_back_to_a_label() {
        let mut c = album(
            1,
            Some("Artist"),
            Some("Album"),
            vec![track(1, "Song", "Artist", Some(1))],
        );
        c.bucket = Bucket::Playlist("??".into());
        let out = derive_layout(&[c], 0, &default_tpl());
        assert_eq!(rel(&out[0]), "Playlists\\Playlist\\Artist\\Album");
    }
}
