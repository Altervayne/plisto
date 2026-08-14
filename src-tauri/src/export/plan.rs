/*
 * The export snapshot: a purpose-built read that turns the organize model into an owned plan the
 * worker copies from without ever touching the DB again. Built under a brief lock in the command,
 * then moved into the blocking worker. Every editable value is resolved here through resolve.rs -
 * the same override ?? raw the read path uses - so the exported tags match what the user sees.
 * Missing-source tracks are recorded as skips, never mutated. A container's full-res cover is
 * resolved to a plan the worker reads bytes from off the lock: an imported blob by hash, or a
 * member track's own embedded/adjacent art.
 */

// -- Library Imports --
use std::collections::HashMap;

use rusqlite::Connection;

// -- Local Imports --
use crate::db::{self, ExportTrackRow};
use crate::resolve::{effective_artist, effective_title};

/// A container's bucket: a plain album folder or a single's own subfolder under `/Singles`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContainerKind {
    Album,
    Single,
}

/// Where a container's full-res cover bytes come from at write time. The worker reads them off the
/// lock: `Store` is an imported blob keyed by content hash in the cover cache; `Member` re-derives
/// the lowest-numbered present track's own embedded or adjacent art; `None` leaves the container
/// art-less (no sidecar, no embed).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoverPlan {
    Store { content_hash: String, byte_len: i64 },
    Member { source: String, has_embedded: bool },
    None,
}

/// One track staged for export: the real-case source to copy, its extension, the resolved
/// title/artist to write, and its numbering. `has_embedded` feeds the member-art cover fallback.
#[derive(Debug, Clone)]
pub struct ExportTrack {
    pub track_id: i64,
    pub source: String,
    pub ext: String,
    pub title: Option<String>,
    pub artist: Option<String>,
    // Per-track album-field overrides, resolved at write time as override ?? the container's value.
    pub album_override: Option<String>,
    pub album_artist_override: Option<String>,
    pub year_override: Option<i64>,
    // The track's managed genres in position order: a filename's `{genre}` reads the first, and the
    // tag writer lays them all down as a multi-value genre.
    pub genres: Vec<String>,
    pub track_no: Option<i64>,
    pub disc_no: Option<i64>,
    pub has_embedded: bool,
}

/// One export container: an album folder or a single's subfolder, with its resolved release fields
/// (written into every member's tags), its cover plan, its present tracks in play order, and the
/// ids of members skipped because their source is gone.
#[derive(Debug, Clone)]
pub struct ExportContainer {
    pub album_id: i64,
    pub kind: ContainerKind,
    pub album_artist: Option<String>,
    pub title: Option<String>,
    pub year: Option<i64>,
    pub cover: CoverPlan,
    pub tracks: Vec<ExportTrack>,
    pub skipped: Vec<i64>,
}

/// The whole owned export snapshot: every album and single as a container.
#[derive(Debug, Clone)]
pub struct ExportPlan {
    pub containers: Vec<ExportContainer>,
}

/// Snapshots the organize model into an owned plan. Reads every album (both kinds) and their
/// membership, resolves each track's effective title/artist, drops missing-source tracks into the
/// container's skip list, and resolves each container's cover source. The only DB touch after this
/// returns is none: the worker owns the plan.
pub fn build_plan(conn: &Connection) -> rusqlite::Result<ExportPlan> {
    let albums = db::load_albums(conn)?;
    let rows = db::load_export_tracks(conn)?;

    // Group membership by album, preserving the query's album-then-track order.
    let mut by_album: HashMap<i64, Vec<ExportTrackRow>> = HashMap::new();
    for row in rows {
        by_album.entry(row.album_id).or_default().push(row);
    }

    // Each track's managed genres, grouped in the query's per-track position order. Read once here so
    // the worker stays DB-free; a filename's `{genre}` reads the first, the tag writer lays all down.
    let mut genres_by_track: HashMap<i64, Vec<String>> = HashMap::new();
    for (track_id, name) in db::load_export_track_genres(conn)? {
        genres_by_track.entry(track_id).or_default().push(name);
    }

    let mut containers = Vec::with_capacity(albums.len());
    for album in &albums {
        let members = by_album.remove(&album.id).unwrap_or_default();

        let mut tracks = Vec::new();
        let mut skipped = Vec::new();
        for row in &members {
            if row.missing_at.is_some() {
                skipped.push(row.track_id);
                continue;
            }
            // Open the file by its real-case path; the folded key stands in only for a legacy row
            // that never captured one.
            let source = row
                .display_path
                .clone()
                .unwrap_or_else(|| row.source_path.clone());
            tracks.push(ExportTrack {
                track_id: row.track_id,
                source,
                ext: row.ext.clone(),
                title: effective_title(&row.raw_title, &row.title_override),
                artist: effective_artist(&row.raw_artist, &row.artist_override),
                album_override: row.album_override.clone(),
                album_artist_override: row.album_artist_override.clone(),
                year_override: row.year_override,
                genres: genres_by_track.remove(&row.track_id).unwrap_or_default(),
                track_no: row.track_no,
                disc_no: row.disc_no,
                has_embedded: row.has_embedded_cover == Some(true),
            });
        }

        let cover = resolve_cover(conn, album.cover_id, &tracks)?;
        let kind = if album.kind == db::SINGLE_KIND {
            ContainerKind::Single
        } else {
            ContainerKind::Album
        };

        containers.push(ExportContainer {
            album_id: album.id,
            kind,
            album_artist: album.album_artist.clone(),
            title: album.title.clone(),
            year: album.year,
            cover,
            tracks,
            skipped,
        });
    }

    Ok(ExportPlan { containers })
}

/// Picks a container's cover source, mirroring the album-cover precedence: a bound imported cover
/// wins, resolved to its full-res blob key; otherwise the lowest-numbered present track's own art;
/// otherwise nothing. The blob key is the only DB read, so the worker reads bytes off the lock.
fn resolve_cover(
    conn: &Connection,
    cover_id: Option<i64>,
    tracks: &[ExportTrack],
) -> rusqlite::Result<CoverPlan> {
    if let Some(cover_id) = cover_id {
        if let Some((content_hash, byte_len)) = db::get_cover_blob_key(conn, cover_id)? {
            return Ok(CoverPlan::Store {
                content_hash,
                byte_len,
            });
        }
    }
    if let Some(first) = tracks.first() {
        return Ok(CoverPlan::Member {
            source: first.source.clone(),
            has_embedded: first.has_embedded,
        });
    }
    Ok(CoverPlan::None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    // Inserts a bare track row and returns its id.
    fn insert_track(conn: &Connection, source_path: &str, title: &str) -> i64 {
        conn.execute(
            "INSERT INTO tracks (source_path, display_path, filename, ext, size_bytes, mtime,
                                 raw_title, raw_artist, has_embedded_cover, scanned_at)
             VALUES (?1, ?1, 'f.mp3', 'mp3', 10, 20, ?2, 'Raw Artist', 1, 30)",
            rusqlite::params![source_path, title],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    #[test]
    fn plan_groups_albums_and_singles_with_resolved_fields() {
        let mut conn = db::open_in_memory().unwrap();
        let a = insert_track(&conn, "/m/album/1.mp3", "One");
        let b = insert_track(&conn, "/m/album/2.mp3", "Two");
        let s = insert_track(&conn, "/m/loose/hit.mp3", "Hit");
        let album =
            db::create_album(&mut conn, Some("Rec".into()), Some("AA".into()), Some(2020), None, None, &[a, b], "album", 1)
                .unwrap();
        let single = db::create_single(&mut conn, s, 1).unwrap();

        let plan = build_plan(&conn).unwrap();
        assert_eq!(plan.containers.len(), 2);

        let album_c = plan.containers.iter().find(|c| c.album_id == album.id).unwrap();
        assert_eq!(album_c.kind, ContainerKind::Album);
        assert_eq!(album_c.title.as_deref(), Some("Rec"));
        assert_eq!(album_c.album_artist.as_deref(), Some("AA"));
        assert_eq!(album_c.year, Some(2020));
        assert_eq!(album_c.tracks.len(), 2);
        assert_eq!(album_c.tracks[0].title.as_deref(), Some("One"));
        assert_eq!(album_c.tracks[0].track_no, Some(1));

        let single_c = plan.containers.iter().find(|c| c.album_id == single.id).unwrap();
        assert_eq!(single_c.kind, ContainerKind::Single);
        assert_eq!(single_c.tracks.len(), 1);
        assert_eq!(single_c.tracks[0].title.as_deref(), Some("Hit"));
    }

    #[test]
    fn override_beats_raw_in_the_plan() {
        let mut conn = db::open_in_memory().unwrap();
        let t = insert_track(&conn, "/m/album/1.mp3", "Raw Title");
        let album = db::create_album(&mut conn, None, None, None, None, None, &[t], "album", 1).unwrap();
        db::set_track_overrides(&conn, album.id, t, Some("Edited".into()), Some("Edited Artist".into()), Some(3), None)
            .unwrap();

        let plan = build_plan(&conn).unwrap();
        let track = &plan.containers[0].tracks[0];
        assert_eq!(track.title.as_deref(), Some("Edited"));
        assert_eq!(track.artist.as_deref(), Some("Edited Artist"));
        assert_eq!(track.track_no, Some(3));
    }

    #[test]
    fn missing_source_track_becomes_a_skip() {
        let mut conn = db::open_in_memory().unwrap();
        let a = insert_track(&conn, "/m/album/1.mp3", "Present");
        let b = insert_track(&conn, "/m/album/2.mp3", "Gone");
        conn.execute("UPDATE tracks SET missing_at = 99 WHERE id = ?1", rusqlite::params![b])
            .unwrap();
        db::create_album(&mut conn, None, None, None, None, None, &[a, b], "album", 1).unwrap();

        let plan = build_plan(&conn).unwrap();
        let c = &plan.containers[0];
        assert_eq!(c.tracks.len(), 1, "only the present track is staged");
        assert_eq!(c.tracks[0].track_id, a);
        assert_eq!(c.skipped, vec![b], "the missing track is recorded as a skip");
    }

    #[test]
    fn cover_falls_back_to_a_member_when_none_is_bound() {
        let mut conn = db::open_in_memory().unwrap();
        let t = insert_track(&conn, "/m/album/1.mp3", "One");
        db::create_album(&mut conn, None, None, None, None, None, &[t], "album", 1).unwrap();

        let plan = build_plan(&conn).unwrap();
        match &plan.containers[0].cover {
            CoverPlan::Member { source, has_embedded } => {
                assert_eq!(source, "/m/album/1.mp3");
                assert!(*has_embedded);
            }
            other => panic!("expected a member cover fallback, got {other:?}"),
        }
    }
}
