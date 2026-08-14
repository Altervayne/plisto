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
use crate::covers::{
    discover_adjacent_images, ensure_thumb, normalize_cover, read_embedded_cover_bytes,
    read_image_dimensions, resolve_track_cover, thumb_cache_path, CoverSourceKind, InFlightGuard,
    ResolvedCover,
};
use crate::db;
use crate::dto::{CoverCandidate, CoverRef, CoverSize, CoverSource};
use crate::model::CoverRecord;
use crate::state::AppState;

// The bounded longest edge for each requested size. The small size feeds the candidate list; the
// large one is the peek cover, big enough to scale cleanly on a HiDPI display.
const THUMB_EDGE: u32 = 128;
const DETAIL_EDGE: u32 = 512;

/// Resolves a track's single cover at the requested size, generating the thumbnail on a miss.
/// Returns None when the track has no art from any source.
#[tauri::command]
pub async fn read_cover(
    track_id: i64,
    size: CoverSize,
    state: State<'_, AppState>,
) -> Result<Option<CoverRef>, String> {
    resolve_at(state.inner(), track_id, max_edge(size)).await
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

    resolve_at(state.inner(), track_id, DETAIL_EDGE).await
}

// ---- Resolution ----

/// The outcome of reading the DB for a track's cover: nothing, a folder cover served straight
/// from its cached thumbnail, or a source that still needs a decode off the runtime thread.
enum Resolution {
    None,
    Folder(CoverRef),
    Dynamic { source_path: String, has_embedded: bool },
}

/// Reads the DB to decide a track's cover at `max_edge`. A folder cover resolves fully here (its
/// thumbnail already exists by hash, no decode); otherwise the embedded/adjacent decode is left
/// to the caller's blocking stage. Sync: touches only the connection and a cache path.
fn prepare_resolution(
    conn: &Connection,
    covers_dir: &Path,
    track_id: i64,
    max_edge: u32,
) -> rusqlite::Result<Resolution> {
    let Some((source_path, art)) = db::get_track_cover_inputs(conn, track_id)? else {
        return Ok(Resolution::None);
    };

    let folder = folder_of(&source_path);
    if let Some(cover_id) = db::get_folder_cover(conn, &folder)? {
        if let Some((hash, kind, width, height)) = db::get_cover(conn, cover_id)? {
            let path = thumb_cache_path(covers_dir, &hash, max_edge);
            return Ok(Resolution::Folder(CoverRef {
                path: path_to_string(&path),
                width,
                height,
                source: cover_source_from_kind(&kind),
            }));
        }
    }

    Ok(Resolution::Dynamic {
        source_path,
        has_embedded: art == Some(true),
    })
}

/// Resolves a track's cover, running any decode on a blocking thread. Shared by read_cover and
/// the fallback path of remove_folder_cover.
async fn resolve_at(
    state: &AppState,
    track_id: i64,
    max_edge: u32,
) -> Result<Option<CoverRef>, String> {
    let resolution = {
        let conn = state
            .db
            .lock()
            .map_err(|_| "index is unavailable".to_string())?;
        prepare_resolution(&conn, &state.covers_dir, track_id, max_edge).map_err(|e| e.to_string())?
    };

    match resolution {
        Resolution::None => Ok(None),
        Resolution::Folder(cover) => Ok(Some(cover)),
        Resolution::Dynamic {
            source_path,
            has_embedded,
        } => {
            let covers_dir = state.covers_dir.clone();
            let guard = Arc::clone(&state.covers_in_flight);
            tauri::async_runtime::spawn_blocking(move || {
                generate_dynamic_ref(&covers_dir, &guard, &source_path, has_embedded, max_edge)
            })
            .await
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

    Ok((record, path_to_string(&detail), width as i64, height as i64))
}

// ---- Shared helpers ----

/// The requested size mapped to its bounded longest edge in pixels.
fn max_edge(size: CoverSize) -> u32 {
    match size {
        CoverSize::Thumb => THUMB_EDGE,
        CoverSize::Detail => DETAIL_EDGE,
    }
}

/// The folder a track belongs to: the parent directory of its source path. Written and read the
/// same way, so a folder cover set on import resolves back on read.
pub(super) fn folder_of(source_path: &str) -> String {
    Path::new(source_path)
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
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
            let path = std::env::temp_dir()
                .join(format!("plisto_cmd_{tag}_{}_{n}_{nanos}", std::process::id()));
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
            prepare_resolution(&conn, &covers.path, track_id, DETAIL_EDGE).unwrap();
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
    fn remove_falls_back_to_adjacent_art() {
        let conn = db::open_in_memory().unwrap();
        let covers = TempDir::new("covers");
        let music = TempDir::new("music");
        let guard = InFlightGuard::default();

        // An adjacent cover sits next to the track on disk.
        std::fs::write(music.path.join("cover.jpg"), png_bytes(50, 50, [20, 160, 90])).unwrap();
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
            prepare_resolution(&conn, &covers.path, track_id, DETAIL_EDGE).unwrap(),
            Resolution::Folder(_)
        ));

        // Removing it drops back to the adjacent image.
        db::remove_folder_cover(&conn, &folder_of(&source_path)).unwrap();
        let resolution =
            prepare_resolution(&conn, &covers.path, track_id, DETAIL_EDGE).unwrap();
        let Resolution::Dynamic {
            source_path: sp,
            has_embedded,
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
            Some(
                music
                    .path
                    .join("folder.png")
                    .to_string_lossy()
                    .as_ref()
            )
        );
        assert!(Path::new(&candidates[0].path).exists());
    }
}
