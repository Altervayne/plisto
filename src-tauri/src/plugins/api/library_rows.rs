/*
 * The rows the `library.*` methods return and the SQL that reads them. Every value is resolved the
 * way Plisto shows it: edits over raw tags, and a filed track's album fields over its own through
 * `resolve.rs`. Tracks missing on disk never appear, nor count in an album or playlist. No
 * row carries a path, a filename or a root: a plugin sees ids and tags only.
 */

// -- Library Imports --
use std::collections::{HashMap, HashSet};

use rusqlite::types::Value as SqlValue;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::Serialize;

// -- Local Imports --
use super::cursor::{after_clause, finish_page, key_from, order_clause, Cursor, PageArgs};
pub use crate::db::ALBUM_MEMBER_KEY;
use crate::db::SINGLE_KIND;
use crate::resolve::{
    effective_album_fields, effective_artist, effective_title, AlbumFields, Filing,
};

/// One library track as a plugin sees it.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PluginTrack {
    pub id: i64,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub year: Option<i64>,
    pub track_no: Option<i64>,
    pub disc_no: Option<i64>,
    pub duration_secs: Option<f64>,
    /// The track's genres in display order.
    pub genres: Vec<String>,
    /// The album or single the track is filed into.
    pub album_id: Option<i64>,
}

/// One album or single.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PluginAlbum {
    pub id: i64,
    /// `"album"` or `"single"`.
    pub kind: String,
    pub title: Option<String>,
    pub album_artist: Option<String>,
    pub year: Option<i64>,
    /// Members present on disk.
    pub track_count: i64,
}

/// One playlist.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PluginPlaylist {
    pub id: i64,
    pub name: Option<String>,
    pub description: Option<String>,
    /// Slots whose track is present on disk; a track listed twice counts twice.
    pub track_count: i64,
}

/// Where a track page draws its rows from: the whole library, one album, or one playlist.
pub enum TrackSource {
    All,
    Album(i64),
    Playlist(i64),
}

// The track projection, in `track_from_row` order. Disc follows the edit over the raw tag; the track
// number is the album position for a member and the raw tag for a loose track.
const TRACK_COLUMNS: &str = "t.id, te.title, t.raw_title, te.artist, t.raw_artist, \
     te.album, t.raw_album, te.album_artist, t.raw_album_artist, te.year, t.raw_year, \
     at.album_id, a.kind, a.title, a.album_artist, a.year, \
     COALESCE(at.track_no, t.raw_track_no), COALESCE(te.disc_no, t.raw_disc_no), t.duration_secs";
const TRACK_COLUMN_COUNT: usize = 19;
const TRACK_JOINS: &str = "LEFT JOIN track_edits te ON te.track_id = t.id \
     LEFT JOIN album_tracks at ON at.track_id = t.id \
     LEFT JOIN albums a ON a.id = at.album_id";
const PRESENT: &str = "t.missing_at IS NULL";

const ALBUM_COLUMNS: &str = "a.id, a.kind, a.title, a.album_artist, a.year, \
     (SELECT COUNT(*) FROM album_tracks m JOIN tracks mt ON mt.id = m.track_id \
      WHERE m.album_id = a.id AND mt.missing_at IS NULL)";
const ALBUM_COLUMN_COUNT: usize = 6;

const PLAYLIST_COLUMNS: &str = "p.id, p.name, p.description, \
     (SELECT COUNT(*) FROM playlist_tracks s JOIN tracks st ON st.id = s.track_id \
      WHERE s.playlist_id = p.id AND st.missing_at IS NULL)";
const PLAYLIST_COLUMN_COUNT: usize = 4;

fn track_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<PluginTrack> {
    let edit = AlbumFields {
        album: r.get(5)?,
        album_artist: r.get(7)?,
        year: r.get(9)?,
    };
    let raw = AlbumFields {
        album: r.get(6)?,
        album_artist: r.get(8)?,
        year: r.get(10)?,
    };
    let album_id: Option<i64> = r.get(11)?;
    let kind: Option<String> = r.get(12)?;
    let container = AlbumFields {
        album: r.get(13)?,
        album_artist: r.get(14)?,
        year: r.get(15)?,
    };
    let filing = match (album_id, kind.as_deref()) {
        (None, _) => Filing::Loose,
        (Some(_), Some(SINGLE_KIND)) => Filing::Single(&container),
        (Some(_), _) => Filing::Album(&container),
    };
    let fields = effective_album_fields(&edit, &raw, filing);
    Ok(PluginTrack {
        id: r.get(0)?,
        title: effective_title(&r.get(2)?, &r.get(1)?),
        artist: effective_artist(&r.get(4)?, &r.get(3)?),
        album: fields.album,
        album_artist: fields.album_artist,
        year: fields.year,
        track_no: r.get(16)?,
        disc_no: r.get(17)?,
        duration_secs: r.get(18)?,
        genres: Vec::new(),
        album_id,
    })
}

fn album_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<PluginAlbum> {
    Ok(PluginAlbum {
        id: r.get(0)?,
        kind: r.get(1)?,
        title: r.get(2)?,
        album_artist: r.get(3)?,
        year: r.get(4)?,
        track_count: r.get(5)?,
    })
}

fn playlist_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<PluginPlaylist> {
    Ok(PluginPlaylist {
        id: r.get(0)?,
        name: r.get(1)?,
        description: r.get(2)?,
        track_count: r.get(3)?,
    })
}

fn placeholders(count: usize) -> String {
    vec!["?"; count].join(", ")
}

/// Fills each track's genres, in position order.
fn attach_genres(conn: &Connection, tracks: &mut [PluginTrack]) -> rusqlite::Result<()> {
    let ids: Vec<i64> = tracks
        .iter()
        .map(|t| t.id)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    if ids.is_empty() {
        return Ok(());
    }
    let sql = format!(
        "SELECT tg.track_id, g.name FROM track_genres tg JOIN genres g ON g.id = tg.genre_id \
         WHERE tg.track_id IN ({}) ORDER BY tg.track_id, tg.position",
        placeholders(ids.len())
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut by_track: HashMap<i64, Vec<String>> = HashMap::new();
    for row in stmt.query_map(params_from_iter(ids.iter()), |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
    })? {
        let (id, name) = row?;
        by_track.entry(id).or_default().push(name);
    }
    for track in tracks {
        if let Some(genres) = by_track.get(&track.id) {
            track.genres = genres.clone();
        }
    }
    Ok(())
}

/// One page of present tracks from `source`, in the page's sort.
pub fn track_page(
    conn: &Connection,
    source: &TrackSource,
    page: &PageArgs,
) -> rusqlite::Result<(Vec<PluginTrack>, Option<String>)> {
    let (from, filter, mut values) = match source {
        TrackSource::All => ("tracks t", String::new(), Vec::new()),
        TrackSource::Album(id) => (
            "tracks t",
            " AND at.album_id = ?".to_string(),
            vec![SqlValue::Integer(*id)],
        ),
        TrackSource::Playlist(id) => (
            "playlist_tracks pt JOIN tracks t ON t.id = pt.track_id",
            " AND pt.playlist_id = ?".to_string(),
            vec![SqlValue::Integer(*id)],
        ),
    };
    let sort = &page.sort;
    let (after, after_values) = after_clause(sort, page.after.as_ref());
    values.extend(after_values);
    let key_column = if sort.key_sql.is_empty() {
        "NULL"
    } else {
        sort.key_sql
    };
    let sql = format!(
        "SELECT {TRACK_COLUMNS}, {key_column}, {id} FROM {from} {TRACK_JOINS} \
         WHERE {PRESENT}{filter}{after}{order}",
        id = sort.id_sql,
        order = order_clause(page),
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(params_from_iter(values.iter()), |r| {
            let cursor = Cursor {
                key: key_from(sort, r, TRACK_COLUMN_COUNT)?,
                id: r.get(TRACK_COLUMN_COUNT + 1)?,
            };
            Ok((track_from_row(r)?, cursor))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let (mut tracks, next) = finish_page(page, rows);
    attach_genres(conn, &mut tracks)?;
    Ok((tracks, next))
}

/// The present tracks among `ids`, in the order asked; an id that is unknown or gone is left out.
pub fn tracks_by_id(conn: &Connection, ids: &[i64]) -> rusqlite::Result<Vec<PluginTrack>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        "SELECT {TRACK_COLUMNS} FROM tracks t {TRACK_JOINS} WHERE {PRESENT} AND t.id IN ({})",
        placeholders(ids.len())
    );
    let mut stmt = conn.prepare(&sql)?;
    let found: HashMap<i64, PluginTrack> = stmt
        .query_map(params_from_iter(ids.iter()), track_from_row)?
        .map(|row| row.map(|t| (t.id, t)))
        .collect::<rusqlite::Result<_>>()?;
    let mut tracks: Vec<PluginTrack> = ids.iter().filter_map(|id| found.get(id).cloned()).collect();
    attach_genres(conn, &mut tracks)?;
    Ok(tracks)
}

/// One page of albums, optionally of one kind.
pub fn album_page(
    conn: &Connection,
    kind: Option<&str>,
    page: &PageArgs,
) -> rusqlite::Result<(Vec<PluginAlbum>, Option<String>)> {
    let sort = &page.sort;
    let mut values = Vec::new();
    let mut filter = String::new();
    if let Some(kind) = kind {
        filter.push_str(" AND a.kind = ?");
        values.push(SqlValue::Text(kind.to_string()));
    }
    let (after, after_values) = after_clause(sort, page.after.as_ref());
    values.extend(after_values);
    let key_column = if sort.key_sql.is_empty() {
        "NULL"
    } else {
        sort.key_sql
    };
    let sql = format!(
        "SELECT {ALBUM_COLUMNS}, {key_column}, {id} FROM albums a WHERE 1 = 1{filter}{after}{order}",
        id = sort.id_sql,
        order = order_clause(page),
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(params_from_iter(values.iter()), |r| {
            let cursor = Cursor {
                key: key_from(sort, r, ALBUM_COLUMN_COUNT)?,
                id: r.get(ALBUM_COLUMN_COUNT + 1)?,
            };
            Ok((album_from_row(r)?, cursor))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(finish_page(page, rows))
}

pub fn album(conn: &Connection, id: i64) -> rusqlite::Result<Option<PluginAlbum>> {
    let sql = format!("SELECT {ALBUM_COLUMNS} FROM albums a WHERE a.id = ?1");
    conn.query_row(&sql, params![id], album_from_row).optional()
}

/// One page of playlists.
pub fn playlist_page(
    conn: &Connection,
    page: &PageArgs,
) -> rusqlite::Result<(Vec<PluginPlaylist>, Option<String>)> {
    let sort = &page.sort;
    let (after, values) = after_clause(sort, page.after.as_ref());
    let key_column = if sort.key_sql.is_empty() {
        "NULL"
    } else {
        sort.key_sql
    };
    let sql = format!(
        "SELECT {PLAYLIST_COLUMNS}, {key_column}, {id} FROM playlists p WHERE 1 = 1{after}{order}",
        id = sort.id_sql,
        order = order_clause(page),
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(params_from_iter(values.iter()), |r| {
            let cursor = Cursor {
                key: key_from(sort, r, PLAYLIST_COLUMN_COUNT)?,
                id: r.get(PLAYLIST_COLUMN_COUNT + 1)?,
            };
            Ok((playlist_from_row(r)?, cursor))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(finish_page(page, rows))
}

pub fn playlist(conn: &Connection, id: i64) -> rusqlite::Result<Option<PluginPlaylist>> {
    let sql = format!("SELECT {PLAYLIST_COLUMNS} FROM playlists p WHERE p.id = ?1");
    conn.query_row(&sql, params![id], playlist_from_row)
        .optional()
}

fn ids_of(conn: &Connection, sql: &str, id: i64) -> rusqlite::Result<Vec<i64>> {
    let mut stmt = conn.prepare(sql)?;
    let ids = stmt
        .query_map(params![id], |r| r.get(0))?
        .collect::<rusqlite::Result<Vec<i64>>>()?;
    Ok(ids)
}

/// The present member tracks of an album in album order, or None when there is no such album.
pub fn album_track_ids(conn: &Connection, id: i64) -> rusqlite::Result<Option<Vec<i64>>> {
    if album(conn, id)?.is_none() {
        return Ok(None);
    }
    let sql = format!(
        "SELECT t.id FROM album_tracks at JOIN tracks t ON t.id = at.track_id \
         LEFT JOIN track_edits te ON te.track_id = t.id \
         WHERE at.album_id = ?1 AND {PRESENT} ORDER BY {ALBUM_MEMBER_KEY}, t.id"
    );
    ids_of(conn, &sql, id).map(Some)
}

/// The present tracks of a playlist in slot order, a track listed twice appearing twice, or None
/// when there is no such playlist.
pub fn playlist_track_ids(conn: &Connection, id: i64) -> rusqlite::Result<Option<Vec<i64>>> {
    if playlist(conn, id)?.is_none() {
        return Ok(None);
    }
    let sql = format!(
        "SELECT t.id FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id \
         WHERE pt.playlist_id = ?1 AND {PRESENT} ORDER BY pt.position, pt.id"
    );
    ids_of(conn, &sql, id).map(Some)
}

/// Which of `ids` are present library tracks.
pub fn present_ids(conn: &Connection, ids: &[i64]) -> rusqlite::Result<HashSet<i64>> {
    if ids.is_empty() {
        return Ok(HashSet::new());
    }
    let sql = format!(
        "SELECT t.id FROM tracks t WHERE {PRESENT} AND t.id IN ({})",
        placeholders(ids.len())
    );
    let mut stmt = conn.prepare(&sql)?;
    let found = stmt
        .query_map(params_from_iter(ids.iter()), |r| r.get(0))?
        .collect::<rusqlite::Result<HashSet<i64>>>()?;
    Ok(found)
}

/// Whether a present track keeps its own cover inside its album; None when the track is unknown or
/// gone.
pub fn track_keeps_own_cover(conn: &Connection, id: i64) -> rusqlite::Result<Option<bool>> {
    let sql = format!(
        "SELECT COALESCE(at.keep_own_cover, 0) FROM tracks t \
         LEFT JOIN album_tracks at ON at.track_id = t.id WHERE t.id = ?1 AND {PRESENT}"
    );
    conn.query_row(&sql, params![id], |r| r.get(0)).optional()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::export::plan::build_plan;
    use crate::export::track_tags;
    use crate::plugins::api::test_rig::insert_track;

    fn edit(
        conn: &Connection,
        id: i64,
        album: Option<&str>,
        artist: Option<&str>,
        year: Option<i64>,
    ) {
        let text = |v: Option<&str>| v.map(str::to_string);
        db::set_track_edit(conn, id, None, None, text(album), text(artist), year, None).unwrap();
    }

    /// Album members (plain, stale edits on every album field, a stale year edit), an album with no
    /// fields, and two singles (plain, edited). Returns the track ids in that order.
    fn filed_library(conn: &mut Connection) -> Vec<i64> {
        let ids: Vec<i64> = (0..6)
            .map(|i| insert_track(conn, &format!("/m/{i}.flac"), "T", "A"))
            .collect();
        db::create_album(
            conn,
            Some("Record".into()),
            Some("Band".into()),
            Some(2001),
            None,
            None,
            &ids[0..3],
            "album",
            1,
        )
        .unwrap();
        edit(conn, ids[1], Some("Stale"), Some("Guest"), Some(1999));
        edit(conn, ids[2], None, None, Some(2003));
        db::create_album(conn, None, None, None, None, None, &ids[3..4], "album", 1).unwrap();
        db::create_single(conn, ids[4], 1).unwrap();
        db::create_single(conn, ids[5], 1).unwrap();
        edit(conn, ids[5], Some("Own Name"), None, Some(2010));
        ids
    }

    fn resolved(conn: &Connection, ids: &[i64]) -> HashMap<i64, PluginTrack> {
        tracks_by_id(conn, ids)
            .unwrap()
            .into_iter()
            .map(|t| (t.id, t))
            .collect()
    }

    /// Parity with the tags export writes, including album members that carry stale per-track edits.
    #[test]
    fn the_album_fields_match_what_export_writes() {
        let mut conn = db::open_in_memory().unwrap();
        let ids = filed_library(&mut conn);
        let plan = build_plan(&conn).unwrap();
        let mine = resolved(&conn, &ids);
        let mut checked = 0;
        for container in &plan.containers {
            for track in &container.tracks {
                let id = track.track_id;
                let tags = track_tags(container, track);
                let got = &mine[&id];
                assert_eq!(got.album.as_deref(), tags.album, "{id}");
                assert_eq!(got.title.as_deref(), tags.title, "{id}");
                assert_eq!(got.artist.as_deref(), tags.artist, "{id}");
                assert_eq!(got.track_no, tags.track_no, "{id}");
                assert_eq!(got.disc_no, tags.disc_no, "{id}");
                assert_eq!(got.album_artist.as_deref(), tags.album_artist, "{id}");
                assert_eq!(got.year, tags.year, "{id}");
                checked += 1;
            }
        }
        assert_eq!(checked, ids.len());
        assert_eq!(mine[&ids[5]].album.as_deref(), Some("Own Name"));
        assert_eq!(mine[&ids[5]].year, Some(2010));
    }

    /// An album member with stale album artist or year edits shows, and exports, the album's.
    #[test]
    fn an_album_member_shows_and_exports_the_album_not_a_stale_edit() {
        let mut conn = db::open_in_memory().unwrap();
        let ids = filed_library(&mut conn);
        let plan = build_plan(&conn).unwrap();
        let mine = resolved(&conn, &ids);
        let export = |id: i64| {
            plan.containers
                .iter()
                .flat_map(|c| c.tracks.iter().map(move |t| (c, t)))
                .find(|(_, t)| t.track_id == id)
                .map(|(c, t)| {
                    let tags = track_tags(c, t);
                    (tags.album_artist.map(str::to_string), tags.year)
                })
                .unwrap()
        };
        for id in [ids[1], ids[2]] {
            assert_eq!(export(id), (Some("Band".to_string()), Some(2001)));
            assert_eq!(mine[&id].album.as_deref(), Some("Record"));
            assert_eq!(mine[&id].album_artist.as_deref(), Some("Band"));
            assert_eq!(mine[&id].year, Some(2001));
        }
    }
}
