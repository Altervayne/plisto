/*
 * The visualizer defaults: an optional kind per album (a column on `albums`) and per track (one row in
 * `track_visualizers`). The kind is stored verbatim and never checked against a list, so a kind retired
 * later leaves a harmless row the frontend ignores. Nothing here touches tags or the export record.
 */

// -- Library Imports --
use rusqlite::{params, Connection};

// -- Type Imports --
use crate::dto::{AlbumVisualizer, TrackVisualizer, VisualizerDefaults};

/// The longest kind string accepted, in bytes.
const MAX_KIND_BYTES: usize = 64;

/// Every stored default, albums and tracks, ordered by id.
pub fn list_visualizer_defaults(conn: &Connection) -> rusqlite::Result<VisualizerDefaults> {
    let albums = conn
        .prepare("SELECT id, visualizer FROM albums WHERE visualizer IS NOT NULL ORDER BY id")?
        .query_map([], |r| {
            Ok(AlbumVisualizer {
                album_id: r.get(0)?,
                kind: r.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let tracks = conn
        .prepare("SELECT track_id, kind FROM track_visualizers ORDER BY track_id")?
        .query_map([], |r| {
            Ok(TrackVisualizer {
                track_id: r.get(0)?,
                kind: r.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(VisualizerDefaults { albums, tracks })
}

/// Sets or clears (`None`) one album's default. Errors when the album does not exist or the kind is
/// invalid. The album's `updated_at` is left alone: a default is not an edit of its metadata.
pub fn set_album_visualizer(
    conn: &Connection,
    album_id: i64,
    kind: Option<&str>,
) -> Result<(), String> {
    let kind = kind.map(validate_kind).transpose()?;
    let changed = conn
        .execute(
            "UPDATE albums SET visualizer = ?2 WHERE id = ?1",
            params![album_id, kind],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("album not found".to_string());
    }
    Ok(())
}

/// Sets (upsert) or clears (`None`) one track's default, stamped `now`. Errors when the kind is
/// invalid or, on a set, the track does not exist.
pub fn set_track_visualizer(
    conn: &Connection,
    track_id: i64,
    kind: Option<&str>,
    now: i64,
) -> Result<(), String> {
    match kind.map(validate_kind).transpose()? {
        Some(kind) => conn
            .execute(
                "INSERT INTO track_visualizers (track_id, kind, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(track_id) DO UPDATE SET
                    kind = excluded.kind,
                    updated_at = excluded.updated_at",
                params![track_id, kind, now],
            )
            .map(|_| ())
            .map_err(|e| e.to_string()),
        None => conn
            .execute(
                "DELETE FROM track_visualizers WHERE track_id = ?1",
                params![track_id],
            )
            .map(|_| ())
            .map_err(|e| e.to_string()),
    }
}

/// The kind as stored: trimmed-non-empty and within the byte cap, otherwise an error. The string is
/// returned unchanged.
fn validate_kind(kind: &str) -> Result<&str, String> {
    if kind.trim().is_empty() {
        return Err("visualizer kind is empty".to_string());
    }
    if kind.len() > MAX_KIND_BYTES {
        return Err("visualizer kind is too long".to_string());
    }
    Ok(kind)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    // Inserts a track and returns its id.
    fn insert_track(conn: &Connection, path: &str) -> i64 {
        conn.execute(
            "INSERT INTO tracks (source_path, filename, ext, size_bytes, mtime, has_embedded_cover, scanned_at)
             VALUES (?1, 'song.mp3', 'mp3', 10, 20, 0, 30)",
            params![path],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    // Inserts an album and returns its id.
    fn insert_album(conn: &Connection) -> i64 {
        conn.execute(
            "INSERT INTO albums (title, created_at, updated_at) VALUES ('A', 1, 1)",
            [],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    #[test]
    fn album_default_sets_replaces_and_clears() {
        let conn = db::open_in_memory().unwrap();
        let album = insert_album(&conn);

        set_album_visualizer(&conn, album, Some("ridge")).unwrap();
        let listed = list_visualizer_defaults(&conn).unwrap();
        assert_eq!(listed.albums.len(), 1);
        assert_eq!(listed.albums[0].kind, "ridge");

        set_album_visualizer(&conn, album, Some("glass")).unwrap();
        assert_eq!(
            list_visualizer_defaults(&conn).unwrap().albums[0].kind,
            "glass"
        );

        set_album_visualizer(&conn, album, None).unwrap();
        assert!(list_visualizer_defaults(&conn).unwrap().albums.is_empty());
    }

    #[test]
    fn track_default_sets_replaces_and_clears() {
        let conn = db::open_in_memory().unwrap();
        let track = insert_track(&conn, "/music/a.mp3");

        set_track_visualizer(&conn, track, Some("ridge"), 100).unwrap();
        set_track_visualizer(&conn, track, Some("glass"), 200).unwrap();
        let listed = list_visualizer_defaults(&conn).unwrap();
        assert_eq!(listed.tracks.len(), 1, "a replace keeps one row per track");
        assert_eq!(listed.tracks[0].kind, "glass");
        let stamp: i64 = conn
            .query_row("SELECT updated_at FROM track_visualizers", [], |r| r.get(0))
            .unwrap();
        assert_eq!(stamp, 200, "a replace refreshes the stamp");

        set_track_visualizer(&conn, track, None, 300).unwrap();
        assert!(list_visualizer_defaults(&conn).unwrap().tracks.is_empty());
        set_track_visualizer(&conn, track, None, 300).unwrap();
    }

    #[test]
    fn deleting_a_track_cascades_its_default() {
        let conn = db::open_in_memory().unwrap();
        let track = insert_track(&conn, "/music/a.mp3");
        set_track_visualizer(&conn, track, Some("ridge"), 100).unwrap();

        conn.execute("DELETE FROM tracks WHERE id = ?1", params![track])
            .unwrap();

        assert!(list_visualizer_defaults(&conn).unwrap().tracks.is_empty());
    }

    #[test]
    fn an_unknown_kind_round_trips_verbatim() {
        let conn = db::open_in_memory().unwrap();
        let album = insert_album(&conn);
        let track = insert_track(&conn, "/music/a.mp3");
        let odd = " Not-A-Kind_9 ";

        set_album_visualizer(&conn, album, Some(odd)).unwrap();
        set_track_visualizer(&conn, track, Some(odd), 1).unwrap();

        let listed = list_visualizer_defaults(&conn).unwrap();
        assert_eq!(listed.albums[0].kind, odd);
        assert_eq!(listed.tracks[0].kind, odd);
    }

    #[test]
    fn empty_whitespace_and_overlong_kinds_are_rejected() {
        let conn = db::open_in_memory().unwrap();
        let album = insert_album(&conn);
        let track = insert_track(&conn, "/music/a.mp3");
        let overlong = "x".repeat(MAX_KIND_BYTES + 1);

        for bad in ["", "   ", "\t\n", overlong.as_str()] {
            assert!(set_album_visualizer(&conn, album, Some(bad)).is_err());
            assert!(set_track_visualizer(&conn, track, Some(bad), 1).is_err());
        }
        let listed = list_visualizer_defaults(&conn).unwrap();
        assert!(listed.albums.is_empty() && listed.tracks.is_empty());

        let at_cap = "x".repeat(MAX_KIND_BYTES);
        set_album_visualizer(&conn, album, Some(&at_cap)).unwrap();
    }

    #[test]
    fn a_missing_album_errors() {
        let conn = db::open_in_memory().unwrap();
        assert!(set_album_visualizer(&conn, 999, Some("ridge")).is_err());
        assert!(set_album_visualizer(&conn, 999, None).is_err());
    }

    #[test]
    fn a_missing_track_errors_on_set() {
        let conn = db::open_in_memory().unwrap();
        assert!(set_track_visualizer(&conn, 999, Some("ridge"), 1).is_err());
    }
}
