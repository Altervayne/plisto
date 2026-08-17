/*
 * The playlist export snapshot and its .m3u8 renderer. A playlist exports two ways: an in-place
 * .m3u8 pointing at the original library files, and a self-contained folder of retagged copies with
 * a bundled .m3u8 inside. Both start from the same owned plan, snapshotted under a brief lock, with
 * every editable value resolved through resolve.rs so an exported tag matches what the user sees.
 * A slot may be loose (no album) or a member of one: the album fields fall to the container's value
 * for a member, to the raw scan value for a loose track, mirroring the album export's resolution.
 */

// -- Library Imports --
use std::path::Path;

use rusqlite::Connection;

// -- Local Imports --
use super::plan::CoverPlan;
use crate::db;
use crate::resolve::{effective_artist, effective_title};

/// One playlist slot staged for the m3u renderers: the real-case source to reference, its duration
/// for the #EXTINF line, and the resolved artist/title that label it. `missing_at` marks a slot whose
/// source is gone - dropped by the renderer. `track_id` names the slot on a report row and keys the
/// bundled playlist's relative-path map.
#[derive(Debug, Clone)]
pub struct PlaylistExportTrack {
    pub track_id: i64,
    pub source_path: String,
    pub duration_secs: Option<f64>,
    pub missing_at: Option<i64>,
    pub title: Option<String>,
    pub artist: Option<String>,
}

/// A playlist's owned m3u snapshot: its display name (None = unset, resolved to a default) and its
/// slots in play order. The renderers read from this without touching the DB again.
#[derive(Debug, Clone)]
pub struct PlaylistExportPlan {
    pub name: Option<String>,
    pub tracks: Vec<PlaylistExportTrack>,
}

/// Snapshots one playlist into an owned m3u snapshot. Each slot resolves its title/artist through
/// resolve.rs, exactly as the read path does, and carries the real-case source the #EXTINF path
/// points at. The album-structured folder builds its own plan through the library engine; this feeds
/// the in-place and rich m3u8 renderers and the bundled playlist. The only DB touch after this
/// returns is none.
pub fn playlist_export_plan(
    conn: &Connection,
    playlist_id: i64,
) -> rusqlite::Result<PlaylistExportPlan> {
    let name = db::playlist_name(conn, playlist_id)?;
    let rows = db::load_playlist_export_tracks(conn, playlist_id)?;

    let tracks = rows
        .into_iter()
        .map(|row| {
            // Open the file by its real-case path; the folded key stands in only for a legacy row
            // that never captured one.
            let source = row.display_path.unwrap_or(row.source_path);
            PlaylistExportTrack {
                track_id: row.track_id,
                duration_secs: row.duration_secs,
                missing_at: row.missing_at,
                title: effective_title(&row.raw_title, &row.title_override),
                artist: effective_artist(&row.raw_artist, &row.artist_override),
                source_path: source,
            }
        })
        .collect();

    Ok(PlaylistExportPlan { name, tracks })
}

/// Renders the plan as Extended M3U. The header, then per non-missing slot two lines: an `#EXTINF`
/// with the duration in whole seconds (`-1` when unknown) and the `artist - title` label, then the
/// path `path_for` returns for that slot. `path_for` lets one renderer serve both cases: the
/// in-place file passes the absolute source, the bundled file passes the relative copied filename.
/// Every path is emitted with forward slashes, whatever the host OS: `/` resolves on Windows players
/// and is the only separator Android and other mobile players accept, so a `\`-laden Windows path
/// never lands unreadable on a phone. UTF-8 with `\n` line endings. Missing-source slots are omitted,
/// matching the copy's skip.
pub fn render_m3u(
    plan: &PlaylistExportPlan,
    path_for: impl Fn(&PlaylistExportTrack) -> String,
) -> String {
    let mut out = String::from("#EXTM3U\n");
    for track in &plan.tracks {
        if track.missing_at.is_some() {
            continue;
        }
        let secs = track.duration_secs.map(|d| d.round() as i64).unwrap_or(-1);
        let label = track_label(
            track.artist.as_deref(),
            track.title.as_deref(),
            &file_stem(&track.source_path),
        );
        out.push_str(&format!("#EXTINF:{secs},{label}\n"));
        out.push_str(&path_for(track).replace('\\', "/"));
        out.push('\n');
    }
    out
}

/// Renders the plan as a rich `.m3u8`: the Extended M3U body over the in-place source paths, with
/// Plisto's own directives after the `#EXTM3U` line - a `#PLAYLIST` name, a `#DESCRIPTION` when the
/// playlist carries a blurb, and an `#EXTIMG:cover.jpg` when a cover sits beside the file. Other
/// players ignore the extra directives; Plisto reads them back on a later import. The name falls to
/// `Playlist` when unset, matching the file's own default stem. Reuses render_m3u for the body.
/// Folds any newline in a directive value to a space so a multi-line name or description can never
/// break the one-line `#PLAYLIST`/`#DESCRIPTION` directive (m3u has no line-continuation or escape).
fn one_line(s: &str) -> String {
    s.replace(['\r', '\n'], " ")
}

pub fn render_rich_m3u8(
    plan: &PlaylistExportPlan,
    description: Option<&str>,
    has_cover: bool,
) -> String {
    // The body already opens with `#EXTM3U`; the directives sit between it and the first slot, so
    // the header line stays first as the format demands.
    let body = render_m3u(plan, |t| t.source_path.clone());
    let entries = body.strip_prefix("#EXTM3U\n").unwrap_or(&body);

    let mut out = String::from("#EXTM3U\n");
    out.push_str(&format!(
        "#PLAYLIST:{}\n",
        one_line(plan.name.as_deref().unwrap_or("Playlist"))
    ));
    if let Some(desc) = trimmed(description) {
        out.push_str(&format!("#DESCRIPTION:{}\n", one_line(desc)));
    }
    if has_cover {
        out.push_str("#EXTIMG:cover.jpg\n");
    }
    out.push_str(entries);
    out
}

/// The write plan for a playlist's own cover: its bound imported cover resolved to a full-res blob
/// key, or None when it has none. Unlike an album, a playlist has no member fallback, so an unbound
/// playlist simply exports no cover.jpg. The blob key is the only DB read, so the worker reads bytes
/// off the lock.
pub fn playlist_cover_plan(conn: &Connection, playlist_id: i64) -> rusqlite::Result<CoverPlan> {
    if let Some(cover_id) = db::get_playlist_cover_id(conn, playlist_id)? {
        if let Some((content_hash, byte_len)) = db::get_cover_blob_key(conn, cover_id)? {
            return Ok(CoverPlan::Store {
                content_hash,
                byte_len,
            });
        }
    }
    Ok(CoverPlan::None)
}

/// The `artist - title` label for a slot, falling to the file's own stem when neither is set so a
/// null-null slot names itself instead of rendering an empty label. Shared by the #EXTINF line and
/// the copied filename so both read the same.
pub fn track_label(artist: Option<&str>, title: Option<&str>, stem: &str) -> String {
    match (trimmed(artist), trimmed(title)) {
        (None, None) => stem.to_string(),
        (a, t) => format!("{} - {}", a.unwrap_or(""), t.unwrap_or("")),
    }
}

/// The file stem of a path (its name without the extension), or the whole path when it has none.
/// The fallback label a null-null slot carries into its #EXTINF line and copied filename.
pub fn file_stem(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

/// The trimmed text, or None when it is null or blank.
fn trimmed(value: Option<&str>) -> Option<&str> {
    match value.map(str::trim) {
        Some(s) if !s.is_empty() => Some(s),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use rusqlite::Connection;

    // Inserts a track carrying the raw fields the resolution reads, and returns its id.
    #[allow(clippy::too_many_arguments)]
    fn insert_track(
        conn: &Connection,
        source_path: &str,
        title: &str,
        artist: &str,
        album: Option<&str>,
        album_artist: Option<&str>,
        year: Option<i64>,
        duration: Option<f64>,
    ) -> i64 {
        conn.execute(
            "INSERT INTO tracks (source_path, display_path, filename, ext, size_bytes, mtime,
                                 duration_secs, raw_title, raw_artist, raw_album, raw_album_artist,
                                 raw_year, has_embedded_cover, scanned_at)
             VALUES (?1, ?1, 'f.mp3', 'mp3', 10, 20, ?2, ?3, ?4, ?5, ?6, ?7, 0, 30)",
            rusqlite::params![source_path, duration, title, artist, album, album_artist, year],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    #[test]
    fn a_slot_resolves_its_title_artist_and_real_source() {
        let mut conn = db::open_in_memory().unwrap();
        let t = insert_track(
            &conn,
            "/m/loose.mp3",
            "Raw Title",
            "Raw Artist",
            None,
            None,
            None,
            Some(123.4),
        );
        // The edit layer wins over the raw title, exactly as the read path resolves it.
        db::set_track_edit(&conn, t, Some("Edited Title".into()), None, None, None, None, None)
            .unwrap();
        let pl = db::create_playlist(&conn, Some("Mix".into()), 100).unwrap();
        db::add_tracks_to_playlist(&mut conn, pl.id, &[t], 100).unwrap();

        let plan = playlist_export_plan(&conn, pl.id).unwrap();
        assert_eq!(plan.name.as_deref(), Some("Mix"));
        assert_eq!(plan.tracks.len(), 1);
        let track = &plan.tracks[0];
        assert_eq!(track.track_id, t);
        assert_eq!(track.title.as_deref(), Some("Edited Title"), "the edit beats the raw title");
        assert_eq!(track.artist.as_deref(), Some("Raw Artist"));
        assert_eq!(track.duration_secs, Some(123.4), "duration is carried for the #EXTINF line");
        assert_eq!(track.source_path, "/m/loose.mp3", "the real-case source the m3u points at");
    }

    #[test]
    fn slots_arrive_in_position_order_and_duplicates_are_kept() {
        let mut conn = db::open_in_memory().unwrap();
        let a = insert_track(&conn, "/m/a.mp3", "A", "Artist", None, None, None, None);
        let b = insert_track(&conn, "/m/b.mp3", "B", "Artist", None, None, None, None);
        let pl = db::create_playlist(&conn, None, 100).unwrap();
        // b, a, then a again: the same track sits twice, and order follows position, not track id.
        db::add_tracks_to_playlist(&mut conn, pl.id, &[b, a, a], 100).unwrap();

        let plan = playlist_export_plan(&conn, pl.id).unwrap();
        assert_eq!(plan.name, None, "an unnamed playlist resolves to None");
        let titles: Vec<&str> = plan
            .tracks
            .iter()
            .map(|t| t.title.as_deref().unwrap_or(""))
            .collect();
        assert_eq!(titles, vec!["B", "A", "A"], "play order, duplicates kept");
        let ids: Vec<i64> = plan.tracks.iter().map(|t| t.track_id).collect();
        assert_eq!(ids, vec![b, a, a], "each slot names its own track, duplicates included");
    }

    // A plan built by hand, so the m3u tests do not need the DB.
    fn track(
        track_id: i64,
        source: &str,
        artist: Option<&str>,
        title: Option<&str>,
        duration: Option<f64>,
        missing: bool,
    ) -> PlaylistExportTrack {
        PlaylistExportTrack {
            track_id,
            source_path: source.to_string(),
            duration_secs: duration,
            missing_at: missing.then_some(42),
            title: title.map(str::to_string),
            artist: artist.map(str::to_string),
        }
    }

    #[test]
    fn m3u_renders_the_header_extinf_and_absolute_paths() {
        let plan = PlaylistExportPlan {
            name: Some("Mix".into()),
            tracks: vec![
                track(1, "/m/a.mp3", Some("Artist"), Some("Song"), Some(184.6), false),
                track(2, "/m/b.mp3", Some("Band"), Some("Track"), None, false),
            ],
        };
        let rendered = render_m3u(&plan, |t| t.source_path.clone());
        assert_eq!(
            rendered,
            "#EXTM3U\n\
             #EXTINF:185,Artist - Song\n\
             /m/a.mp3\n\
             #EXTINF:-1,Band - Track\n\
             /m/b.mp3\n",
            "rounded seconds, -1 for null duration, absolute paths",
        );
    }

    #[test]
    fn m3u_omits_missing_slots_and_uses_the_path_closure() {
        let plan = PlaylistExportPlan {
            name: None,
            tracks: vec![
                track(1, "/m/a.mp3", Some("Artist"), Some("Song"), Some(10.0), false),
                track(2, "/m/gone.mp3", Some("X"), Some("Y"), Some(5.0), true),
                track(3, "/m/c.mp3", Some("Artist"), Some("Third"), Some(20.0), false),
            ],
        };
        // The bundled case: the closure maps each slot to its relative copied filename by track id.
        let rendered = render_m3u(&plan, |t| format!("{:02} - copy.mp3", t.track_id));
        assert_eq!(
            rendered,
            "#EXTM3U\n\
             #EXTINF:10,Artist - Song\n\
             01 - copy.mp3\n\
             #EXTINF:20,Artist - Third\n\
             03 - copy.mp3\n",
            "the missing slot is omitted and the closure supplies the path",
        );
    }

    #[test]
    fn rich_m3u8_prepends_the_directives_before_the_body() {
        let plan = PlaylistExportPlan {
            name: Some("Roadtrip".into()),
            tracks: vec![track(
                1,
                "/m/a.mp3",
                Some("Artist"),
                Some("Song"),
                Some(184.6),
                false,
            )],
        };
        let rendered = render_rich_m3u8(&plan, Some("Windows down"), true);
        assert_eq!(
            rendered,
            "#EXTM3U\n\
             #PLAYLIST:Roadtrip\n\
             #DESCRIPTION:Windows down\n\
             #EXTIMG:cover.jpg\n\
             #EXTINF:185,Artist - Song\n\
             /m/a.mp3\n",
            "the header block sits between #EXTM3U and the first slot",
        );
    }

    #[test]
    fn rich_m3u8_omits_the_description_and_cover_when_unset() {
        // No description and no cover: neither directive appears, and an unnamed playlist falls to
        // the default name in the #PLAYLIST line.
        let plan = PlaylistExportPlan {
            name: None,
            tracks: vec![track(
                1,
                "/m/a.mp3",
                Some("Artist"),
                Some("Song"),
                Some(10.0),
                false,
            )],
        };
        let rendered = render_rich_m3u8(&plan, None, false);
        assert_eq!(
            rendered,
            "#EXTM3U\n\
             #PLAYLIST:Playlist\n\
             #EXTINF:10,Artist - Song\n\
             /m/a.mp3\n",
            "a blank description and no cover leave the directives out",
        );

        // A blank-but-present description is treated as unset, so it never renders an empty line.
        let blank = render_rich_m3u8(&plan, Some("   "), false);
        assert!(!blank.contains("#DESCRIPTION"), "blank description omitted");
    }

    #[test]
    fn m3u_emits_forward_slashes_for_a_backslash_path() {
        // A Windows source path renders with forward slashes, so an absolute or relative path never
        // lands on a phone with the one separator its player cannot read.
        let plan = PlaylistExportPlan {
            name: None,
            tracks: vec![track(
                1,
                "C:\\Users\\me\\Music\\a.mp3",
                Some("A"),
                Some("Song"),
                Some(1.0),
                false,
            )],
        };
        let rendered = render_m3u(&plan, |t| t.source_path.clone());
        assert!(
            rendered.contains("C:/Users/me/Music/a.mp3"),
            "backslashes become forward slashes",
        );
        assert!(!rendered.contains('\\'), "no backslash survives the render");
    }

    #[test]
    fn m3u_label_falls_back_to_the_file_stem_when_artist_and_title_are_null() {
        let plan = PlaylistExportPlan {
            name: None,
            tracks: vec![track(1, "/m/some file.mp3", None, None, Some(3.0), false)],
        };
        let rendered = render_m3u(&plan, |t| t.source_path.clone());
        assert_eq!(
            rendered, "#EXTM3U\n#EXTINF:3,some file\n/m/some file.mp3\n",
            "the stem stands in so the label is never empty",
        );
    }
}
