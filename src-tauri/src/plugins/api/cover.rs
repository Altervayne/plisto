/*
 * `library.cover`: the cover Plisto shows for a track, album or playlist, at one of its three cached
 * sizes, as a `data:` URL. It goes through the same cover pipeline as the app's own grids, so the
 * cache file it reads is never named: only its bytes leave, and only up to a size cap.
 */

// -- Library Imports --
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::{json, Map, Value};

// -- Local Imports --
use super::error::ApiError;
use super::library::{app_state, db, id_arg, with_conn};
use super::library_rows::{album, playlist, track_keeps_own_cover};
use super::rate::RateClass;
use super::{CallCtx, MethodSpec, Need, Outcome};
use crate::commands::album_covers::{finish, plan_albums, plan_track, Plan};
use crate::commands::covers::{max_edge, prepare_playlist_cover};
use crate::db as library_db;
use crate::dto::CoverSize;
use crate::plugins::manifest::Capability;

/// The largest cached image a plugin is sent, before base64.
pub const MAX_COVER_BYTES: usize = 262_144;

pub(super) const METHODS: &[MethodSpec] = &[MethodSpec {
    name: "library.cover",
    need: Need::Cap(Capability::LibraryRead),
    class: RateClass::Cover,
    run: cover,
}];

#[derive(Clone, Copy)]
enum Kind {
    Track,
    Album,
    Playlist,
}

fn kind_arg(args: &Map<String, Value>) -> Result<Kind, ApiError> {
    match args.get("kind").and_then(Value::as_str) {
        Some("track") => Ok(Kind::Track),
        Some("album") => Ok(Kind::Album),
        Some("playlist") => Ok(Kind::Playlist),
        _ => Err(ApiError::invalid_args(
            "'kind' must be \"track\", \"album\" or \"playlist\".",
        )),
    }
}

fn size_arg(args: &Map<String, Value>) -> Result<CoverSize, ApiError> {
    args.get("size")
        .and_then(|v| serde_json::from_value::<CoverSize>(v.clone()).ok())
        .ok_or_else(|| ApiError::invalid_args("'size' must be \"thumb\", \"grid\" or \"detail\"."))
}

fn cover(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Outcome {
    Outcome::Done(read_cover(ctx, args))
}

fn read_cover(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Result<Value, ApiError> {
    let kind = kind_arg(args)?;
    let id = id_arg(args)?;
    let edge = max_edge(size_arg(args)?);
    let app = app_state(ctx)?;
    let covers_dir = &app.covers_dir;
    let plan = with_conn(ctx, |conn| match kind {
        Kind::Track => {
            let keep_own = db(track_keeps_own_cover(conn, id))?.ok_or_else(ApiError::not_found)?;
            db(plan_track(conn, covers_dir, id, edge, keep_own))
        }
        Kind::Album => {
            db(album(conn, id))?.ok_or_else(ApiError::not_found)?;
            let mut plans = db(plan_albums(conn, covers_dir, &[id], edge))?;
            plans
                .pop()
                .map(|(_, plan)| plan)
                .ok_or_else(ApiError::not_found)
        }
        Kind::Playlist => {
            db(playlist(conn, id))?.ok_or_else(ApiError::not_found)?;
            db(prepare_playlist_cover(conn, covers_dir, id, edge)).map(Plan::Settled)
        }
    })?;
    // The decode runs with the database unlocked.
    let (found, writeback) = finish(plan, covers_dir, &app.covers_in_flight, edge);
    if let Some((track_id, (size_bytes, mtime), key)) = writeback {
        // Best-effort, as in the app's own cover reads.
        if let Ok(conn) = app.db.lock() {
            let _ = library_db::write_embedded_art_key(&conn, track_id, size_bytes, mtime, &key);
        }
    }
    let bytes = found.and_then(|cover| std::fs::read(cover.path).ok());
    let Some(bytes) = bytes.filter(|b| b.starts_with(&[0xFF, 0xD8, 0xFF])) else {
        return Ok(json!({ "data_url": null }));
    };
    if bytes.len() > MAX_COVER_BYTES {
        return Err(ApiError::too_large("The cover is over 262144 bytes."));
    }
    let url = format!("data:image/jpeg;base64,{}", STANDARD.encode(bytes));
    Ok(json!({ "data_url": url }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::api::error::ApiCode;
    use crate::plugins::api::test_rig::{insert_track, mark_gone, Rig};
    use crate::plugins::stage::Temp;
    use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
    use std::io::Cursor;
    use std::path::Path;

    fn png(edge: u32) -> Vec<u8> {
        let img = RgbImage::from_pixel(edge, edge, Rgb([200, 40, 40]));
        let mut buf = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(img)
            .write_to(&mut buf, ImageFormat::Png)
            .unwrap();
        buf.into_inner()
    }

    fn code(result: Result<Value, ApiError>) -> ApiCode {
        result.unwrap_err().code
    }

    /// A track in `music` with a `cover.png` beside it, filed into an album.
    fn stock(rig: &Rig, music: &Path) -> (i64, i64) {
        std::fs::write(music.join("cover.png"), png(600)).unwrap();
        let path = music.join("song.mp3").to_string_lossy().into_owned();
        let mut conn = rig.conn();
        let track = insert_track(&conn, &path, "Song", "Artist");
        let album = library_db::create_album(
            &mut conn,
            Some("Record".into()),
            None,
            None,
            None,
            None,
            &[track],
            "album",
            1,
        )
        .unwrap()
        .id;
        (track, album)
    }

    #[test]
    fn covers_come_back_as_jpeg_data_urls_at_each_size() {
        let covers = Temp::new("api-cover");
        let music = Temp::new("api-cover-music");
        let rig = Rig::with_covers(&[Capability::LibraryRead], covers.0.clone());
        let (track, album) = stock(&rig, &music.0);
        for (kind, id) in [("track", track), ("album", album)] {
            for size in ["thumb", "grid", "detail"] {
                let reply = rig
                    .call(
                        "library.cover",
                        json!({ "kind": kind, "id": id, "size": size }),
                    )
                    .unwrap();
                let url = reply["data_url"].as_str().unwrap();
                assert!(
                    url.starts_with("data:image/jpeg;base64,/9j/"),
                    "{kind} {size}"
                );
                let text = reply.to_string();
                let covers_dir = covers.0.to_string_lossy();
                assert!(!text.contains(&*covers_dir) && !text.contains("\\"));
            }
        }
        // A playlist shows only a cover the user set.
        let list = library_db::create_playlist(&rig.conn(), None, 1)
            .unwrap()
            .id;
        let reply = rig
            .call(
                "library.cover",
                json!({ "kind": "playlist", "id": list, "size": "grid" }),
            )
            .unwrap();
        assert_eq!(reply, json!({ "data_url": null }));
    }

    #[test]
    fn unknown_and_gone_targets_are_not_found() {
        let covers = Temp::new("api-cover");
        let music = Temp::new("api-cover-music");
        let rig = Rig::with_covers(&[Capability::LibraryRead], covers.0.clone());
        let (track, _) = stock(&rig, &music.0);
        mark_gone(&rig.conn(), track);
        for (kind, id) in [
            ("track", track),
            ("track", 999),
            ("album", 999),
            ("playlist", 999),
        ] {
            let result = rig.call(
                "library.cover",
                json!({ "kind": kind, "id": id, "size": "thumb" }),
            );
            assert_eq!(code(result), ApiCode::NotFound, "{kind} {id}");
        }
        for bad in [
            json!({ "kind": "folder", "id": 1, "size": "thumb" }),
            json!({ "kind": "track", "id": 1, "size": "full" }),
            json!({ "kind": "track", "id": "1", "size": "thumb" }),
            json!({ "kind": "track", "id": 1 }),
        ] {
            assert_eq!(
                code(rig.call("library.cover", bad.clone())),
                ApiCode::InvalidArgs,
                "{bad}"
            );
        }
    }

    #[test]
    fn a_track_with_no_art_has_no_cover() {
        let covers = Temp::new("api-cover");
        let music = Temp::new("api-cover-music");
        let rig = Rig::with_covers(&[Capability::LibraryRead], covers.0.clone());
        let path = music.0.join("bare.mp3").to_string_lossy().into_owned();
        let track = insert_track(&rig.conn(), &path, "Bare", "A");
        let reply = rig
            .call(
                "library.cover",
                json!({ "kind": "track", "id": track, "size": "detail" }),
            )
            .unwrap();
        assert_eq!(reply, json!({ "data_url": null }));
    }

    #[test]
    fn a_cover_needs_the_library_grant() {
        let rig = Rig::new(&[Capability::PlaybackRead]);
        let args = json!({ "kind": "track", "id": 1, "size": "thumb" });
        assert_eq!(code(rig.call("library.cover", args)), ApiCode::Denied);
    }
}
