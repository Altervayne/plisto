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
use std::collections::{HashMap, HashSet};

use rusqlite::Connection;

// -- Local Imports --
use crate::db::{self, ExportTrackRow, PlaylistExportRow};
use crate::resolve::{effective_artist, effective_title};

// The synthetic album id the Unsorted container carries. Real album ids start at 1, so 0 never
// clashes with one; the container's own folder name is distinct anyway, so dedupe never leans on it.
const UNSORTED_ALBUM_ID: i64 = 0;

/// A container's bucket: a plain album folder, a single's own subfolder under `/Singles`, or the
/// playlist Unsorted bag that gathers a playlist's loose slots into one flat folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContainerKind {
    Album,
    Single,
    Unsorted,
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
    // When set, the writer embeds this track's own embedded/adjacent art instead of the container
    // cover, falling back to the container cover when the track has none.
    pub keep_own_cover: bool,
    // The cover the user assigned to this track, resolved to its stored blob at plan-build time. Top
    // priority for the embed: a `Store` here wins over keep-own art and the container cover. `None`
    // when the track carries no assigned cover or its blob could not be keyed.
    pub own_cover: CoverPlan,
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
                keep_own_cover: row.keep_own_cover,
                own_cover: store_cover(conn, row.own_cover_id)?,
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
    if let plan @ CoverPlan::Store { .. } = store_cover(conn, cover_id)? {
        return Ok(plan);
    }
    if let Some(first) = tracks.first() {
        return Ok(CoverPlan::Member {
            source: first.source.clone(),
            has_embedded: first.has_embedded,
        });
    }
    Ok(CoverPlan::None)
}

/// Resolves an imported cover id to its full-res store blob key, or `None` when it is unset or the
/// manifest has no blob key for it. The one DB read a per-track assigned cover needs, so the worker
/// reads its bytes off the lock the same way a container's imported cover does.
fn store_cover(conn: &Connection, cover_id: Option<i64>) -> rusqlite::Result<CoverPlan> {
    if let Some(cover_id) = cover_id {
        if let Some((content_hash, byte_len)) = db::get_cover_blob_key(conn, cover_id)? {
            return Ok(CoverPlan::Store {
                content_hash,
                byte_len,
            });
        }
    }
    Ok(CoverPlan::None)
}

/// Snapshots one playlist into the library ExportPlan shape, so the structured folder export drives
/// the same run_export the library does. Each album or single the playlist touches becomes a
/// container holding only that playlist's members, retagged and covered exactly as build_plan
/// resolves them; every loose slot - in no album - falls into one synthetic Unsorted container with
/// a flat `Artist - Title` layout. A slot the playlist holds twice contributes one copy: the folder
/// is a set of files, and the bundled m3u references each by track id. The only DB touch after this
/// returns is none: the worker owns the plan.
pub fn playlist_folder_plan(conn: &Connection, playlist_id: i64) -> rusqlite::Result<ExportPlan> {
    let slots = db::load_playlist_export_tracks(conn, playlist_id)?;

    // The album and single containers come from the library plan, kept to the playlist's own members.
    // Membership by track id folds a slot the playlist holds twice down to the one copy on disk.
    let members: HashSet<i64> = slots
        .iter()
        .filter(|s| s.in_album)
        .map(|s| s.track_id)
        .collect();

    let mut containers: Vec<ExportContainer> = build_plan(conn)?
        .containers
        .into_iter()
        .filter_map(|mut c| {
            c.tracks.retain(|t| members.contains(&t.track_id));
            c.skipped.retain(|id| members.contains(id));
            (!c.tracks.is_empty() || !c.skipped.is_empty()).then_some(c)
        })
        .collect();

    if let Some(unsorted) = unsorted_container(conn, &slots)? {
        containers.push(unsorted);
    }

    Ok(ExportPlan { containers })
}

/// Gathers a playlist's loose slots - the ones in no album - into one Unsorted container, deduped to
/// one copy each in first-seen play order. The container carries no release identity of its own, so
/// each track's resolved album/album_artist/year ride along as its per-track override: the retag
/// reads `override ?? container`, and with a null container that lands the track's own resolved value,
/// so a loose track keeps its release tags. Numbering is dropped (a loose track has no album track
/// number) and the container is art-less, since unrelated loose tracks share no cover. None when the
/// playlist has no loose slots. Genres reuse the library-wide loader, in position order.
fn unsorted_container(
    conn: &Connection,
    slots: &[PlaylistExportRow],
) -> rusqlite::Result<Option<ExportContainer>> {
    let mut genres_by_track: HashMap<i64, Vec<String>> = HashMap::new();
    for (track_id, name) in db::load_export_track_genres(conn)? {
        genres_by_track.entry(track_id).or_default().push(name);
    }

    let mut tracks = Vec::new();
    let mut skipped = Vec::new();
    let mut seen: HashSet<i64> = HashSet::new();
    for slot in slots.iter().filter(|s| !s.in_album) {
        if !seen.insert(slot.track_id) {
            continue;
        }
        if slot.missing_at.is_some() {
            skipped.push(slot.track_id);
            continue;
        }
        // Open the file by its real-case path; the folded key stands in only for a legacy row.
        let source = slot
            .display_path
            .clone()
            .unwrap_or_else(|| slot.source_path.clone());
        tracks.push(ExportTrack {
            track_id: slot.track_id,
            source,
            ext: slot.ext.clone(),
            title: effective_title(&slot.raw_title, &slot.title_override),
            artist: effective_artist(&slot.raw_artist, &slot.artist_override),
            album_override: slot.album_override.clone().or_else(|| slot.raw_album.clone()),
            album_artist_override: slot
                .album_artist_override
                .clone()
                .or_else(|| slot.raw_album_artist.clone()),
            year_override: slot.year_override.or(slot.raw_year),
            genres: genres_by_track.remove(&slot.track_id).unwrap_or_default(),
            track_no: None,
            disc_no: None,
            has_embedded: slot.has_embedded,
            // The Unsorted bag is already art-less and its loose tracks carry their own cover, so the
            // album-scoped flag has no bearing here.
            keep_own_cover: false,
            // A loose track exports its own embedded/adjacent art directly, so no assigned-cover
            // override rides along the bag.
            own_cover: CoverPlan::None,
        });
    }

    if tracks.is_empty() && skipped.is_empty() {
        return Ok(None);
    }
    Ok(Some(ExportContainer {
        album_id: UNSORTED_ALBUM_ID,
        kind: ContainerKind::Unsorted,
        album_artist: None,
        title: None,
        year: None,
        cover: CoverPlan::None,
        tracks,
        skipped,
    }))
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
        let album = db::create_album(
            &mut conn,
            Some("Rec".into()),
            Some("AA".into()),
            Some(2020),
            None,
            None,
            &[a, b],
            "album",
            1,
        )
        .unwrap();
        let single = db::create_single(&mut conn, s, 1).unwrap();

        let plan = build_plan(&conn).unwrap();
        assert_eq!(plan.containers.len(), 2);

        let album_c = plan
            .containers
            .iter()
            .find(|c| c.album_id == album.id)
            .unwrap();
        assert_eq!(album_c.kind, ContainerKind::Album);
        assert_eq!(album_c.title.as_deref(), Some("Rec"));
        assert_eq!(album_c.album_artist.as_deref(), Some("AA"));
        assert_eq!(album_c.year, Some(2020));
        assert_eq!(album_c.tracks.len(), 2);
        assert_eq!(album_c.tracks[0].title.as_deref(), Some("One"));
        assert_eq!(album_c.tracks[0].track_no, Some(1));

        let single_c = plan
            .containers
            .iter()
            .find(|c| c.album_id == single.id)
            .unwrap();
        assert_eq!(single_c.kind, ContainerKind::Single);
        assert_eq!(single_c.tracks.len(), 1);
        assert_eq!(single_c.tracks[0].title.as_deref(), Some("Hit"));
    }

    #[test]
    fn override_beats_raw_in_the_plan() {
        let mut conn = db::open_in_memory().unwrap();
        let t = insert_track(&conn, "/m/album/1.mp3", "Raw Title");
        let album =
            db::create_album(&mut conn, None, None, None, None, None, &[t], "album", 1).unwrap();
        db::set_track_overrides(
            &conn,
            album.id,
            t,
            Some("Edited".into()),
            Some("Edited Artist".into()),
            Some(3),
            None,
        )
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
        conn.execute(
            "UPDATE tracks SET missing_at = 99 WHERE id = ?1",
            rusqlite::params![b],
        )
        .unwrap();
        db::create_album(&mut conn, None, None, None, None, None, &[a, b], "album", 1).unwrap();

        let plan = build_plan(&conn).unwrap();
        let c = &plan.containers[0];
        assert_eq!(c.tracks.len(), 1, "only the present track is staged");
        assert_eq!(c.tracks[0].track_id, a);
        assert_eq!(
            c.skipped,
            vec![b],
            "the missing track is recorded as a skip"
        );
    }

    #[test]
    fn playlist_folder_plan_groups_members_and_gathers_loose_tracks() {
        use crate::export::derive::{derive_layout, AlbumTemplate};

        let mut conn = db::open_in_memory().unwrap();
        let a = insert_track(&conn, "/m/album/1.mp3", "One");
        let b = insert_track(&conn, "/m/album/2.mp3", "Two");
        let s = insert_track(&conn, "/m/loose/hit.mp3", "Hit");
        let loose = insert_track(&conn, "/m/loose/free.mp3", "Free");
        db::create_album(
            &mut conn,
            Some("Rec".into()),
            Some("AA".into()),
            Some(2020),
            None,
            None,
            &[a, b],
            "album",
            1,
        )
        .unwrap();
        db::create_single(&mut conn, s, 1).unwrap();

        let pl = db::create_playlist(&conn, Some("Mix".into()), 100).unwrap();
        // A subset: album member a (never b), the single, the loose track, and a a second time.
        db::add_tracks_to_playlist(&mut conn, pl.id, &[a, s, loose, a], 100).unwrap();

        let plan = playlist_folder_plan(&conn, pl.id).unwrap();
        let layout = derive_layout(&plan.containers, 0, &AlbumTemplate::resolve("", ""));

        // A track's relative exported path across the containers, keyed by track id.
        let path_of = |track_id: i64| -> Option<String> {
            plan.containers.iter().zip(&layout).find_map(|(_, l)| {
                l.tracks.iter().find(|t| t.track_id == track_id).map(|t| {
                    let rel = l.rel_dir.to_string_lossy().replace('\\', "/");
                    if rel.is_empty() {
                        t.filename.clone()
                    } else {
                        format!("{rel}/{}", t.filename)
                    }
                })
            })
        };

        // A member lands in Artist/Album; a single in its Singles subfolder; a loose track flat in
        // Unsorted. The non-member album track b is never exported.
        assert_eq!(path_of(a).as_deref(), Some("AA/Rec/01 - One.mp3"));
        assert_eq!(path_of(b), None, "a non-member album track is left out");
        assert_eq!(
            path_of(s).as_deref(),
            Some("Singles/Raw Artist - Hit/Raw Artist - Hit.mp3")
        );
        assert_eq!(path_of(loose).as_deref(), Some("Unsorted/Raw Artist - Free.mp3"));

        // The duplicate slot folds to the one copy on disk.
        let copies = plan
            .containers
            .iter()
            .flat_map(|c| &c.tracks)
            .filter(|t| t.track_id == a)
            .count();
        assert_eq!(copies, 1, "a slot held twice is one file");
    }

    #[test]
    fn cover_falls_back_to_a_member_when_none_is_bound() {
        let mut conn = db::open_in_memory().unwrap();
        let t = insert_track(&conn, "/m/album/1.mp3", "One");
        db::create_album(&mut conn, None, None, None, None, None, &[t], "album", 1).unwrap();

        let plan = build_plan(&conn).unwrap();
        match &plan.containers[0].cover {
            CoverPlan::Member {
                source,
                has_embedded,
            } => {
                assert_eq!(source, "/m/album/1.mp3");
                assert!(*has_embedded);
            }
            other => panic!("expected a member cover fallback, got {other:?}"),
        }
    }

    #[test]
    fn own_cover_resolves_to_its_stored_blob() {
        let mut conn = db::open_in_memory().unwrap();
        let t = insert_track(&conn, "/m/album/1.mp3", "One");
        db::create_album(&mut conn, None, None, None, None, None, &[t], "album", 1).unwrap();

        // Assign a cover to the track; the manifest carries its store key even without a blob file.
        let record = crate::model::CoverRecord {
            content_hash: "feedface".into(),
            source_kind: "imported".into(),
            origin_path: None,
            width: 10,
            height: 10,
            byte_len: 42,
            created_at: 1,
        };
        let cover_id = db::upsert_cover(&conn, &record).unwrap();
        db::set_track_cover(&mut conn, &[t], cover_id, 1).unwrap();

        let plan = build_plan(&conn).unwrap();
        let track = &plan.containers[0].tracks[0];
        match &track.own_cover {
            CoverPlan::Store {
                content_hash,
                byte_len,
            } => {
                assert_eq!(content_hash, "feedface");
                assert_eq!(*byte_len, 42);
            }
            other => panic!("expected the assigned cover to resolve to its store blob, got {other:?}"),
        }
    }
}
