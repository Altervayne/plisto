/*
 * The IPC command surface for covers: resolve a track's single cover, list its selectable art
 * sources, import a folder cover from disk, and remove one. Resolution reads the DB on the async
 * thread, then any decode/resize runs on a blocking thread so the runtime stays free. A folder
 * cover the user imported is served straight from its cached thumbnail by content hash, no
 * decode; embedded and adjacent art decode lazily on first request. Every cache path returned
 * here is loaded by the webview through the Tauri asset protocol - if a CSP is ever set, its
 * img-src must include the asset origin. Read-only over the music folder: art is only read out,
 * never written back.
 */

// -- Library Imports --
use std::path::Path;
use std::sync::Arc;

use rusqlite::Connection;
use tauri::State;

// -- Local Imports --
use crate::adhoc::{is_ad_hoc, AdHocCover};
use crate::covers::{
    discover_adjacent_images, ensure_full_res, ensure_thumb, full_res_cache_path, normalize_cover,
    read_embedded_cover_bytes, read_full_res_blob, read_image_dimensions, resolve_track_cover,
    thumb_cache_path, CoverSourceKind, InFlightGuard, ResolvedCover,
};
use crate::db;
use crate::discovery::is_library_image;
use crate::dto::{CoverCandidate, CoverRef, CoverSize, CoverSource};
use crate::model::CoverRecord;
use crate::normalize::{folder_of, normalize_path_key};
use crate::state::AppState;

// The bounded longest edge for each requested size. The small size feeds the candidate list; the
// large one is the peek cover, big enough to scale cleanly on a HiDPI display.
const THUMB_EDGE: u32 = 128;
const DETAIL_EDGE: u32 = 512;

/// Resolves a track's single cover at the requested size, generating the thumbnail on a miss.
/// Returns None when the track has no art from any source. `keep_own` mirrors the membership's
/// keep-own-cover flag: when set, the folder cover steps aside so the track shows its own embedded
/// or adjacent art, exactly as export embeds it - falling back to the folder cover only when the
/// track has none.
#[tauri::command]
pub async fn read_cover(
    track_id: i64,
    size: CoverSize,
    keep_own: bool,
    state: State<'_, AppState>,
) -> Result<Option<CoverRef>, String> {
    // An ad-hoc track has no index row: its cover resolves from the stash, a cheap map read with no
    // decode, since player_play_file already cached both sizes by hash when the file was opened.
    if is_ad_hoc(track_id) {
        return Ok(resolve_ad_hoc_cover(state.inner(), track_id, max_edge(size)));
    }
    resolve_at(state.inner(), track_id, max_edge(size), keep_own).await
}

/// Lists every selectable art source for a track's cover picker: its embedded picture (if any)
/// first, then each adjacent image in discovery order, each with a small generated thumbnail.
#[tauri::command]
pub async fn list_cover_candidates(
    track_id: i64,
    state: State<'_, AppState>,
) -> Result<Vec<CoverCandidate>, String> {
    let prepared = {
        let conn = state
            .db
            .lock()
            .map_err(|_| "index is unavailable".to_string())?;
        match db::get_track_cover_inputs(&conn, track_id).map_err(|e| e.to_string())? {
            Some((source_path, art)) => Some((source_path, art == Some(true))),
            None => None,
        }
    };
    let Some((source_path, has_embedded)) = prepared else {
        return Ok(Vec::new());
    };

    let covers_dir = state.covers_dir.clone();
    let guard = Arc::clone(&state.covers_in_flight);
    tauri::async_runtime::spawn_blocking(move || {
        build_candidates(&covers_dir, &guard, &source_path, has_embedded)
    })
    .await
    .map_err(|_| "cover task failed to run".to_string())
}

/// Lists every loose image sitting directly in the track's own folder, each as a full on-disk
/// path, sorted. Where list_cover_candidates surfaces only embedded and adjacent-stem art, this is
/// every image in the folder, so the peek can bind any of them as the track's per-track cover. The
/// folder comes from the track's real-case path (the folded source_path may not exist on a
/// case-sensitive filesystem). A missing or unreadable folder reads as empty, not an error; an
/// unknown track errors. Read-only: the folder is only listed, never written.
#[tauri::command]
pub async fn list_folder_images(
    track_id: i64,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let real_path = {
        let conn = state
            .db
            .lock()
            .map_err(|_| "index is unavailable".to_string())?;
        let mut rows = db::load_track_export_paths(&conn, &[track_id]).map_err(|e| e.to_string())?;
        match rows.pop() {
            Some((_, path)) => path,
            None => return Err("track not found".to_string()),
        }
    };

    tauri::async_runtime::spawn_blocking(move || folder_images(&real_path))
        .await
        .map_err(|_| "cover task failed to run".to_string())
}

/// Imports a picked image as the cover for the track's folder. The image is decoded and both
/// cache sizes are written before any DB row is touched, so an unreadable file leaves nothing
/// half-written. Returns the newly resolved cover at the peek size. The picked file is only read.
#[tauri::command]
pub async fn import_folder_cover(
    track_id: i64,
    src_path: String,
    state: State<'_, AppState>,
) -> Result<CoverRef, String> {
    let folder = {
        let conn = state
            .db
            .lock()
            .map_err(|_| "index is unavailable".to_string())?;
        let Some((source_path, _)) =
            db::get_track_cover_inputs(&conn, track_id).map_err(|e| e.to_string())?
        else {
            return Err("track not found".to_string());
        };
        folder_of(&source_path)
    };

    let created_at = super::now_unix();
    let covers_dir = state.covers_dir.clone();
    let guard = Arc::clone(&state.covers_in_flight);
    let src = src_path.clone();

    let (record, detail_path, width, height) = tauri::async_runtime::spawn_blocking(move || {
        import_from_disk(&covers_dir, &guard, &src, created_at)
    })
    .await
    .map_err(|_| "cover task failed to run".to_string())??;

    // Write only after a clean decode: the manifest row and the folder binding land together.
    {
        let conn = state
            .db
            .lock()
            .map_err(|_| "index is unavailable".to_string())?;
        let cover_id = db::upsert_cover(&conn, &record).map_err(|e| e.to_string())?;
        db::set_folder_cover(&conn, &folder, cover_id, created_at).map_err(|e| e.to_string())?;
    }

    Ok(CoverRef {
        path: detail_path,
        width,
        height,
        source: CoverSource::Imported,
    })
}

/// Imports a picked image as the cover for a folder addressed by its raw path, for an image-only
/// subfolder that holds no track to route through import_folder_cover. Mirrors it otherwise: the
/// image is decoded and both cache sizes are written before any DB row is touched, then the manifest
/// row and the folder binding land together. The path is folded the same way a track's folder is, so
/// the binding resolves back on read. Returns the newly resolved cover at the peek size. The picked
/// file is only read.
#[tauri::command]
pub async fn import_folder_cover_by_path(
    folder_path: String,
    src_path: String,
    state: State<'_, AppState>,
) -> Result<CoverRef, String> {
    let folder = normalize_path_key(&folder_path);
    let created_at = super::now_unix();
    let covers_dir = state.covers_dir.clone();
    let guard = Arc::clone(&state.covers_in_flight);
    let src = src_path.clone();

    let (record, detail_path, width, height) = tauri::async_runtime::spawn_blocking(move || {
        import_from_disk(&covers_dir, &guard, &src, created_at)
    })
    .await
    .map_err(|_| "cover task failed to run".to_string())??;

    // Write only after a clean decode: the manifest row and the folder binding land together.
    {
        let conn = state
            .db
            .lock()
            .map_err(|_| "index is unavailable".to_string())?;
        let cover_id = db::upsert_cover(&conn, &record).map_err(|e| e.to_string())?;
        db::set_folder_cover(&conn, &folder, cover_id, created_at).map_err(|e| e.to_string())?;
    }

    Ok(CoverRef {
        path: detail_path,
        width,
        height,
        source: CoverSource::Imported,
    })
}

/// Generates a thumbnail for an arbitrary on-disk image at `size`, for a covers-workspace tile. The
/// existing thumb commands all key on a track id; this one takes a bare path, reading and decoding
/// off the runtime thread. None on an unreadable or undecodable file, so a broken tile stays quiet
/// rather than erroring. The file is only read.
#[tauri::command]
pub async fn image_thumb(
    src_path: String,
    size: CoverSize,
    state: State<'_, AppState>,
) -> Result<Option<CoverRef>, String> {
    let covers_dir = state.covers_dir.clone();
    let guard = Arc::clone(&state.covers_in_flight);
    let edge = max_edge(size);
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = std::fs::read(&src_path).ok()?;
        cover_ref_from_bytes(&covers_dir, &guard, &bytes, edge, CoverSource::Imported)
    })
    .await
    .map_err(|_| "cover task failed to run".to_string())
}

/// Removes the cover the user bound to the track's folder and returns whatever cover the folder
/// falls back to (embedded or adjacent art), or None when none remains.
#[tauri::command]
pub async fn remove_folder_cover(
    track_id: i64,
    state: State<'_, AppState>,
) -> Result<Option<CoverRef>, String> {
    {
        let conn = state
            .db
            .lock()
            .map_err(|_| "index is unavailable".to_string())?;
        let Some((source_path, _)) =
            db::get_track_cover_inputs(&conn, track_id).map_err(|e| e.to_string())?
        else {
            return Ok(None);
        };
        let folder = folder_of(&source_path);
        db::remove_folder_cover(&conn, &folder).map_err(|e| e.to_string())?;
    }

    resolve_at(state.inner(), track_id, DETAIL_EDGE, false).await
}

/// Imports a picked image as the assigned cover for each of `track_ids`. The image is decoded and
/// both cache sizes are written before any DB row is touched, so an unreadable file leaves nothing
/// half-written; one decode covers the whole selection. Returns the newly resolved cover at the peek
/// size. The picked file is only read.
#[tauri::command]
pub async fn import_track_cover(
    track_ids: Vec<i64>,
    src_path: String,
    state: State<'_, AppState>,
) -> Result<CoverRef, String> {
    let created_at = super::now_unix();
    let covers_dir = state.covers_dir.clone();
    let guard = Arc::clone(&state.covers_in_flight);
    let src = src_path.clone();

    let (record, detail_path, width, height) = tauri::async_runtime::spawn_blocking(move || {
        import_from_disk(&covers_dir, &guard, &src, created_at)
    })
    .await
    .map_err(|_| "cover task failed to run".to_string())??;

    // Write only after a clean decode: the manifest row and every track binding land together.
    {
        let mut conn = state
            .db
            .lock()
            .map_err(|_| "index is unavailable".to_string())?;
        let cover_id = db::upsert_cover(&conn, &record).map_err(|e| e.to_string())?;
        db::set_track_cover(&mut conn, &track_ids, cover_id, created_at).map_err(|e| e.to_string())?;
    }

    Ok(CoverRef {
        path: detail_path,
        width,
        height,
        source: CoverSource::Imported,
    })
}

/// Removes the cover the user assigned to each of `track_ids`. After this, each track resolves
/// through the folder/keep-own logic again.
#[tauri::command]
pub async fn remove_track_cover(
    track_ids: Vec<i64>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    db::remove_track_cover(&mut conn, &track_ids).map_err(|e| e.to_string())
}

/// Writes the track's resolved cover to `dest_path` at full resolution, verbatim. Resolves the
/// same source read_cover would (folder cover, else embedded art, else the first adjacent image),
/// but hands over the original bytes rather than a thumbnail, so the user keeps the art untouched.
/// The source and the destination are the only disk touch; the audio file and source image are
/// only read. Errors when the track has no cover or the destination cannot be written.
#[tauri::command]
pub async fn save_track_cover(
    track_id: i64,
    dest_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let plan = {
        let conn = state
            .db
            .lock()
            .map_err(|_| "index is unavailable".to_string())?;
        prepare_save(&conn, track_id)?
    };

    let covers_dir = state.covers_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let bytes =
            resolve_full_res(&covers_dir, &plan).ok_or("this track has no cover to save")?;
        std::fs::write(&dest_path, &bytes).map_err(|_| "couldn't write the cover".to_string())
    })
    .await
    .map_err(|_| "cover task failed to run".to_string())?
}

/// Sniffs the leading magic bytes to name a track's full-res cover format, so a save dialog can
/// default to the art's real extension rather than a blanket .jpg. Reads the same source
/// save_track_cover writes, off the runtime thread. None when the track has no cover.
#[tauri::command]
pub async fn track_cover_ext(
    track_id: i64,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let plan = {
        let conn = state
            .db
            .lock()
            .map_err(|_| "index is unavailable".to_string())?;
        prepare_save(&conn, track_id)?
    };

    let covers_dir = state.covers_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        resolve_full_res(&covers_dir, &plan).map(|bytes| image_ext(&bytes).to_string())
    })
    .await
    .map_err(|_| "cover task failed to run".to_string())
}

/// Resolves an album's cover at the requested size: its bound cover when set, else the art of its
/// lowest-numbered member track, else None. A bound cover resolves straight from its cached
/// thumbnail by hash; the member fallback runs the same resolution read_cover does, decoding off
/// the runtime thread on a miss.
#[tauri::command]
pub async fn album_cover(
    album_id: i64,
    size: CoverSize,
    state: State<'_, AppState>,
) -> Result<Option<CoverRef>, String> {
    let edge = max_edge(size);
    let decision = {
        let conn = state
            .db
            .lock()
            .map_err(|_| "index is unavailable".to_string())?;
        prepare_album_cover(&conn, &state.covers_dir, album_id, edge).map_err(|e| e.to_string())?
    };

    match decision {
        AlbumCover::None => Ok(None),
        AlbumCover::Bound(cover) => Ok(Some(cover)),
        AlbumCover::FromTrack(track_id) => resolve_at(state.inner(), track_id, edge, false).await,
    }
}

/// Resolves a playlist's cover at the requested size: the cover the user bound to it, served
/// straight from its cached thumbnail by hash, or None when it has none set. Mirrors album_cover
/// minus the member fallback - a playlist cover is only ever the one the user set.
#[tauri::command]
pub async fn playlist_cover(
    playlist_id: i64,
    size: CoverSize,
    state: State<'_, AppState>,
) -> Result<Option<CoverRef>, String> {
    let edge = max_edge(size);
    let conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    prepare_playlist_cover(&conn, &state.covers_dir, playlist_id, edge).map_err(|e| e.to_string())
}

// ---- Resolution ----

/// The outcome of reading the DB for a track's cover: nothing, a folder cover served straight
/// from its cached thumbnail, or a source that still needs a decode off the runtime thread.
enum Resolution {
    None,
    Folder(CoverRef),
    Dynamic {
        source_path: String,
        has_embedded: bool,
        // The folder cover to fall back to when the track has no own art. Set only on the keep-own
        // path, where own art wins but the folder cover still stands in for a track that has none;
        // None on the normal path, where a present folder cover already resolved to `Folder`.
        fallback: Option<CoverRef>,
    },
}

/// Reads the DB to decide a track's cover at `max_edge`. A folder cover resolves fully here (its
/// thumbnail already exists by hash, no decode); otherwise the embedded/adjacent decode is left
/// to the caller's blocking stage. Sync: touches only the connection and a cache path.
fn prepare_resolution(
    conn: &Connection,
    covers_dir: &Path,
    track_id: i64,
    max_edge: u32,
    keep_own: bool,
) -> rusqlite::Result<Resolution> {
    let Some((source_path, art)) = db::get_track_cover_inputs(conn, track_id)? else {
        return Ok(Resolution::None);
    };

    // A cover the user assigned to this track is the top-priority source: it wins over the folder
    // cover and the keep-own path alike, whatever `keep_own` says. Resolved straight from its cached
    // thumbnail by hash, exactly like a bound folder cover, so no decode is left to the caller.
    if let Some(cover_id) = db::get_track_cover_id(conn, track_id)? {
        if let Some((hash, kind, width, height)) = db::get_cover(conn, cover_id)? {
            return Ok(Resolution::Folder(CoverRef {
                path: path_to_string(&thumb_cache_path(covers_dir, &hash, max_edge)),
                width,
                height,
                source: cover_source_from_kind(&kind),
            }));
        }
    }

    let folder = folder_of(&source_path);
    // The folder cover, resolved to a ref if one is bound. It wins for a normal member; a
    // keep-own-cover member steps past it to its own art, keeping it only as the fallback for a
    // track with none - the same precedence export applies.
    let folder_cover = match db::get_folder_cover(conn, &folder)? {
        Some(cover_id) => {
            db::get_cover(conn, cover_id)?.map(|(hash, kind, width, height)| CoverRef {
                path: path_to_string(&thumb_cache_path(covers_dir, &hash, max_edge)),
                width,
                height,
                source: cover_source_from_kind(&kind),
            })
        }
        None => None,
    };

    if !keep_own {
        if let Some(cover) = folder_cover {
            return Ok(Resolution::Folder(cover));
        }
    }

    Ok(Resolution::Dynamic {
        source_path,
        has_embedded: art == Some(true),
        fallback: if keep_own { folder_cover } else { None },
    })
}

/// The outcome of reading the DB for an album's cover: nothing, the album's own bound cover served
/// from its cached thumbnail, or a member track whose own art the caller still resolves.
enum AlbumCover {
    None,
    Bound(CoverRef),
    FromTrack(i64),
}

/// Reads the DB to decide an album's cover at `max_edge`. A bound cover resolves fully here (its
/// thumbnail already exists by hash, no decode); otherwise the lowest-numbered member track is
/// handed back for the caller's track resolution. Sync: touches only the connection and a path.
fn prepare_album_cover(
    conn: &Connection,
    covers_dir: &Path,
    album_id: i64,
    max_edge: u32,
) -> rusqlite::Result<AlbumCover> {
    if let Some(cover_id) = db::get_album_cover_id(conn, album_id)? {
        if let Some((hash, kind, width, height)) = db::get_cover(conn, cover_id)? {
            let path = thumb_cache_path(covers_dir, &hash, max_edge);
            return Ok(AlbumCover::Bound(CoverRef {
                path: path_to_string(&path),
                width,
                height,
                source: cover_source_from_kind(&kind),
            }));
        }
    }

    match db::get_album_first_track(conn, album_id)? {
        Some(track_id) => Ok(AlbumCover::FromTrack(track_id)),
        None => Ok(AlbumCover::None),
    }
}

/// Reads the DB to resolve a playlist's cover at `max_edge`: the bound cover served from its cached
/// thumbnail by hash, or None. No decode and no fallback - a playlist cover is only ever the bound
/// one, so this resolves fully here. Sync: touches only the connection and a cache path.
fn prepare_playlist_cover(
    conn: &Connection,
    covers_dir: &Path,
    playlist_id: i64,
    max_edge: u32,
) -> rusqlite::Result<Option<CoverRef>> {
    if let Some(cover_id) = db::get_playlist_cover_id(conn, playlist_id)? {
        if let Some((hash, kind, width, height)) = db::get_cover(conn, cover_id)? {
            let path = thumb_cache_path(covers_dir, &hash, max_edge);
            return Ok(Some(CoverRef {
                path: path_to_string(&path),
                width,
                height,
                source: cover_source_from_kind(&kind),
            }));
        }
    }
    Ok(None)
}

/// Resolves a track's cover, running any decode on a blocking thread. Shared by read_cover and
/// the fallback path of remove_folder_cover.
async fn resolve_at(
    state: &AppState,
    track_id: i64,
    max_edge: u32,
    keep_own: bool,
) -> Result<Option<CoverRef>, String> {
    let resolution = {
        let conn = state
            .db
            .lock()
            .map_err(|_| "index is unavailable".to_string())?;
        prepare_resolution(&conn, &state.covers_dir, track_id, max_edge, keep_own)
            .map_err(|e| e.to_string())?
    };

    match resolution {
        Resolution::None => Ok(None),
        Resolution::Folder(cover) => Ok(Some(cover)),
        Resolution::Dynamic {
            source_path,
            has_embedded,
            fallback,
        } => {
            let covers_dir = state.covers_dir.clone();
            let guard = Arc::clone(&state.covers_in_flight);
            tauri::async_runtime::spawn_blocking(move || {
                generate_dynamic_ref(&covers_dir, &guard, &source_path, has_embedded, max_edge)
            })
            .await
            // Own art wins; the folder cover stands in only when the keep-own track has none.
            .map(|own| own.or(fallback))
            .map_err(|_| "cover task failed to run".to_string())
        }
    }
}

/// Generates the resolved cover for a track with no folder cover: its embedded art if present,
/// else the first adjacent image, else nothing. Returns None on any read or decode failure, so a
/// broken source is quiet rather than a hard error on this passive path.
fn generate_dynamic_ref(
    covers_dir: &Path,
    guard: &InFlightGuard,
    source_path: &str,
    has_embedded: bool,
    max_edge: u32,
) -> Option<CoverRef> {
    let path = Path::new(source_path);
    let adjacents = discover_adjacent_images(path);

    // Folder precedence is settled before this stage, so only embedded and adjacent remain.
    match resolve_track_cover(false, has_embedded, !adjacents.is_empty()) {
        ResolvedCover::Embedded => {
            let bytes = read_embedded_cover_bytes(path)?;
            cover_ref_from_bytes(covers_dir, guard, &bytes, max_edge, CoverSource::Embedded)
        }
        ResolvedCover::Adjacent => {
            let bytes = std::fs::read(adjacents.first()?).ok()?;
            cover_ref_from_bytes(covers_dir, guard, &bytes, max_edge, CoverSource::Adjacent)
        }
        ResolvedCover::Folder | ResolvedCover::None => None,
    }
}

/// Resolves a track's cover to a plain on-disk image file at the peek size, for a consumer that
/// needs a file path rather than an IPC ref - the Windows now-playing thumbnail. A bound folder or
/// per-track cover is its cached hash file, already on disk with no decode; embedded or adjacent art
/// decodes here, so this must run off any realtime thread, never the player thread. None when the
/// track has no art from any source. Read-only over the music folder, like every other cover path.
///
/// Reads the DB to decide the source under a short lock, then drops it before any decode - the same
/// read-under-lock / decode-unlocked split resolve_at uses, so an embedded/adjacent decode never
/// holds the index lock. The decode runs inline on the caller's thread (the SMTC coordinator), which
/// is why resolve_at's async spawn_blocking is a plain call here.
#[cfg(windows)]
pub(crate) fn resolve_cover_file(state: &AppState, track_id: i64) -> Option<String> {
    let resolution = {
        let conn = state.db.lock().ok()?;
        prepare_resolution(&conn, &state.covers_dir, track_id, DETAIL_EDGE, false).ok()?
    };
    match resolution {
        Resolution::None => None,
        Resolution::Folder(cover) => Some(cover.path),
        Resolution::Dynamic {
            source_path,
            has_embedded,
            ..
        } => generate_dynamic_ref(
            &state.covers_dir,
            &state.covers_in_flight,
            &source_path,
            has_embedded,
            DETAIL_EDGE,
        )
        .map(|cover| cover.path),
    }
}

// ---- Ad-hoc ----

/// Caches a lone file's own art for an ad-hoc track: its embedded picture, else the first adjacent
/// image, at both thumb sizes by hash. Returns what read_cover needs to resolve it later at either
/// size, or None when the file carries no art from either source. The decode runs here, off the
/// player thread, so a later sentinel read is a warm-cache lookup. Returns None on any read or decode
/// failure, so a broken source is quiet rather than a hard error. Read-only over the file and folder.
pub(crate) fn cache_ad_hoc_cover(
    covers_dir: &Path,
    guard: &InFlightGuard,
    source_path: &str,
) -> Option<AdHocCover> {
    let path = Path::new(source_path);
    // Embedded art wins, then the first adjacent image - the same precedence resolve_track_cover
    // applies for a track with no folder cover, which an ad-hoc track never has.
    let bytes = read_embedded_cover_bytes(path).or_else(|| {
        discover_adjacent_images(path)
            .first()
            .and_then(|image| std::fs::read(image).ok())
    })?;
    let (width, height) = read_image_dimensions(&bytes).ok()?;
    let hash = blake3::hash(&bytes).to_hex().to_string();
    // Both sizes up front so each sentinel read resolves straight to a warm file, like an import.
    ensure_thumb(covers_dir, &hash, &bytes, THUMB_EDGE, guard).ok()?;
    ensure_thumb(covers_dir, &hash, &bytes, DETAIL_EDGE, guard).ok()?;
    Some(AdHocCover {
        hash,
        width: width as i64,
        height: height as i64,
    })
}

/// Resolves an ad-hoc track's cover at `max_edge` from the stash: a cached-by-hash file path, no
/// decode. None when the entry has no cover or no entry is stashed. The map read stands in for the DB
/// read the library path takes; the thumbnail was written by cache_ad_hoc_cover when the file opened.
/// The source reads Embedded - the file's own art, embedded taking precedence over an adjacent image.
fn resolve_ad_hoc_cover(state: &AppState, track_id: i64, max_edge: u32) -> Option<CoverRef> {
    let stash = state.ad_hoc.lock().ok()?;
    let cover = stash.get(&track_id)?.cover.as_ref()?;
    Some(CoverRef {
        path: path_to_string(&thumb_cache_path(&state.covers_dir, &cover.hash, max_edge)),
        width: cover.width,
        height: cover.height,
        source: CoverSource::Embedded,
    })
}

/// The on-disk file path of an ad-hoc track's cover at the peek size, for the Windows now-playing
/// thumbnail - the ad-hoc counterpart to resolve_cover_file. A warm-cache path by hash with no
/// decode; None when the track has no stashed cover. Safe off the SMTC coordinator thread: a map
/// read, never a lock held across work.
#[cfg(windows)]
pub(crate) fn resolve_ad_hoc_cover_file(state: &AppState, track_id: i64) -> Option<String> {
    resolve_ad_hoc_cover(state, track_id, DETAIL_EDGE).map(|cover| cover.path)
}

/// Builds a CoverRef by caching a thumbnail of `bytes`. None when the bytes cannot be read as an
/// image or the cache cannot be written.
fn cover_ref_from_bytes(
    covers_dir: &Path,
    guard: &InFlightGuard,
    bytes: &[u8],
    max_edge: u32,
    source: CoverSource,
) -> Option<CoverRef> {
    let (width, height) = read_image_dimensions(bytes).ok()?;
    let hash = blake3::hash(bytes).to_hex().to_string();
    let path = ensure_thumb(covers_dir, &hash, bytes, max_edge, guard).ok()?;
    Some(CoverRef {
        path: path_to_string(&path),
        width: width as i64,
        height: height as i64,
        source,
    })
}

// ---- Candidates ----

/// Builds the picker's source list: the embedded picture first (when readable), then each
/// adjacent image in discovery order. A source that cannot be read is skipped, not surfaced.
fn build_candidates(
    covers_dir: &Path,
    guard: &InFlightGuard,
    source_path: &str,
    has_embedded: bool,
) -> Vec<CoverCandidate> {
    let path = Path::new(source_path);
    let mut out = Vec::new();

    if has_embedded {
        if let Some(bytes) = read_embedded_cover_bytes(path) {
            if let Some(candidate) = candidate_from_bytes(
                covers_dir,
                guard,
                &bytes,
                CoverSource::Embedded,
                Some(source_path.to_string()),
            ) {
                out.push(candidate);
            }
        }
    }

    for image in discover_adjacent_images(path) {
        let Ok(bytes) = std::fs::read(&image) else {
            continue;
        };
        if let Some(candidate) = candidate_from_bytes(
            covers_dir,
            guard,
            &bytes,
            CoverSource::Adjacent,
            Some(image.to_string_lossy().into_owned()),
        ) {
            out.push(candidate);
        }
    }

    out
}

/// Builds one candidate by caching a small thumbnail of `bytes`. None when the bytes cannot be
/// read as an image.
fn candidate_from_bytes(
    covers_dir: &Path,
    guard: &InFlightGuard,
    bytes: &[u8],
    source: CoverSource,
    origin_path: Option<String>,
) -> Option<CoverCandidate> {
    let (width, height) = read_image_dimensions(bytes).ok()?;
    let hash = blake3::hash(bytes).to_hex().to_string();
    let path = ensure_thumb(covers_dir, &hash, bytes, THUMB_EDGE, guard).ok()?;
    Some(CoverCandidate {
        source,
        origin_path,
        path: path_to_string(&path),
        width: width as i64,
        height: height as i64,
    })
}

// ---- Import ----

/// Reads, validates and caches a picked image, returning its manifest row plus the peek-size
/// cache path and dimensions. Validate-then-commit: this does no DB work, so a caller writes the
/// row only once the image is known good. Errors with a plain message the UI can show quietly.
pub(super) fn import_from_disk(
    covers_dir: &Path,
    guard: &InFlightGuard,
    src_path: &str,
    created_at: i64,
) -> Result<(CoverRecord, String, i64, i64), String> {
    let unreadable = || "Couldn't read that image".to_string();

    let bytes = std::fs::read(src_path).map_err(|_| unreadable())?;
    let (width, height) = read_image_dimensions(&bytes).map_err(|_| unreadable())?;

    let record = normalize_cover(
        &bytes,
        width,
        height,
        CoverSourceKind::Imported,
        Some(src_path.to_string()),
        created_at,
    );

    // Both sizes are generated up front so a later read resolves straight to a warm file.
    ensure_thumb(covers_dir, &record.content_hash, &bytes, THUMB_EDGE, guard)
        .map_err(|_| unreadable())?;
    let detail = ensure_thumb(covers_dir, &record.content_hash, &bytes, DETAIL_EDGE, guard)
        .map_err(|_| unreadable())?;

    // Keep the original bytes verbatim so export can embed full-resolution art even after the
    // user moves or deletes the file they picked.
    ensure_full_res(covers_dir, &record.content_hash, &bytes, guard).map_err(|_| unreadable())?;

    Ok((record, path_to_string(&detail), width as i64, height as i64))
}

// ---- Full-resolution save ----

/// The source a track's cover saves from, decided under the DB lock so the file work runs off the
/// runtime thread. A bound folder cover carries its store key; otherwise the track's own art is
/// re-derived from its source path.
enum SavePlan {
    Store {
        content_hash: String,
        byte_len: i64,
    },
    Derive {
        source_path: String,
        has_embedded: bool,
    },
}

/// Reads the DB to decide where a track's full-res cover comes from. A folder cover resolves to
/// its integrity-checked store blob; otherwise the track's own embedded or adjacent art is left to
/// the blocking stage. Errors only when the track row is absent. Sync: touches only the connection.
fn prepare_save(conn: &Connection, track_id: i64) -> Result<SavePlan, String> {
    let Some((source_path, art)) =
        db::get_track_cover_inputs(conn, track_id).map_err(|e| e.to_string())?
    else {
        return Err("track not found".to_string());
    };

    let folder = folder_of(&source_path);
    if let Some(cover_id) = db::get_folder_cover(conn, &folder).map_err(|e| e.to_string())? {
        if let Some((content_hash, byte_len)) =
            db::get_cover_blob_key(conn, cover_id).map_err(|e| e.to_string())?
        {
            return Ok(SavePlan::Store {
                content_hash,
                byte_len,
            });
        }
    }

    Ok(SavePlan::Derive {
        source_path,
        has_embedded: art == Some(true),
    })
}

/// Produces the full-resolution cover bytes for a save plan, or None when the source yields no
/// readable art. The imported blob comes straight from the store (integrity-checked); embedded and
/// adjacent art are re-derived on the same precedence read_cover uses. Read-only over the source.
fn resolve_full_res(covers_dir: &Path, plan: &SavePlan) -> Option<Vec<u8>> {
    match plan {
        SavePlan::Store {
            content_hash,
            byte_len,
        } => read_full_res_blob(covers_dir, content_hash, *byte_len),
        SavePlan::Derive {
            source_path,
            has_embedded,
        } => {
            let path = Path::new(source_path);
            let adjacents = discover_adjacent_images(path);
            match resolve_track_cover(false, *has_embedded, !adjacents.is_empty()) {
                ResolvedCover::Embedded => read_embedded_cover_bytes(path),
                ResolvedCover::Adjacent => std::fs::read(adjacents.first()?).ok(),
                ResolvedCover::Folder | ResolvedCover::None => None,
            }
        }
    }
}

/// Names the image format of `bytes` from its leading magic bytes, returning a lowercase extension
/// without the dot. Unrecognized or too-short input falls back to "jpg", since embedded art is
/// overwhelmingly JPEG and the bytes are written verbatim either way.
fn image_ext(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "jpg"
    } else if bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) {
        "png"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "gif"
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "webp"
    } else if bytes.starts_with(b"BM") {
        "bmp"
    } else {
        "jpg"
    }
}

// ---- Full-resolution store ----

/// Reads the stored full-resolution bytes of an imported cover, or None when no durable blob
/// exists or it fails its integrity check. The blob is checked against the manifest's byte length
/// and content hash, so a truncated or swapped file reads as absent rather than corrupt art.
/// Export uses this to embed real art; a bad blob is quiet, never a panic.
#[allow(dead_code)]
pub(crate) fn read_full_res(
    conn: &Connection,
    covers_dir: &Path,
    cover_id: i64,
) -> rusqlite::Result<Option<Vec<u8>>> {
    let Some((content_hash, byte_len)) = db::get_cover_blob_key(conn, cover_id)? else {
        return Ok(None);
    };
    Ok(read_full_res_blob(covers_dir, &content_hash, byte_len))
}

/// Populates the full-res store for imported covers bound before the store existed. Best-effort
/// and one-time: for each manifest entry it reads the origin image once and stores it only when
/// the file is still present and hashes to the recorded content hash; a moved, deleted or changed
/// origin is left alone, so export later reports that cover as unavailable. Idempotent - an entry
/// whose blob already exists is skipped without touching the origin.
pub fn backfill_full_res(covers_dir: &Path, guard: &InFlightGuard, entries: &[(String, String)]) {
    for (content_hash, origin_path) in entries {
        if full_res_cache_path(covers_dir, content_hash).exists() {
            continue;
        }
        let Ok(bytes) = std::fs::read(origin_path) else {
            continue;
        };
        if blake3::hash(&bytes).to_hex().to_string() != *content_hash {
            continue;
        }
        let _ = ensure_full_res(covers_dir, content_hash, &bytes, guard);
    }
}

// ---- Shared helpers ----

/// The requested size mapped to its bounded longest edge in pixels.
fn max_edge(size: CoverSize) -> u32 {
    match size {
        CoverSize::Thumb => THUMB_EDGE,
        CoverSize::Detail => DETAIL_EDGE,
    }
}

/// A manifest's stored source-kind string mapped back to the IPC enum. An unknown value reads as
/// imported, the only kind a folder cover is written with.
fn cover_source_from_kind(kind: &str) -> CoverSource {
    match kind {
        "embedded" => CoverSource::Embedded,
        "adjacent" => CoverSource::Adjacent,
        _ => CoverSource::Imported,
    }
}

/// Reads the one folder holding `track_path` and returns every loose image in it as a full path,
/// sorted. Not recursive: only that folder's own direct files are considered, and only those whose
/// extension names a library image. A path with no parent, or a folder that cannot be read, yields
/// an empty list rather than an error. Read-only over the folder.
fn folder_images(track_path: &str) -> Vec<String> {
    let Some(folder) = Path::new(track_path).parent() else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(folder) else {
        return Vec::new();
    };
    let mut images: Vec<String> = entries
        .flatten()
        .filter(|entry| entry.file_type().map(|t| t.is_file()).unwrap_or(false))
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .and_then(|ext| ext.to_str())
                .map(is_library_image)
                .unwrap_or(false)
        })
        .map(|path| path.to_string_lossy().into_owned())
        .collect();
    images.sort();
    images
}

/// A cache path as the plain filesystem string the frontend wraps with convertFileSrc.
fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
    use std::io::Cursor;
    use std::path::PathBuf;
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
                "plisto_cmd_{tag}_{}_{n}_{nanos}",
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

    // Inserts a bare track row and returns its id.
    fn insert_track(conn: &Connection, source_path: &str) -> i64 {
        conn.execute(
            "INSERT INTO tracks (source_path, filename, ext, size_bytes, mtime, has_embedded_cover, scanned_at)
             VALUES (?1, 'song.mp3', 'mp3', 10, 20, 0, 30)",
            rusqlite::params![source_path],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    #[test]
    fn import_then_read_resolves_to_the_imported_cover() {
        let conn = db::open_in_memory().unwrap();
        let covers = TempDir::new("covers");
        let music = TempDir::new("music");
        let guard = InFlightGuard::default();

        let source_path = music.path.join("song.mp3").to_string_lossy().into_owned();
        let track_id = insert_track(&conn, &source_path);

        // The picked image lives outside the music folder; import only reads it.
        let picked = covers.path.join("picked.png");
        std::fs::write(&picked, png_bytes(64, 48, [200, 40, 40])).unwrap();

        let (record, detail_path, width, height) =
            import_from_disk(&covers.path, &guard, &picked.to_string_lossy(), 100).unwrap();
        let cover_id = db::upsert_cover(&conn, &record).unwrap();
        db::set_folder_cover(&conn, &folder_of(&source_path), cover_id, 100).unwrap();
        assert_eq!((width, height), (64, 48));

        // Reading the track now resolves to that imported cover at the peek size.
        let resolution =
            prepare_resolution(&conn, &covers.path, track_id, DETAIL_EDGE, false).unwrap();
        match resolution {
            Resolution::Folder(cover) => {
                assert_eq!(cover.source, CoverSource::Imported);
                assert_eq!(cover.path, detail_path);
                assert_eq!((cover.width, cover.height), (64, 48));
                assert!(Path::new(&cover.path).exists(), "the cached thumb exists");
            }
            _ => panic!("expected the imported folder cover to resolve"),
        }
    }

    #[test]
    fn import_folder_cover_by_path_binds_and_resolves() {
        let conn = db::open_in_memory().unwrap();
        let covers = TempDir::new("covers");
        let music = TempDir::new("music");
        let guard = InFlightGuard::default();

        // The track is stored under its folded source path, as the scan writes it, so its folder
        // resolves the same way the by-path bind folds the folder string.
        let real_source = music.path.join("song.mp3").to_string_lossy().into_owned();
        let track_id = insert_track(&conn, &normalize_path_key(&real_source));
        let folder_path = music.path.to_string_lossy().into_owned();

        let picked = covers.path.join("picked.png");
        std::fs::write(&picked, png_bytes(64, 48, [12, 34, 56])).unwrap();

        // Mirror the command: fold the folder path, import off-disk, then bind under the lock.
        let folder = normalize_path_key(&folder_path);
        let (record, detail_path, _, _) =
            import_from_disk(&covers.path, &guard, &picked.to_string_lossy(), 100).unwrap();
        let cover_id = db::upsert_cover(&conn, &record).unwrap();
        db::set_folder_cover(&conn, &folder, cover_id, 100).unwrap();

        // The track in that folder now resolves to the imported cover, so the by-path key matched.
        match prepare_resolution(&conn, &covers.path, track_id, DETAIL_EDGE, false).unwrap() {
            Resolution::Folder(cover) => {
                assert_eq!(cover.source, CoverSource::Imported);
                assert_eq!(cover.path, detail_path);
            }
            _ => panic!("expected the by-path folder cover to resolve"),
        }
    }

    #[test]
    fn keep_own_cover_prefers_the_tracks_own_art_over_the_folder_cover() {
        let conn = db::open_in_memory().unwrap();
        let covers = TempDir::new("covers");
        let music = TempDir::new("music");
        let guard = InFlightGuard::default();

        // The track has its own adjacent art on disk, and a folder cover is bound over the whole folder.
        std::fs::write(music.path.join("cover.jpg"), png_bytes(50, 50, [20, 160, 90])).unwrap();
        let source_path = music.path.join("song.mp3").to_string_lossy().into_owned();
        let track_id = insert_track(&conn, &source_path);

        let picked = covers.path.join("picked.png");
        std::fs::write(&picked, png_bytes(64, 64, [40, 40, 200])).unwrap();
        let (record, _, _, _) =
            import_from_disk(&covers.path, &guard, &picked.to_string_lossy(), 100).unwrap();
        let cover_id = db::upsert_cover(&conn, &record).unwrap();
        db::set_folder_cover(&conn, &folder_of(&source_path), cover_id, 100).unwrap();

        // Without keep-own, the folder cover wins for the member (the shared-folder behavior).
        assert!(matches!(
            prepare_resolution(&conn, &covers.path, track_id, DETAIL_EDGE, false).unwrap(),
            Resolution::Folder(_)
        ));

        // With keep-own, the folder cover steps aside: the track resolves to its own adjacent art,
        // holding the folder cover only as the fallback.
        let Resolution::Dynamic {
            source_path: sp,
            has_embedded,
            fallback,
        } = prepare_resolution(&conn, &covers.path, track_id, DETAIL_EDGE, true).unwrap()
        else {
            panic!("expected keep-own to resolve dynamically");
        };
        assert!(fallback.is_some(), "the folder cover is kept as the fallback");
        let own = generate_dynamic_ref(&covers.path, &guard, &sp, has_embedded, DETAIL_EDGE)
            .expect("the track's own adjacent art resolves");
        assert_eq!(
            own.source,
            CoverSource::Adjacent,
            "the track's own art wins over the folder cover"
        );
    }

    #[test]
    fn keep_own_cover_falls_back_to_the_folder_cover_without_own_art() {
        let conn = db::open_in_memory().unwrap();
        let covers = TempDir::new("covers");
        let music = TempDir::new("music");
        let guard = InFlightGuard::default();

        // No art of its own next to the track; only a bound folder cover.
        let source_path = music.path.join("song.mp3").to_string_lossy().into_owned();
        let track_id = insert_track(&conn, &source_path);
        let picked = covers.path.join("picked.png");
        std::fs::write(&picked, png_bytes(64, 64, [10, 10, 10])).unwrap();
        let (record, _, _, _) =
            import_from_disk(&covers.path, &guard, &picked.to_string_lossy(), 100).unwrap();
        let cover_id = db::upsert_cover(&conn, &record).unwrap();
        db::set_folder_cover(&conn, &folder_of(&source_path), cover_id, 100).unwrap();

        let Resolution::Dynamic {
            source_path: sp,
            has_embedded,
            fallback,
        } = prepare_resolution(&conn, &covers.path, track_id, DETAIL_EDGE, true).unwrap()
        else {
            panic!("expected a dynamic resolution");
        };
        // The dynamic probe finds no own art, so the folder cover stands in as the fallback.
        assert!(generate_dynamic_ref(&covers.path, &guard, &sp, has_embedded, DETAIL_EDGE).is_none());
        let fallback = fallback.expect("the folder cover is the fallback");
        assert_eq!(fallback.source, CoverSource::Imported);
    }

    #[test]
    fn per_track_cover_wins_over_the_folder_cover_and_keep_own() {
        let mut conn = db::open_in_memory().unwrap();
        let covers = TempDir::new("covers");
        let music = TempDir::new("music");
        let guard = InFlightGuard::default();

        // The track has its own adjacent art, a folder cover bound over the folder, and its own
        // assigned cover on top - three sources the per-track choice must beat.
        std::fs::write(music.path.join("cover.jpg"), png_bytes(50, 50, [20, 160, 90])).unwrap();
        let source_path = music.path.join("song.mp3").to_string_lossy().into_owned();
        let track_id = insert_track(&conn, &source_path);

        let folder_pick = covers.path.join("folder.png");
        std::fs::write(&folder_pick, png_bytes(64, 64, [40, 40, 200])).unwrap();
        let (folder_rec, _, _, _) =
            import_from_disk(&covers.path, &guard, &folder_pick.to_string_lossy(), 100).unwrap();
        let folder_cover_id = db::upsert_cover(&conn, &folder_rec).unwrap();
        db::set_folder_cover(&conn, &folder_of(&source_path), folder_cover_id, 100).unwrap();

        let track_pick = covers.path.join("assigned.png");
        std::fs::write(&track_pick, png_bytes(70, 30, [200, 200, 10])).unwrap();
        let (track_rec, track_detail, tw, th) =
            import_from_disk(&covers.path, &guard, &track_pick.to_string_lossy(), 100).unwrap();
        let track_cover_id = db::upsert_cover(&conn, &track_rec).unwrap();
        db::set_track_cover(&mut conn, &[track_id], track_cover_id, 100).unwrap();
        assert_eq!((tw, th), (70, 30));

        // Without keep-own, the per-track cover wins over the bound folder cover.
        match prepare_resolution(&conn, &covers.path, track_id, DETAIL_EDGE, false).unwrap() {
            Resolution::Folder(cover) => {
                assert_eq!(cover.source, CoverSource::Imported);
                assert_eq!(
                    cover.path, track_detail,
                    "the per-track cover resolves, not the folder cover"
                );
                assert_eq!((cover.width, cover.height), (70, 30));
            }
            _ => panic!("expected the per-track cover to resolve"),
        }

        // With keep-own, the per-track cover still wins over the track's own adjacent art.
        match prepare_resolution(&conn, &covers.path, track_id, DETAIL_EDGE, true).unwrap() {
            Resolution::Folder(cover) => {
                assert_eq!(cover.path, track_detail, "the per-track cover beats keep-own too");
            }
            _ => panic!("expected the per-track cover to win over keep-own"),
        }
    }

    #[test]
    fn remove_falls_back_to_adjacent_art() {
        let conn = db::open_in_memory().unwrap();
        let covers = TempDir::new("covers");
        let music = TempDir::new("music");
        let guard = InFlightGuard::default();

        // An adjacent cover sits next to the track on disk.
        std::fs::write(
            music.path.join("cover.jpg"),
            png_bytes(50, 50, [20, 160, 90]),
        )
        .unwrap();
        let source_path = music.path.join("song.mp3").to_string_lossy().into_owned();
        let track_id = insert_track(&conn, &source_path);

        // Import a folder cover, which wins while it is set.
        let picked = covers.path.join("picked.png");
        std::fs::write(&picked, png_bytes(64, 64, [40, 40, 200])).unwrap();
        let (record, _, _, _) =
            import_from_disk(&covers.path, &guard, &picked.to_string_lossy(), 100).unwrap();
        let cover_id = db::upsert_cover(&conn, &record).unwrap();
        db::set_folder_cover(&conn, &folder_of(&source_path), cover_id, 100).unwrap();
        assert!(matches!(
            prepare_resolution(&conn, &covers.path, track_id, DETAIL_EDGE, false).unwrap(),
            Resolution::Folder(_)
        ));

        // Removing it drops back to the adjacent image.
        db::remove_folder_cover(&conn, &folder_of(&source_path)).unwrap();
        let resolution =
            prepare_resolution(&conn, &covers.path, track_id, DETAIL_EDGE, false).unwrap();
        let Resolution::Dynamic {
            source_path: sp,
            has_embedded,
            ..
        } = resolution
        else {
            panic!("expected a dynamic resolution after removal");
        };
        let cover = generate_dynamic_ref(&covers.path, &guard, &sp, has_embedded, DETAIL_EDGE)
            .expect("the adjacent image resolves");
        assert_eq!(cover.source, CoverSource::Adjacent);
        assert!(Path::new(&cover.path).exists());
    }

    #[test]
    fn candidates_list_the_adjacent_image() {
        let covers = TempDir::new("covers");
        let music = TempDir::new("music");
        let guard = InFlightGuard::default();

        std::fs::write(music.path.join("folder.png"), png_bytes(30, 30, [1, 2, 3])).unwrap();
        let source_path = music.path.join("song.mp3").to_string_lossy().into_owned();

        let candidates = build_candidates(&covers.path, &guard, &source_path, false);
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].source, CoverSource::Adjacent);
        assert_eq!(
            candidates[0].origin_path.as_deref(),
            Some(music.path.join("folder.png").to_string_lossy().as_ref())
        );
        assert!(Path::new(&candidates[0].path).exists());
    }

    #[test]
    fn album_cover_resolves_its_bound_cover() {
        let mut conn = db::open_in_memory().unwrap();
        let covers = TempDir::new("covers");
        let guard = InFlightGuard::default();
        let track_id = insert_track(&conn, "/music/album/1.mp3");

        // Bind an imported cover to the album; import writes its thumbnail by hash at both sizes.
        let picked = covers.path.join("picked.png");
        std::fs::write(&picked, png_bytes(64, 64, [90, 20, 20])).unwrap();
        let (record, _, _, _) =
            import_from_disk(&covers.path, &guard, &picked.to_string_lossy(), 100).unwrap();
        let cover_id = db::upsert_cover(&conn, &record).unwrap();
        let album = db::create_album(
            &mut conn,
            Some("T".into()),
            None,
            None,
            None,
            Some(cover_id),
            &[track_id],
            "album",
            1,
        )
        .unwrap();

        match prepare_album_cover(&conn, &covers.path, album.id, DETAIL_EDGE).unwrap() {
            AlbumCover::Bound(cover) => {
                assert_eq!(cover.source, CoverSource::Imported);
                let expected = thumb_cache_path(&covers.path, &record.content_hash, DETAIL_EDGE);
                assert_eq!(cover.path, expected.to_string_lossy());
                assert!(Path::new(&cover.path).exists(), "the cached thumb exists");
            }
            _ => panic!("expected the bound album cover to resolve"),
        }
    }

    #[test]
    fn album_cover_falls_back_to_a_member_tracks_art() {
        let mut conn = db::open_in_memory().unwrap();
        let covers = TempDir::new("covers");
        let music = TempDir::new("music");
        let guard = InFlightGuard::default();

        // An adjacent image sits next to the member track on disk; the album has no cover of its own.
        std::fs::write(
            music.path.join("cover.jpg"),
            png_bytes(50, 50, [20, 160, 90]),
        )
        .unwrap();
        let source_path = music.path.join("song.mp3").to_string_lossy().into_owned();
        let track_id = insert_track(&conn, &source_path);
        let album = db::create_album(
            &mut conn,
            None,
            None,
            None,
            None,
            None,
            &[track_id],
            "album",
            1,
        )
        .unwrap();

        let decision = prepare_album_cover(&conn, &covers.path, album.id, DETAIL_EDGE).unwrap();
        let AlbumCover::FromTrack(member) = decision else {
            panic!("expected a member-track fallback");
        };
        assert_eq!(member, track_id);

        // That member's own resolution finds the adjacent image.
        let Resolution::Dynamic {
            source_path: sp,
            has_embedded,
            ..
        } = prepare_resolution(&conn, &covers.path, member, DETAIL_EDGE, false).unwrap()
        else {
            panic!("expected a dynamic resolution for the member track");
        };
        let cover = generate_dynamic_ref(&covers.path, &guard, &sp, has_embedded, DETAIL_EDGE)
            .expect("the adjacent image resolves");
        assert_eq!(cover.source, CoverSource::Adjacent);
        assert!(Path::new(&cover.path).exists());
    }

    #[test]
    fn import_stores_full_res_and_reads_it_back() {
        let conn = db::open_in_memory().unwrap();
        let covers = TempDir::new("covers");
        let guard = InFlightGuard::default();

        let picked = covers.path.join("picked.png");
        let original = png_bytes(64, 48, [200, 40, 40]);
        std::fs::write(&picked, &original).unwrap();

        let (record, _, _, _) =
            import_from_disk(&covers.path, &guard, &picked.to_string_lossy(), 100).unwrap();
        let cover_id = db::upsert_cover(&conn, &record).unwrap();

        let bytes = read_full_res(&conn, &covers.path, cover_id).unwrap();
        assert_eq!(
            bytes.as_deref(),
            Some(original.as_slice()),
            "the exact original bytes come back for embedding"
        );
    }

    #[test]
    fn read_full_res_rejects_a_corrupt_blob() {
        let conn = db::open_in_memory().unwrap();
        let covers = TempDir::new("covers");
        let guard = InFlightGuard::default();

        let picked = covers.path.join("picked.png");
        let original = png_bytes(64, 48, [10, 20, 30]);
        std::fs::write(&picked, &original).unwrap();
        let (record, _, _, _) =
            import_from_disk(&covers.path, &guard, &picked.to_string_lossy(), 100).unwrap();
        let cover_id = db::upsert_cover(&conn, &record).unwrap();

        // Same length so the byte-length pre-check passes; the hash mismatch is what rejects it.
        let blob = full_res_cache_path(&covers.path, &record.content_hash);
        std::fs::write(&blob, vec![0u8; original.len()]).unwrap();
        assert_eq!(read_full_res(&conn, &covers.path, cover_id).unwrap(), None);
    }

    #[test]
    fn backfill_stores_when_the_origin_is_present() {
        let conn = db::open_in_memory().unwrap();
        let covers = TempDir::new("covers");
        let origins = TempDir::new("origins");
        let guard = InFlightGuard::default();

        // An imported cover bound before the store existed: origin on disk, no blob yet.
        let origin = origins.path.join("art.png");
        let original = png_bytes(80, 60, [30, 90, 150]);
        std::fs::write(&origin, &original).unwrap();
        let record = normalize_cover(
            &original,
            80,
            60,
            CoverSourceKind::Imported,
            Some(origin.to_string_lossy().into_owned()),
            100,
        );
        let cover_id = db::upsert_cover(&conn, &record).unwrap();
        assert!(
            read_full_res(&conn, &covers.path, cover_id)
                .unwrap()
                .is_none(),
            "no blob before the backfill"
        );

        let pending = db::imported_full_res_origins(&conn).unwrap();
        backfill_full_res(&covers.path, &guard, &pending);

        let bytes = read_full_res(&conn, &covers.path, cover_id).unwrap();
        assert_eq!(bytes.as_deref(), Some(original.as_slice()));
    }

    #[test]
    fn backfill_leaves_a_missing_origin() {
        let conn = db::open_in_memory().unwrap();
        let covers = TempDir::new("covers");
        let guard = InFlightGuard::default();

        // The origin path points nowhere: nothing to copy, so the store stays empty.
        let original = png_bytes(40, 40, [1, 2, 3]);
        let record = normalize_cover(
            &original,
            40,
            40,
            CoverSourceKind::Imported,
            Some("/gone/art.png".to_string()),
            100,
        );
        let cover_id = db::upsert_cover(&conn, &record).unwrap();

        let pending = db::imported_full_res_origins(&conn).unwrap();
        backfill_full_res(&covers.path, &guard, &pending);

        assert_eq!(read_full_res(&conn, &covers.path, cover_id).unwrap(), None);
    }

    #[test]
    fn save_resolves_a_folder_cover_to_its_verbatim_bytes() {
        let conn = db::open_in_memory().unwrap();
        let covers = TempDir::new("covers");
        let music = TempDir::new("music");
        let guard = InFlightGuard::default();

        let source_path = music.path.join("song.mp3").to_string_lossy().into_owned();
        let track_id = insert_track(&conn, &source_path);

        // A picked image bound as the folder cover; the store keeps the original bytes.
        let picked = covers.path.join("picked.png");
        let original = png_bytes(64, 48, [200, 40, 40]);
        std::fs::write(&picked, &original).unwrap();
        let (record, _, _, _) =
            import_from_disk(&covers.path, &guard, &picked.to_string_lossy(), 100).unwrap();
        let cover_id = db::upsert_cover(&conn, &record).unwrap();
        db::set_folder_cover(&conn, &folder_of(&source_path), cover_id, 100).unwrap();

        let plan = prepare_save(&conn, track_id).unwrap();
        assert!(matches!(plan, SavePlan::Store { .. }));
        let bytes = resolve_full_res(&covers.path, &plan).expect("the stored blob resolves");
        assert_eq!(bytes, original, "the verbatim original bytes come back");
    }

    #[test]
    fn save_resolves_adjacent_art_to_its_file_bytes() {
        let conn = db::open_in_memory().unwrap();
        let covers = TempDir::new("covers");
        let music = TempDir::new("music");

        // An adjacent image sits next to the track; no folder cover is bound.
        let original = png_bytes(50, 50, [20, 160, 90]);
        std::fs::write(music.path.join("cover.jpg"), &original).unwrap();
        let source_path = music.path.join("song.mp3").to_string_lossy().into_owned();
        let track_id = insert_track(&conn, &source_path);

        let plan = prepare_save(&conn, track_id).unwrap();
        assert!(matches!(plan, SavePlan::Derive { .. }));
        let bytes = resolve_full_res(&covers.path, &plan).expect("the adjacent image resolves");
        assert_eq!(bytes, original, "the adjacent file is read verbatim");
    }

    #[test]
    fn image_ext_names_each_format_and_falls_back_to_jpg() {
        assert_eq!(image_ext(&[0xFF, 0xD8, 0xFF, 0xE0, 0x00]), "jpg");
        assert_eq!(
            image_ext(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00]),
            "png"
        );
        assert_eq!(image_ext(b"GIF87a...."), "gif");
        assert_eq!(image_ext(b"GIF89a...."), "gif");
        assert_eq!(image_ext(b"RIFF\0\0\0\0WEBPVP8 "), "webp");
        assert_eq!(image_ext(b"BM\0\0\0\0"), "bmp");

        // Unrecognized leading bytes and too-short input both settle on the safe default.
        assert_eq!(image_ext(b"\x00\x01\x02\x03"), "jpg");
        assert_eq!(image_ext(b"RI"), "jpg");
        assert_eq!(image_ext(&[]), "jpg");
    }

    #[test]
    fn list_folder_images_returns_only_images_sorted() {
        let folder = TempDir::new("folder_images");
        std::fs::write(folder.path.join("a.jpg"), b"x").unwrap();
        std::fs::write(folder.path.join("b.png"), b"x").unwrap();
        std::fs::write(folder.path.join("song.mp3"), b"x").unwrap();
        std::fs::write(folder.path.join("notes.txt"), b"x").unwrap();

        // The resolver reads the parent of the track's own file, so the folder is derived from it.
        let track_path = folder.path.join("song.mp3").to_string_lossy().into_owned();
        let images = folder_images(&track_path);

        let expected = vec![
            folder.path.join("a.jpg").to_string_lossy().into_owned(),
            folder.path.join("b.png").to_string_lossy().into_owned(),
        ];
        assert_eq!(images, expected);
    }

    #[test]
    fn save_yields_none_when_the_track_has_no_cover() {
        let conn = db::open_in_memory().unwrap();
        let covers = TempDir::new("covers");
        let music = TempDir::new("music");

        let source_path = music.path.join("song.mp3").to_string_lossy().into_owned();
        let track_id = insert_track(&conn, &source_path);

        let plan = prepare_save(&conn, track_id).unwrap();
        assert!(
            resolve_full_res(&covers.path, &plan).is_none(),
            "no art to save"
        );
    }

    #[test]
    fn cache_ad_hoc_cover_caches_an_adjacent_image_at_both_sizes() {
        let covers = TempDir::new("adhoc_covers");
        let music = TempDir::new("adhoc_music");
        let guard = InFlightGuard::default();

        // An adjacent image sits next to the file; the file itself carries no embedded art.
        std::fs::write(music.path.join("cover.jpg"), png_bytes(40, 30, [10, 120, 200])).unwrap();
        let source = music.path.join("song.mp3").to_string_lossy().into_owned();

        let cover = cache_ad_hoc_cover(&covers.path, &guard, &source).expect("the adjacent art caches");
        assert_eq!((cover.width, cover.height), (40, 30));
        // Both thumb sizes are warm on disk, so a later sentinel read never decodes.
        assert!(thumb_cache_path(&covers.path, &cover.hash, THUMB_EDGE).exists());
        assert!(thumb_cache_path(&covers.path, &cover.hash, DETAIL_EDGE).exists());
    }

    #[test]
    fn cache_ad_hoc_cover_is_none_without_art() {
        let covers = TempDir::new("adhoc_covers");
        let music = TempDir::new("adhoc_music");
        let guard = InFlightGuard::default();

        // No adjacent image and no readable embedded art: nothing to cache.
        let source = music.path.join("song.mp3").to_string_lossy().into_owned();
        assert!(cache_ad_hoc_cover(&covers.path, &guard, &source).is_none());
    }

    #[test]
    fn resolve_ad_hoc_cover_resolves_a_stashed_cover_at_both_sizes() {
        let covers = TempDir::new("adhoc_resolve_covers");
        let music = TempDir::new("adhoc_resolve_music");
        let guard = InFlightGuard::default();

        std::fs::write(music.path.join("folder.png"), png_bytes(64, 48, [200, 40, 40])).unwrap();
        let source = music.path.join("song.mp3").to_string_lossy().into_owned();
        let cover = cache_ad_hoc_cover(&covers.path, &guard, &source).unwrap();

        let state = AppState::for_test(db::open_in_memory().unwrap(), covers.path.clone());
        let id = crate::adhoc::next_ad_hoc_id();
        state.ad_hoc.lock().unwrap().insert(
            id,
            crate::adhoc::AdHocTrack {
                title: "T".to_string(),
                artist: None,
                cover: Some(cover.clone()),
            },
        );

        // The stash entry resolves to the cached thumb at each size, verbatim, no decode.
        let thumb = resolve_ad_hoc_cover(&state, id, THUMB_EDGE).expect("the thumb size resolves");
        assert_eq!(
            thumb.path,
            thumb_cache_path(&covers.path, &cover.hash, THUMB_EDGE).to_string_lossy()
        );
        assert_eq!((thumb.width, thumb.height), (64, 48));
        let detail = resolve_ad_hoc_cover(&state, id, DETAIL_EDGE).expect("the detail size resolves");
        assert_eq!(
            detail.path,
            thumb_cache_path(&covers.path, &cover.hash, DETAIL_EDGE).to_string_lossy()
        );

        // A negative id with no stash entry resolves to nothing rather than erroring.
        assert!(resolve_ad_hoc_cover(&state, -424_242, DETAIL_EDGE).is_none());
    }
}
