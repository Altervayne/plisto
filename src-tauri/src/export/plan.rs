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
use crate::dto::ExportConfig;
use crate::resolve::{effective_artist, effective_title};

// The synthetic album id the Unsorted container carries. Real album ids start at 1, so 0 never
// clashes with one; the container's own folder name is distinct anyway, so dedupe never leans on it.
const UNSORTED_ALBUM_ID: i64 = 0;

// The synthetic album id a mimic container carries, shared with the Unsorted bag: both are
// container-less of a real album, and a mimic and an Unsorted never sit in the same plan (a general
// export picks one playlist shape). Distinct playlists land in distinct buckets, so dedupe keys on
// the folder path, not this id.
const MIMIC_ALBUM_ID: i64 = 0;

// The album artist a mimic stamps on every track so a folder-scanning phone reads the playlist as
// one compilation instead of splitting it by each track's own artist.
const VARIOUS_ARTISTS: &str = "Various Artists";

// The name a mimic falls back to when its playlist is unnamed - the folder segment and the album
// title both read this, matching the default the m3u export stems land on.
const DEFAULT_PLAYLIST_NAME: &str = "Playlist";

/// A container's bucket: a plain album folder, a single's own subfolder under `/Singles`, or the
/// playlist Unsorted bag that gathers a playlist's loose slots into one flat folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContainerKind {
    Album,
    Single,
    Unsorted,
}

/// A container's top-level section. `Root` sits directly under the destination with no prefix - the
/// standalone playlist export lays its albums out this way, and a single reads its `Singles/` parent
/// from its kind, not from a bucket. `Albums` and `Playlist` are the general export's sections: album
/// containers move under `Albums/`, and a playlist's containers under `Playlists/<name>/`. The name is
/// the raw playlist name; derive.rs sanitizes it into a folder segment, keeping every path rule there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Bucket {
    Root,
    Albums,
    Playlist(String),
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
    // The top-level section this container lands in. `Root` for the standalone exports; `Albums` or
    // `Playlist` for the general export's bucketed sections.
    pub bucket: Bucket,
    // A flat container drops its own folder layout and lands its tracks straight in the bucket dir - a
    // mimic album gathers a whole playlist into one folder, named by the file pattern alone.
    pub flat: bool,
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
            bucket: Bucket::Root,
            flat: false,
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

/// Assembles the general export's plan from the config's include toggles. Album and single containers
/// come from `build_plan`, kept by kind and re-bucketed - albums move under `Albums/`, singles keep
/// their kind's own `Singles/` parent. With playlists on, each playlist appends in the chosen shape:
/// `mimic` folds the whole playlist into one flat album under `Playlists/<name>/`; `file` copies only
/// the tracks no exported album/single already holds into a bag there, leaving the portable `.m3u8`
/// (written after the copies) to reference every track relative to the export root. Rejects a config
/// that selects nothing, so an export never runs with an empty plan.
pub fn build_export_plan(conn: &Connection, config: &ExportConfig) -> Result<ExportPlan, String> {
    if !config.include_albums && !config.include_singles && !config.include_playlists {
        return Err("nothing selected to export".to_string());
    }

    let mut containers: Vec<ExportContainer> = Vec::new();

    if config.include_albums || config.include_singles {
        for mut container in build_plan(conn).map_err(|e| e.to_string())?.containers {
            match container.kind {
                ContainerKind::Album if config.include_albums => {
                    container.bucket = Bucket::Albums;
                    containers.push(container);
                }
                // A single reads its `Singles/` folder from its kind, so it needs no bucket prefix.
                ContainerKind::Single if config.include_singles => containers.push(container),
                _ => {}
            }
        }
    }

    if config.include_playlists {
        // Two shapes: `file` writes a portable .m3u8 per playlist (after the copies land) that points
        // at the copies already in Albums/Singles, copying only the tracks no exported bucket holds
        // into a bag under the playlist's own folder; anything else folds the whole playlist into one
        // flat mimic album.
        let file_shape = config.playlist_shape == "file";
        for playlist in db::load_playlists(conn).map_err(|e| e.to_string())?.playlists {
            if !file_shape {
                if let Some(container) =
                    mimic_album_container(conn, playlist.id).map_err(|e| e.to_string())?
                {
                    containers.push(container);
                }
                continue;
            }
            let name = playlist
                .name
                .clone()
                .unwrap_or_else(|| DEFAULT_PLAYLIST_NAME.to_string());
            // Bag only the orphans: a member whose album exports, or a single when singles export, is
            // already on disk and stays a pure reference; everything else - a loose track, or a member
            // whose bucket is off - copies once into the playlist's folder so the .m3u8 can name it too.
            let mut orphans: Vec<ExportTrack> = Vec::new();
            for container in playlist_folder_plan(conn, playlist.id)
                .map_err(|e| e.to_string())?
                .containers
            {
                let covered = match container.kind {
                    ContainerKind::Album => config.include_albums,
                    ContainerKind::Single => config.include_singles,
                    ContainerKind::Unsorted => false,
                };
                if !covered {
                    orphans.extend(container.tracks);
                }
            }
            if !orphans.is_empty() {
                containers.push(ExportContainer {
                    album_id: 0,
                    kind: ContainerKind::Unsorted,
                    bucket: Bucket::Playlist(name),
                    flat: false,
                    album_artist: None,
                    title: None,
                    year: None,
                    cover: CoverPlan::None,
                    tracks: orphans,
                    skipped: Vec::new(),
                });
            }
        }
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
        bucket: Bucket::Root,
        flat: false,
        album_artist: None,
        title: None,
        year: None,
        cover: CoverPlan::None,
        tracks,
        skipped,
    }))
}

/// Folds a whole playlist into one flat album container - a Mimic Album. Every slot, member or loose,
/// becomes a track of one album named after the playlist, its `album`/`album_artist` retagged (the
/// latter to `Various Artists`) so a folder-scanning phone reads the set as one compilation. Tracks
/// number sequentially in playlist order over the present ones; a doubled slot folds to its first copy.
/// The cover is the playlist's own art, or the first present member's when it carries none, mirroring
/// an album's cover precedence. None when the playlist has no slots. The only DB touch after this
/// returns is none: the worker owns the container.
pub fn mimic_album_container(
    conn: &Connection,
    playlist_id: i64,
) -> rusqlite::Result<Option<ExportContainer>> {
    let name = db::playlist_name(conn, playlist_id)?
        .unwrap_or_else(|| DEFAULT_PLAYLIST_NAME.to_string());
    let slots = db::load_playlist_export_tracks(conn, playlist_id)?;

    let mut genres_by_track: HashMap<i64, Vec<String>> = HashMap::new();
    for (track_id, genre) in db::load_export_track_genres(conn)? {
        genres_by_track.entry(track_id).or_default().push(genre);
    }

    let mut tracks = Vec::new();
    let mut skipped = Vec::new();
    let mut seen: HashSet<i64> = HashSet::new();
    // Numbering runs over the present tracks alone, in first-seen play order, so a missing or doubled
    // slot never leaves a gap or a repeat.
    let mut track_no: i64 = 0;
    for slot in &slots {
        if !seen.insert(slot.track_id) {
            continue;
        }
        if slot.missing_at.is_some() {
            skipped.push(slot.track_id);
            continue;
        }
        track_no += 1;
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
            // The retag reads `override ?? container`; stamping the override makes the mimic album's
            // identity land on every track regardless of what release it came from.
            album_override: Some(name.clone()),
            album_artist_override: Some(VARIOUS_ARTISTS.to_string()),
            year_override: None,
            genres: genres_by_track.remove(&slot.track_id).unwrap_or_default(),
            track_no: Some(track_no),
            disc_no: None,
            has_embedded: slot.has_embedded,
            keep_own_cover: false,
            own_cover: CoverPlan::None,
        });
    }

    if tracks.is_empty() && skipped.is_empty() {
        return Ok(None);
    }

    // The playlist's own cover, then the first present member's - the album precedence resolve_cover
    // already encodes, read against the playlist's cover id rather than an album's.
    let cover = resolve_cover(conn, db::get_playlist_cover_id(conn, playlist_id)?, &tracks)?;

    Ok(Some(ExportContainer {
        album_id: MIMIC_ALBUM_ID,
        kind: ContainerKind::Album,
        bucket: Bucket::Playlist(name.clone()),
        flat: true,
        album_artist: Some(VARIOUS_ARTISTS.to_string()),
        title: Some(name),
        year: None,
        cover,
        tracks,
        skipped,
    }))
}

/// The one-container plan for a standalone Mimic Album export: the mimic container re-bucketed to
/// `Root`, so its retagged copies land straight in the chosen destination - that folder is the album,
/// and the album tag on each track carries the playlist name for a folder-scanning phone. Stays flat,
/// so no Artist/Album subfolders form under it. Empty when the playlist has no slots, and the command
/// reports zero written. The only DB touch after this returns is none: the worker owns the plan.
pub fn mimic_album_plan(conn: &Connection, playlist_id: i64) -> rusqlite::Result<ExportPlan> {
    let mut containers = Vec::new();
    if let Some(mut container) = mimic_album_container(conn, playlist_id)? {
        container.bucket = Bucket::Root;
        containers.push(container);
    }
    Ok(ExportPlan { containers })
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

    // A config with the given section toggles and playlist shape; destination/patterns are irrelevant
    // to plan assembly.
    fn cfg(albums: bool, singles: bool, playlists: bool, shape: &str) -> ExportConfig {
        ExportConfig {
            destination: String::new(),
            folder_pattern: String::new(),
            file_pattern: String::new(),
            include_albums: albums,
            include_singles: singles,
            include_playlists: playlists,
            playlist_shape: shape.to_string(),
        }
    }

    #[test]
    fn build_export_plan_buckets_albums_and_keeps_singles() {
        let mut conn = db::open_in_memory().unwrap();
        let a = insert_track(&conn, "/m/album/1.mp3", "One");
        let s = insert_track(&conn, "/m/loose/hit.mp3", "Hit");
        let album =
            db::create_album(&mut conn, Some("Rec".into()), Some("AA".into()), Some(2020), None, None, &[a], "album", 1)
                .unwrap();
        let single = db::create_single(&mut conn, s, 1).unwrap();

        let plan = build_export_plan(&conn, &cfg(true, true, false, "mimic")).unwrap();
        let album_c = plan.containers.iter().find(|c| c.album_id == album.id).unwrap();
        assert_eq!(album_c.bucket, Bucket::Albums, "an album moves under the Albums bucket");
        assert!(!album_c.flat);
        let single_c = plan.containers.iter().find(|c| c.album_id == single.id).unwrap();
        // A single stays at Root: its `Singles/` parent comes from its kind, not a bucket prefix.
        assert_eq!(single_c.bucket, Bucket::Root);
        assert_eq!(single_c.kind, ContainerKind::Single);
    }

    #[test]
    fn build_export_plan_toggles_filter_the_sections() {
        let mut conn = db::open_in_memory().unwrap();
        let a = insert_track(&conn, "/m/album/1.mp3", "One");
        let s = insert_track(&conn, "/m/loose/hit.mp3", "Hit");
        db::create_album(&mut conn, None, None, None, None, None, &[a], "album", 1).unwrap();
        db::create_single(&mut conn, s, 1).unwrap();

        // Singles only: the album is dropped entirely.
        let plan = build_export_plan(&conn, &cfg(false, true, false, "mimic")).unwrap();
        assert_eq!(plan.containers.len(), 1);
        assert_eq!(plan.containers[0].kind, ContainerKind::Single);
    }

    #[test]
    fn build_export_plan_rejects_an_empty_selection() {
        let conn = db::open_in_memory().unwrap();
        assert!(build_export_plan(&conn, &cfg(false, false, false, "mimic")).is_err());
    }

    #[test]
    fn build_export_plan_mimic_folds_a_playlist_into_one_flat_album() {
        let mut conn = db::open_in_memory().unwrap();
        let a = insert_track(&conn, "/m/album/1.mp3", "One");
        let loose = insert_track(&conn, "/m/loose/free.mp3", "Free");
        db::create_album(&mut conn, Some("Rec".into()), Some("AA".into()), None, None, None, &[a], "album", 1).unwrap();
        let pl = db::create_playlist(&conn, Some("My Mix".into()), 100).unwrap();
        db::add_tracks_to_playlist(&mut conn, pl.id, &[a, loose], 100).unwrap();

        // Albums off, playlists on, mimic: only the one flat mimic album, both slots as its members.
        let plan = build_export_plan(&conn, &cfg(false, false, true, "mimic")).unwrap();
        assert_eq!(plan.containers.len(), 1);
        let m = &plan.containers[0];
        assert_eq!(m.kind, ContainerKind::Album);
        assert!(m.flat, "a mimic gathers its tracks in one flat folder");
        assert_eq!(m.bucket, Bucket::Playlist("My Mix".to_string()));
        assert_eq!(m.title.as_deref(), Some("My Mix"));
        assert_eq!(m.album_artist.as_deref(), Some("Various Artists"));
        assert_eq!(m.tracks.len(), 2);
        // Each track is retagged to the mimic album and numbered in playlist order.
        assert_eq!(m.tracks[0].album_override.as_deref(), Some("My Mix"));
        assert_eq!(m.tracks[0].album_artist_override.as_deref(), Some("Various Artists"));
        assert_eq!(m.tracks[0].track_no, Some(1));
        assert_eq!(m.tracks[1].track_no, Some(2));
    }

    #[test]
    fn mimic_album_plan_is_one_flat_root_container() {
        let mut conn = db::open_in_memory().unwrap();
        let a = insert_track(&conn, "/m/album/1.mp3", "One");
        let loose = insert_track(&conn, "/m/loose/free.mp3", "Free");
        db::create_album(&mut conn, Some("Rec".into()), Some("AA".into()), None, None, None, &[a], "album", 1).unwrap();
        let pl = db::create_playlist(&conn, Some("My Mix".into()), 100).unwrap();
        db::add_tracks_to_playlist(&mut conn, pl.id, &[a, loose], 100).unwrap();

        let plan = mimic_album_plan(&conn, pl.id).unwrap();
        assert_eq!(plan.containers.len(), 1);
        let c = &plan.containers[0];
        // A standalone mimic re-buckets to Root: the destination itself is the album folder.
        assert_eq!(c.bucket, Bucket::Root);
        assert!(c.flat, "a mimic stays flat, no Artist/Album subfolders");
        assert_eq!(c.kind, ContainerKind::Album);
        assert_eq!(c.title.as_deref(), Some("My Mix"));
        assert_eq!(c.album_artist.as_deref(), Some("Various Artists"));
        assert_eq!(c.tracks.len(), 2);
        assert_eq!(c.tracks[0].track_no, Some(1));
        assert_eq!(c.tracks[1].track_no, Some(2));
    }

    #[test]
    fn mimic_album_plan_is_empty_for_a_playlist_with_no_slots() {
        let conn = db::open_in_memory().unwrap();
        let pl = db::create_playlist(&conn, Some("Empty".into()), 100).unwrap();
        let plan = mimic_album_plan(&conn, pl.id).unwrap();
        assert!(plan.containers.is_empty(), "no slots yields no container");
    }

    #[test]
    fn build_export_plan_file_bags_only_the_uncovered_tracks() {
        let mut conn = db::open_in_memory().unwrap();
        let a = insert_track(&conn, "/m/album/1.mp3", "One");
        let loose = insert_track(&conn, "/m/loose/free.mp3", "Free");
        db::create_album(&mut conn, Some("Rec".into()), Some("AA".into()), None, None, None, &[a], "album", 1).unwrap();
        let pl = db::create_playlist(&conn, Some("My Mix".into()), 100).unwrap();
        db::add_tracks_to_playlist(&mut conn, pl.id, &[a, loose], 100).unwrap();

        // Albums on + the file shape: the album member is already copied under Albums/, so only the
        // loose track is bagged under the playlist; the .m3u8 (written post-run) references both.
        let plan = build_export_plan(&conn, &cfg(true, false, true, "file")).unwrap();

        // The album container stays in the Albums bucket, untouched by the playlist pass.
        let album = plan
            .containers
            .iter()
            .find(|c| c.kind == ContainerKind::Album)
            .unwrap();
        assert_eq!(album.bucket, Bucket::Albums);

        // Exactly one bag under the playlist, holding only the orphan - the member is not re-copied.
        let bags: Vec<_> = plan
            .containers
            .iter()
            .filter(|c| c.bucket == Bucket::Playlist("My Mix".to_string()))
            .collect();
        assert_eq!(bags.len(), 1);
        assert_eq!(bags[0].kind, ContainerKind::Unsorted);
        assert_eq!(bags[0].tracks.len(), 1, "only the orphan is bagged");
        assert_eq!(bags[0].tracks[0].track_id, loose);
    }

    #[test]
    fn build_export_plan_file_bags_every_track_when_no_bucket_covers_it() {
        let mut conn = db::open_in_memory().unwrap();
        let a = insert_track(&conn, "/m/album/1.mp3", "One");
        let loose = insert_track(&conn, "/m/loose/free.mp3", "Free");
        db::create_album(&mut conn, Some("Rec".into()), Some("AA".into()), None, None, None, &[a], "album", 1).unwrap();
        let pl = db::create_playlist(&conn, Some("My Mix".into()), 100).unwrap();
        db::add_tracks_to_playlist(&mut conn, pl.id, &[a, loose], 100).unwrap();

        // Albums off: nothing covers the member, so both tracks bag under the playlist and there is no
        // Albums container to reference.
        let plan = build_export_plan(&conn, &cfg(false, false, true, "file")).unwrap();
        assert_eq!(plan.containers.len(), 1);
        let bag = &plan.containers[0];
        assert_eq!(bag.bucket, Bucket::Playlist("My Mix".to_string()));
        assert_eq!(bag.kind, ContainerKind::Unsorted);
        assert_eq!(bag.tracks.len(), 2);
    }
}
