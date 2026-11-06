/*
 * The batched album cover command: one IPC resolves N albums in the order asked. Every decision
 * reads the DB under a single lock, then one blocking stage runs the decodes in parallel. A cover
 * served by hash (a bound album, track or folder cover) only has its 128 and 512 thumbs written at
 * import, so a missing grid thumb is derived from the 512 one here rather than returned as a dead path.
 */

// -- Library Imports --
use std::path::Path;
use std::sync::Arc;

use rayon::prelude::*;
use rusqlite::Connection;
use serde::Serialize;
use tauri::State;

// -- Local Imports --
use super::covers::{
    generate_dynamic, max_edge, path_to_string, prepare_album_cover, prepare_resolution,
    AlbumCover, Resolution, DETAIL_EDGE, GRID_EDGE,
};
use crate::covers::{ensure_thumb, thumb_cache_path, InFlightGuard};
use crate::db;
use crate::dto::{CoverRef, CoverSize};
use crate::model::ArtKey;
use crate::state::AppState;

/// One album's resolved cover, or None when it has no art or the id is unknown.
#[derive(Debug, Serialize)]
pub struct AlbumCoverEntry {
    pub album_id: i64,
    pub cover: Option<CoverRef>,
}

/// What the DB read decided for one album: a cover settled by hash, or a member track whose art
/// still needs a decode.
enum Plan {
    Settled(Option<CoverRef>),
    Dynamic {
        track_id: i64,
        source_path: String,
        has_embedded: bool,
        fallback: Option<CoverRef>,
        backfill: Option<(i64, i64)>,
    },
}

/// A decoded embedded-art key to write back against its row's file stamp.
type KeyWriteback = (i64, (i64, i64), ArtKey);

/// Resolves the covers of `album_ids` at the requested size, one entry per id in the order given.
#[tauri::command]
pub async fn album_covers(
    album_ids: Vec<i64>,
    size: CoverSize,
    state: State<'_, AppState>,
) -> Result<Vec<AlbumCoverEntry>, String> {
    resolve_albums(state.inner(), &album_ids, max_edge(size)).await
}

/// The batch core, shared with the album palette: plans every album under one lock, then runs the
/// decodes on a blocking thread and writes back any embedded-art keys it learned.
pub(super) async fn resolve_albums(
    state: &AppState,
    album_ids: &[i64],
    edge: u32,
) -> Result<Vec<AlbumCoverEntry>, String> {
    let plans = {
        let conn = state
            .db
            .lock()
            .map_err(|_| "index is unavailable".to_string())?;
        plan_albums(&conn, &state.covers_dir, album_ids, edge).map_err(|e| e.to_string())?
    };

    let covers_dir = state.covers_dir.clone();
    let guard = Arc::clone(&state.covers_in_flight);
    let resolved = tauri::async_runtime::spawn_blocking(move || {
        plans
            .into_par_iter()
            .map(|(album_id, plan)| {
                let (cover, writeback) = finish(plan, &covers_dir, &guard, edge);
                (AlbumCoverEntry { album_id, cover }, writeback)
            })
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|_| "cover task failed to run".to_string())?;

    let (entries, writebacks): (Vec<_>, Vec<_>) = resolved.into_iter().unzip();
    // Best-effort: a failed write leaves the key unknown and the next read tries again.
    if let Ok(conn) = state.db.lock() {
        for (track_id, (size_bytes, mtime), key) in writebacks.into_iter().flatten() {
            let _ = db::write_embedded_art_key(&conn, track_id, size_bytes, mtime, &key);
        }
    }
    Ok(entries)
}

/// Reads the DB to decide every album's cover at `edge`. A bound cover and a folder or track
/// cover settle here; a member's embedded or adjacent art is left for the blocking stage. An unknown
/// id plans as no cover. Sync: touches only the connection and cache paths.
fn plan_albums(
    conn: &Connection,
    covers_dir: &Path,
    album_ids: &[i64],
    edge: u32,
) -> rusqlite::Result<Vec<(i64, Plan)>> {
    let mut plans = Vec::with_capacity(album_ids.len());
    for &album_id in album_ids {
        let plan = match prepare_album_cover(conn, covers_dir, album_id, edge)? {
            AlbumCover::None => Plan::Settled(None),
            AlbumCover::Bound(cover) => Plan::Settled(Some(cover)),
            AlbumCover::FromTrack(track_id) => {
                match prepare_resolution(conn, covers_dir, track_id, edge, false)? {
                    Resolution::None => Plan::Settled(None),
                    Resolution::Folder(cover) | Resolution::Embedded(cover) => {
                        Plan::Settled(Some(cover))
                    }
                    Resolution::Dynamic {
                        source_path,
                        has_embedded,
                        fallback,
                        backfill,
                    } => Plan::Dynamic {
                        track_id,
                        source_path,
                        has_embedded,
                        fallback,
                        backfill,
                    },
                }
            }
        };
        plans.push((album_id, plan));
    }
    Ok(plans)
}

/// Turns one plan into its cover: a settled cover is checked for its file, a dynamic one decodes.
fn finish(
    plan: Plan,
    covers_dir: &Path,
    guard: &InFlightGuard,
    edge: u32,
) -> (Option<CoverRef>, Option<KeyWriteback>) {
    match plan {
        Plan::Settled(cover) => (
            cover.and_then(|c| ensure_edge(c, covers_dir, guard, edge)),
            None,
        ),
        Plan::Dynamic {
            track_id,
            source_path,
            has_embedded,
            fallback,
            backfill,
        } => {
            let generated = generate_dynamic(covers_dir, guard, &source_path, has_embedded, edge);
            let writeback = match (&generated, backfill) {
                (Some((_, Some(key))), Some(stamp)) => Some((track_id, stamp, key.clone())),
                _ => None,
            };
            // Own art wins; the folder cover stands in only when the member has none.
            let cover = generated.map(|(own, _)| own).or(fallback);
            (cover, writeback)
        }
    }
}

/// Makes sure a hash-served cover's file exists at `edge`. Only the grid size can be missing: it is
/// derived from the 512 thumb of the same hash. None when neither file is there, so the card shows
/// its placeholder instead of a dead path.
fn ensure_edge(
    cover: CoverRef,
    covers_dir: &Path,
    guard: &InFlightGuard,
    edge: u32,
) -> Option<CoverRef> {
    if edge != GRID_EDGE || Path::new(&cover.path).exists() {
        return Some(cover);
    }
    let stem = Path::new(&cover.path).file_stem()?.to_str()?;
    let hash = stem.strip_suffix(&format!("_{GRID_EDGE}"))?;
    let detail = std::fs::read(thumb_cache_path(covers_dir, hash, DETAIL_EDGE)).ok()?;
    let path = ensure_thumb(covers_dir, hash, &detail, GRID_EDGE, guard).ok()?;
    Some(CoverRef {
        path: path_to_string(&path),
        ..cover
    })
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    use image::{DynamicImage, ImageFormat, Rgb, RgbImage};

    use super::*;
    use crate::commands::covers::import_from_disk;

    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new(tag: &str) -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir()
                .join(format!("plisto_albcov_{tag}_{}_{n}", std::process::id()));
            std::fs::create_dir_all(&path).unwrap();
            Self { path }
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    fn png_bytes(width: u32, height: u32, colour: [u8; 3]) -> Vec<u8> {
        let img = RgbImage::from_pixel(width, height, Rgb(colour));
        let mut buf = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(img)
            .write_to(&mut buf, ImageFormat::Png)
            .unwrap();
        buf.into_inner()
    }

    fn insert_track(conn: &Connection, source_path: &str) -> i64 {
        conn.execute(
            "INSERT INTO tracks (source_path, filename, ext, size_bytes, mtime, has_embedded_cover, scanned_at)
             VALUES (?1, 'song.mp3', 'mp3', 10, 20, 0, 30)",
            rusqlite::params![source_path],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    fn make_album(conn: &mut Connection, cover_id: Option<i64>, track_id: i64) -> i64 {
        db::create_album(
            conn,
            Some("T".into()),
            None,
            None,
            None,
            cover_id,
            &[track_id],
            "album",
            1,
        )
        .unwrap()
        .id
    }

    /// Plans and finishes every album the way the command does, minus the async hop.
    fn run(conn: &Connection, covers_dir: &Path, ids: &[i64], edge: u32) -> Vec<AlbumCoverEntry> {
        let guard = InFlightGuard::default();
        plan_albums(conn, covers_dir, ids, edge)
            .unwrap()
            .into_iter()
            .map(|(album_id, plan)| AlbumCoverEntry {
                album_id,
                cover: finish(plan, covers_dir, &guard, edge).0,
            })
            .collect()
    }

    #[test]
    fn batch_keeps_order_and_gives_unknown_ids_no_cover() {
        let mut conn = db::open_in_memory().unwrap();
        let covers = TempDir::new("order");
        let music = TempDir::new("order_music");
        std::fs::write(
            music.path.join("cover.png"),
            png_bytes(40, 40, [10, 90, 20]),
        )
        .unwrap();
        let source = music.path.join("song.mp3").to_string_lossy().into_owned();
        let track = insert_track(&conn, &source);
        let real = make_album(&mut conn, None, track);

        let entries = run(&conn, &covers.path, &[9999, real, 9998, real], GRID_EDGE);
        let ids: Vec<i64> = entries.iter().map(|e| e.album_id).collect();
        assert_eq!(ids, vec![9999, real, 9998, real]);
        assert!(entries[0].cover.is_none() && entries[2].cover.is_none());
        let first = entries[1].cover.as_ref().expect("the member art resolves");
        assert!(Path::new(&first.path).exists());
        assert_eq!(entries[3].cover.as_ref().unwrap().path, first.path);
    }

    #[test]
    fn bound_cover_derives_its_grid_thumb_from_the_detail_one() {
        let mut conn = db::open_in_memory().unwrap();
        let covers = TempDir::new("grid");
        let guard = InFlightGuard::default();
        let track = insert_track(&conn, "/music/a/1.mp3");

        let picked = covers.path.join("picked.png");
        std::fs::write(&picked, png_bytes(900, 900, [90, 20, 20])).unwrap();
        let (record, _, _, _) =
            import_from_disk(&covers.path, &guard, &picked.to_string_lossy(), 100).unwrap();
        let cover_id = db::upsert_cover(&conn, &record).unwrap();
        let album = make_album(&mut conn, Some(cover_id), track);

        let grid = thumb_cache_path(&covers.path, &record.content_hash, GRID_EDGE);
        assert!(!grid.exists(), "import writes no grid thumb");

        let entries = run(&conn, &covers.path, &[album], GRID_EDGE);
        let cover = entries[0].cover.as_ref().expect("the bound cover resolves");
        assert_eq!(cover.path, grid.to_string_lossy());
        let decoded = image::open(&grid).unwrap();
        assert_eq!(decoded.width().max(decoded.height()), GRID_EDGE);

        let detail = run(&conn, &covers.path, &[album], DETAIL_EDGE);
        assert!(Path::new(&detail[0].cover.as_ref().unwrap().path).exists());
    }

    #[test]
    fn bound_cover_with_no_files_resolves_to_none_at_grid() {
        let mut conn = db::open_in_memory().unwrap();
        let covers = TempDir::new("gone");
        let guard = InFlightGuard::default();
        let track = insert_track(&conn, "/music/a/1.mp3");
        let picked = covers.path.join("picked.png");
        std::fs::write(&picked, png_bytes(64, 64, [1, 2, 3])).unwrap();
        let (record, _, _, _) =
            import_from_disk(&covers.path, &guard, &picked.to_string_lossy(), 100).unwrap();
        let cover_id = db::upsert_cover(&conn, &record).unwrap();
        let album = make_album(&mut conn, Some(cover_id), track);
        std::fs::remove_file(thumb_cache_path(
            &covers.path,
            &record.content_hash,
            DETAIL_EDGE,
        ))
        .unwrap();

        let entries = run(&conn, &covers.path, &[album], GRID_EDGE);
        assert!(entries[0].cover.is_none());
    }
}
