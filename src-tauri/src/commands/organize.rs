/*
 * The IPC command surface for organizing tracks into albums: create and delete albums, move or
 * add tracks under single membership, reorder, edit album and per-track fields, and bind an album
 * cover. Every write goes through the shared read connection's Mutex - the same single writer the
 * cover commands use, no third connection - and each multi-statement command runs in one
 * transaction. The album cover reuses the cover pipeline: decode and cache off the runtime thread,
 * then write the manifest row and the binding together. load_organization is the load-all snapshot
 * the frontend hydrates its organize state from.
 */

// -- Library Imports --
use std::sync::Arc;

use rusqlite::Connection;
use tauri::State;

// -- Local Imports --
use crate::db;
use crate::dto::{
    AlbumFields, AlbumRow, CoverRef, CoverSource, GenreRemovalImpact, GenreRow,
    OrganizationSnapshot, TrackEdit, TrackEditFields, TrackOverride, TrackPlacement,
};
use crate::state::AppState;

/// Creates an album from a track selection: inserts the album, appends the tracks in order, and
/// pre-fills the cover from a shared folder cover when every track lives in the same folder. The
/// suggested title/artist/year/genre come from the frontend; the backend only pre-fills the cover.
#[tauri::command]
pub fn create_album(
    title: Option<String>,
    album_artist: Option<String>,
    year: Option<i64>,
    genre: Option<String>,
    track_ids: Vec<i64>,
    state: State<'_, AppState>,
) -> Result<AlbumRow, String> {
    let mut conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    let cover_id = resolve_prefill_cover(&conn, &track_ids).map_err(|e| e.to_string())?;
    db::create_album(
        &mut conn,
        title,
        album_artist,
        year,
        genre,
        cover_id,
        &track_ids,
        db::ALBUM_KIND,
        super::now_unix(),
    )
    .map_err(|e| e.to_string())
}

/// Promotes one loose track into a single: an album-of-one with kind='single', its release fields
/// seeded from the track's raw tags. The single's cover resolves from the member track's own art,
/// so no pre-fill is written here.
#[tauri::command]
pub fn create_single(track_id: i64, state: State<'_, AppState>) -> Result<AlbumRow, String> {
    let mut conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    db::create_single(&mut conn, track_id, super::now_unix()).map_err(|e| e.to_string())
}

/// Deletes an album. Membership cascades away; the tracks themselves stay and fall back to loose.
/// A single is a plain album row, so this un-singles it too: its one member falls back to loose.
#[tauri::command]
pub fn delete_album(album_id: i64, state: State<'_, AppState>) -> Result<(), String> {
    let conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    db::delete_album(&conn, album_id).map_err(|e| e.to_string())
}

/// Assigns tracks to an album under single membership: a track already elsewhere moves here, a
/// loose track is appended, a track already here is left in place.
#[tauri::command]
pub fn add_tracks_to_album(
    album_id: i64,
    track_ids: Vec<i64>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    db::add_tracks_to_album(&mut conn, album_id, &track_ids).map_err(|e| e.to_string())
}

/// Removes tracks from an album. They become loose again; their rows are untouched.
#[tauri::command]
pub fn remove_tracks_from_album(
    album_id: i64,
    track_ids: Vec<i64>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    db::remove_tracks_from_album(&mut conn, album_id, &track_ids).map_err(|e| e.to_string())
}

/// Rewrites an album's track order to the given sequence (track_no 1..N).
#[tauri::command]
pub fn set_track_order(
    album_id: i64,
    ordered_track_ids: Vec<i64>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    db::set_track_order(&mut conn, album_id, &ordered_track_ids).map_err(|e| e.to_string())
}

/// Replaces an album's title, artist, year and genre with the given full set (a None clears one).
#[tauri::command]
pub fn set_album_fields(
    album_id: i64,
    fields: AlbumFields,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    db::set_album_fields(
        &conn,
        album_id,
        fields.title,
        fields.album_artist,
        fields.year,
        fields.genre,
        super::now_unix(),
    )
    .map_err(|e| e.to_string())
}

/// Replaces one membership row's overrides and numbering with the given full set. The raw source
/// cache stays intact.
#[tauri::command]
pub fn set_track_overrides(
    album_id: i64,
    track_id: i64,
    over: TrackOverride,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    db::set_track_overrides(
        &conn,
        album_id,
        track_id,
        over.title_override,
        over.artist_override,
        over.track_no,
        over.disc_no,
    )
    .map_err(|e| e.to_string())
}

/// Imports a picked image as an album's cover. The image is decoded and both cache sizes are
/// written before any DB row is touched, so an unreadable file leaves nothing half-written. The
/// manifest row and the binding land together in one transaction. Returns the peek-size cover.
#[tauri::command]
pub async fn set_album_cover(
    album_id: i64,
    src_path: String,
    state: State<'_, AppState>,
) -> Result<CoverRef, String> {
    let created_at = super::now_unix();
    let covers_dir = state.covers_dir.clone();
    let guard = Arc::clone(&state.covers_in_flight);
    let src = src_path.clone();

    let (record, detail_path, width, height) = tauri::async_runtime::spawn_blocking(move || {
        super::covers::import_from_disk(&covers_dir, &guard, &src, created_at)
    })
    .await
    .map_err(|_| "cover task failed to run".to_string())??;

    // Write only after a clean decode: the manifest row and the album binding land together.
    {
        let mut conn = state
            .db
            .lock()
            .map_err(|_| "index is unavailable".to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let cover_id = db::upsert_cover(&tx, &record).map_err(|e| e.to_string())?;
        db::set_album_cover(&tx, album_id, cover_id, created_at).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
    }

    Ok(CoverRef {
        path: detail_path,
        width,
        height,
        source: CoverSource::Imported,
    })
}

/// Clears the cover the user bound to an album and bumps updated_at. An album falls back to a member
/// track's art, so it stays covered by its members rather than art-less.
#[tauri::command]
pub fn remove_album_cover(album_id: i64, state: State<'_, AppState>) -> Result<(), String> {
    let conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    db::remove_album_cover(&conn, album_id, super::now_unix()).map_err(|e| e.to_string())
}

/// Sets the keep-own-cover flag on the given memberships of one album. The list serves single-track
/// and multi-select alike. A flagged track embeds its own art on export instead of the album cover.
#[tauri::command]
pub fn set_track_keep_own_cover(
    album_id: i64,
    track_ids: Vec<i64>,
    value: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    db::set_track_keep_own_cover(&mut conn, album_id, &track_ids, value).map_err(|e| e.to_string())
}

/// The whole genre vocabulary, each entry with its usage count.
#[tauri::command]
pub fn list_genres(state: State<'_, AppState>) -> Result<Vec<GenreRow>, String> {
    let conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    db::list_genres(&conn).map_err(|e| e.to_string())
}

/// Creates a genre, or returns the existing row when its folded spelling already exists.
#[tauri::command]
pub fn create_genre(name: String, state: State<'_, AppState>) -> Result<GenreRow, String> {
    let conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    db::create_genre(&conn, &name, super::now_unix()).map_err(|e| e.to_string())
}

/// Renames a genre; a rename that collides with another genre's folded key is rejected.
#[tauri::command]
pub fn rename_genre(id: i64, name: String, state: State<'_, AppState>) -> Result<(), String> {
    let conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    db::rename_genre(&conn, id, &name).map_err(|e| e.to_string())
}

/// Deletes a genre; it cascades off every track that carried it.
#[tauri::command]
pub fn delete_genre(id: i64, state: State<'_, AppState>) -> Result<(), String> {
    let conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    db::delete_genre(&conn, id).map_err(|e| e.to_string())
}

/// How many distinct tracks carry a genre, for the counted confirm before deleting it.
#[tauri::command]
pub fn genre_removal_impact(
    id: i64,
    state: State<'_, AppState>,
) -> Result<GenreRemovalImpact, String> {
    let conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    let tracks = db::genre_removal_impact(&conn, id).map_err(|e| e.to_string())?;
    Ok(GenreRemovalImpact { tracks })
}

/// Folds one genre into another: source-carrying tracks keep the target, then the source is deleted.
#[tauri::command]
pub fn merge_genres(
    source_id: i64,
    target_id: i64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    db::merge_genres(&mut conn, source_id, target_id).map_err(|e| e.to_string())
}

/// Replaces one track's whole genre list with `genre_ids`, in order. Works for a loose track too.
#[tauri::command]
pub fn set_track_genres(
    track_id: i64,
    genre_ids: Vec<i64>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    db::set_track_genres(&conn, track_id, &genre_ids).map_err(|e| e.to_string())
}

/// Bulk-adds a genre to every member of an album, skipping members that already carry it.
#[tauri::command]
pub fn add_album_genre(
    album_id: i64,
    genre_id: i64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    db::add_album_genre(&mut conn, album_id, genre_id).map_err(|e| e.to_string())
}

/// Bulk-removes a genre from every member of an album.
#[tauri::command]
pub fn remove_album_genre(
    album_id: i64,
    genre_id: i64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    db::remove_album_genre(&mut conn, album_id, genre_id).map_err(|e| e.to_string())
}

/// Replaces one track's whole edit-layer metadata with the given full set (a null clears one). The
/// Files-view full editor's write; works for a loose track too.
#[tauri::command]
pub fn set_track_edit(
    track_id: i64,
    fields: TrackEditFields,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    db::set_track_edit(
        &conn,
        track_id,
        fields.title,
        fields.artist,
        fields.album,
        fields.album_artist,
        fields.year,
        fields.disc_no,
    )
    .map_err(|e| e.to_string())
}

/// Reads one track's raw edit-layer overrides and its genres, to hydrate the Files-view editor.
#[tauri::command]
pub fn get_track_edit(track_id: i64, state: State<'_, AppState>) -> Result<TrackEdit, String> {
    let conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    db::get_track_edit(&conn, track_id).map_err(|e| e.to_string())
}

/// Applies a whole album layout atomically: each member's disc and its per-disc track number.
#[tauri::command]
pub fn set_album_layout(
    album_id: i64,
    placements: Vec<TrackPlacement>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    db::set_album_layout(&mut conn, album_id, &placements).map_err(|e| e.to_string())
}

/// Loads the whole organize state in one lock: every album with its track count, every membership
/// row with its per-track genres, and the genre vocabulary. Mirrors the list_tracks load-all shape.
#[tauri::command]
pub fn load_organization(state: State<'_, AppState>) -> Result<OrganizationSnapshot, String> {
    let conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    let albums = db::load_albums(&conn).map_err(|e| e.to_string())?;
    let mut membership = db::load_album_tracks(&conn).map_err(|e| e.to_string())?;
    let genres = db::list_genres(&conn).map_err(|e| e.to_string())?;

    // Group each track's genres from the vocabulary join (position order) and attach them to the
    // flat membership rows, so the drawer hydrates per-track genres in the same load-all call.
    let pairs = db::load_track_genre_ids(&conn).map_err(|e| e.to_string())?;
    let mut by_track: std::collections::HashMap<i64, Vec<i64>> = std::collections::HashMap::new();
    for (track_id, genre_id) in pairs {
        by_track.entry(track_id).or_default().push(genre_id);
    }
    for row in &mut membership {
        row.genre_ids = by_track.remove(&row.track_id).unwrap_or_default();
    }

    Ok(OrganizationSnapshot {
        albums,
        membership,
        genres,
    })
}

/// The create-time cover pre-fill: the folder cover shared by the whole selection, or None when
/// the tracks span more than one folder, a track is unknown, or that folder has no cover set. The
/// folder is derived the same way a folder cover is keyed, so the two line up.
fn resolve_prefill_cover(conn: &Connection, track_ids: &[i64]) -> rusqlite::Result<Option<i64>> {
    let mut folder: Option<String> = None;
    for &track_id in track_ids {
        let Some(source_path) = db::get_track_source_path(conn, track_id)? else {
            return Ok(None);
        };
        let this = super::covers::folder_of(&source_path);
        match &folder {
            None => folder = Some(this),
            Some(prev) if *prev != this => return Ok(None),
            _ => {}
        }
    }

    match folder {
        Some(f) => db::get_folder_cover(conn, &f),
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::covers::InFlightGuard;
    use crate::model::CoverRecord;
    use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
    use std::io::Cursor;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU32, Ordering};

    // A unique throwaway directory under the system temp dir, removed on drop.
    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new(tag: &str) -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "plisto_org_{tag}_{}_{n}_{nanos}",
                std::process::id()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self { path }
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    // A solid-colour PNG of the given size, in memory.
    fn png_bytes(width: u32, height: u32, colour: [u8; 3]) -> Vec<u8> {
        let img = RgbImage::from_pixel(width, height, Rgb(colour));
        let mut buf = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(img)
            .write_to(&mut buf, ImageFormat::Png)
            .unwrap();
        buf.into_inner()
    }

    // Inserts a bare track row at the given source path and returns its id.
    fn insert_track(conn: &Connection, source_path: &str) -> i64 {
        conn.execute(
            "INSERT INTO tracks (source_path, filename, ext, size_bytes, mtime, has_embedded_cover, scanned_at)
             VALUES (?1, 'song.mp3', 'mp3', 10, 20, 0, 30)",
            rusqlite::params![source_path],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    // A manifest record with the given content hash, for seeding a folder cover.
    fn sample_cover(hash: &str) -> CoverRecord {
        CoverRecord {
            content_hash: hash.to_string(),
            source_kind: "imported".to_string(),
            origin_path: None,
            width: 10,
            height: 10,
            byte_len: 1,
            created_at: 1,
        }
    }

    // The membership as (track_id, track_no) pairs in stored order.
    fn membership_order(conn: &Connection) -> Vec<(i64, Option<i64>)> {
        db::load_album_tracks(conn)
            .unwrap()
            .iter()
            .map(|r| (r.track_id, r.track_no))
            .collect()
    }

    #[test]
    fn create_album_appends_tracks_in_order_and_prefills_cover() {
        let mut conn = db::open_in_memory().unwrap();
        let a = insert_track(&conn, "/music/album/1.mp3");
        let b = insert_track(&conn, "/music/album/2.mp3");
        let c = insert_track(&conn, "/music/album/3.mp3");

        // A folder cover on the shared parent seeds the album's cover.
        let cover = db::upsert_cover(&conn, &sample_cover("hash")).unwrap();
        db::set_folder_cover(&conn, "/music/album", cover, 5).unwrap();

        let cover_id = resolve_prefill_cover(&conn, &[a, b, c]).unwrap();
        let album = db::create_album(
            &mut conn,
            Some("T".into()),
            None,
            None,
            None,
            cover_id,
            &[a, b, c],
            "album",
            100,
        )
        .unwrap();

        assert_eq!(album.track_count, 3);
        assert_eq!(album.cover_id, Some(cover));
        assert_eq!(
            membership_order(&conn),
            vec![(a, Some(1)), (b, Some(2)), (c, Some(3))],
        );
    }

    #[test]
    fn create_album_leaves_cover_null_when_folders_differ() {
        let mut conn = db::open_in_memory().unwrap();
        let a = insert_track(&conn, "/music/one/1.mp3");
        let b = insert_track(&conn, "/music/two/2.mp3");

        // A cover on only one of the two folders must not seed a mixed-folder album.
        let cover = db::upsert_cover(&conn, &sample_cover("hash")).unwrap();
        db::set_folder_cover(&conn, "/music/one", cover, 5).unwrap();

        let cover_id = resolve_prefill_cover(&conn, &[a, b]).unwrap();
        assert_eq!(cover_id, None);
        let album = db::create_album(
            &mut conn,
            None,
            None,
            None,
            None,
            cover_id,
            &[a, b],
            "album",
            100,
        )
        .unwrap();
        assert_eq!(album.cover_id, None);
    }

    #[test]
    fn add_tracks_moves_single_membership_and_is_a_noop_when_present() {
        let mut conn = db::open_in_memory().unwrap();
        let t = insert_track(&conn, "/music/a/1.mp3");
        let album_a =
            db::create_album(&mut conn, None, None, None, None, None, &[t], "album", 1).unwrap();
        let album_b =
            db::create_album(&mut conn, None, None, None, None, None, &[], "album", 1).unwrap();

        // Moving t into B leaves it in B only: A's membership is gone.
        db::add_tracks_to_album(&mut conn, album_b.id, &[t]).unwrap();
        let rows = db::load_album_tracks(&conn).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].album_id, album_b.id);
        assert_eq!(rows[0].track_id, t);
        let position = rows[0].track_no;
        let _ = album_a;

        // Adding it to B again changes nothing.
        db::add_tracks_to_album(&mut conn, album_b.id, &[t]).unwrap();
        let rows = db::load_album_tracks(&conn).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].track_no, position);
    }

    #[test]
    fn set_track_order_rewrites_contiguous_and_is_idempotent() {
        let mut conn = db::open_in_memory().unwrap();
        let a = insert_track(&conn, "/m/1.mp3");
        let b = insert_track(&conn, "/m/2.mp3");
        let c = insert_track(&conn, "/m/3.mp3");
        let album = db::create_album(
            &mut conn,
            None,
            None,
            None,
            None,
            None,
            &[a, b, c],
            "album",
            1,
        )
        .unwrap();

        db::set_track_order(&mut conn, album.id, &[c, a, b]).unwrap();
        let expected = vec![(c, Some(1)), (a, Some(2)), (b, Some(3))];
        assert_eq!(membership_order(&conn), expected);

        // Re-running the same order is a no-op.
        db::set_track_order(&mut conn, album.id, &[c, a, b]).unwrap();
        assert_eq!(membership_order(&conn), expected);
    }

    #[test]
    fn delete_album_drops_membership_but_keeps_tracks() {
        let mut conn = db::open_in_memory().unwrap();
        let t = insert_track(&conn, "/m/1.mp3");
        let album =
            db::create_album(&mut conn, None, None, None, None, None, &[t], "album", 1).unwrap();

        db::delete_album(&conn, album.id).unwrap();

        assert!(db::load_album_tracks(&conn).unwrap().is_empty());
        let tracks: i64 = conn
            .query_row("SELECT COUNT(*) FROM tracks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(tracks, 1, "the track row itself survives");
    }

    #[test]
    fn load_organization_returns_albums_with_counts_and_membership() {
        let mut conn = db::open_in_memory().unwrap();
        let a = insert_track(&conn, "/m/1.mp3");
        let b = insert_track(&conn, "/m/2.mp3");
        let album = db::create_album(
            &mut conn,
            Some("T".into()),
            None,
            None,
            None,
            None,
            &[a, b],
            "album",
            1,
        )
        .unwrap();

        let albums = db::load_albums(&conn).unwrap();
        assert_eq!(albums.len(), 1);
        assert_eq!(albums[0].id, album.id);
        assert_eq!(albums[0].track_count, 2);
        assert_eq!(db::load_album_tracks(&conn).unwrap().len(), 2);
    }

    #[test]
    fn add_tracks_to_a_single_is_rejected() {
        let mut conn = db::open_in_memory().unwrap();
        let one = insert_track(&conn, "/music/a/1.mp3");
        let two = insert_track(&conn, "/music/a/2.mp3");
        let single = db::create_single(&mut conn, one, 1).unwrap();

        let result = db::add_tracks_to_album(&mut conn, single.id, &[two]);
        assert!(matches!(result, Err(db::WriteError::AddToSingle)));

        // The single still holds only its one member; the guard rolled the add back.
        let rows = db::load_album_tracks(&conn).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].track_id, one);
    }

    #[test]
    fn delete_album_on_a_single_returns_its_track_to_unsorted() {
        let mut conn = db::open_in_memory().unwrap();
        let t = insert_track(&conn, "/music/loose/hit.mp3");
        let single = db::create_single(&mut conn, t, 1).unwrap();
        assert_eq!(single.kind, "single");

        db::delete_album(&conn, single.id).unwrap();

        assert!(
            db::load_album_tracks(&conn).unwrap().is_empty(),
            "the single's membership is cascaded away",
        );
        let tracks: i64 = conn
            .query_row("SELECT COUNT(*) FROM tracks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(tracks, 1, "the track row survives, now loose again");
    }

    #[test]
    fn load_organization_returns_albums_and_singles_each_with_kind() {
        let mut conn = db::open_in_memory().unwrap();
        let a = insert_track(&conn, "/music/album/1.mp3");
        let b = insert_track(&conn, "/music/album/2.mp3");
        let s = insert_track(&conn, "/music/loose/hit.mp3");
        let album = db::create_album(
            &mut conn,
            Some("T".into()),
            None,
            None,
            None,
            None,
            &[a, b],
            "album",
            1,
        )
        .unwrap();
        let single = db::create_single(&mut conn, s, 1).unwrap();

        let albums = db::load_albums(&conn).unwrap();
        assert_eq!(albums.len(), 2, "both buckets load in one snapshot");
        let album_row = albums.iter().find(|r| r.id == album.id).unwrap();
        let single_row = albums.iter().find(|r| r.id == single.id).unwrap();
        assert_eq!(album_row.kind, "album");
        assert_eq!(album_row.track_count, 2);
        assert_eq!(single_row.kind, "single");
        assert_eq!(single_row.track_count, 1);
    }

    #[test]
    fn set_album_cover_binds_and_caches_the_thumb() {
        let mut conn = db::open_in_memory().unwrap();
        let covers = TempDir::new("covers");
        let guard = InFlightGuard::default();
        let t = insert_track(&conn, "/m/1.mp3");
        let album =
            db::create_album(&mut conn, None, None, None, None, None, &[t], "album", 1).unwrap();

        // The picked image lives outside the music folder; import only reads it.
        let picked = covers.path.join("picked.png");
        std::fs::write(&picked, png_bytes(64, 64, [10, 20, 30])).unwrap();

        let (record, detail_path, width, height) = super::super::covers::import_from_disk(
            &covers.path,
            &guard,
            &picked.to_string_lossy(),
            100,
        )
        .unwrap();
        let cover_id = db::upsert_cover(&conn, &record).unwrap();
        db::set_album_cover(&conn, album.id, cover_id, 200).unwrap();

        let reloaded = db::get_album(&conn, album.id).unwrap().unwrap();
        assert_eq!(reloaded.cover_id, Some(cover_id));
        assert_eq!(reloaded.updated_at, 200);
        assert_eq!((width, height), (64, 64));
        assert!(
            Path::new(&detail_path).exists(),
            "the cached detail thumb exists"
        );
    }
}
