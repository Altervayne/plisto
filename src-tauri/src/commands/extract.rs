/*
 * The IPC command surface for the filename extractor: read a selection's paths through the same
 * `display_path ?? source_path` the export planner uses, run each against a pattern compiled once,
 * and either preview the recovered fields or write the chosen ones into the edit layer. Preview is
 * read-only and holds the DB lock only long enough to fetch paths, parsing off the lock. Apply
 * reuses the existing edit writers verbatim - set_track_edit for the metadata overlay, the genre
 * get-or-create plus set_track_genres for an appended genre, set_album_layout for a member's
 * album-scoped position - so it invents no write path of its own.
 */

// -- Library Imports --
use std::collections::HashMap;

use rusqlite::Connection;
use tauri::State;

// -- Local Imports --
use crate::db;
use crate::dto::{ExtractResult, ExtractRow, ExtractedFields};
use crate::export::extract::{self, ParsedFields};
use crate::state::AppState;

/// Previews the fields the pattern recovers from each track's path, in the given id order. The
/// pattern compiles once; a malformed pattern is rejected before any track is read. The DB lock is
/// held only to fetch the paths, then released so the parsing runs off it. A track that does not
/// match, or whose id is unknown, comes back with `matched: false` and empty fields.
#[tauri::command]
pub fn extract_preview(
    pattern: String,
    track_ids: Vec<i64>,
    state: State<'_, AppState>,
) -> Result<Vec<ExtractRow>, String> {
    let compiled = extract::compile(&pattern).ok_or_else(|| "the pattern is malformed".to_string())?;

    let paths = {
        let conn = state
            .db
            .lock()
            .map_err(|_| "index is unavailable".to_string())?;
        db::load_track_export_paths(&conn, &track_ids).map_err(|e| e.to_string())?
    };
    let by_id: HashMap<i64, String> = paths.into_iter().collect();

    let rows = track_ids
        .iter()
        .map(|&track_id| {
            match by_id.get(&track_id).and_then(|p| extract::parse(&compiled, p)) {
                Some(fields) => ExtractRow {
                    track_id,
                    matched: true,
                    fields: to_dto(fields),
                },
                None => ExtractRow {
                    track_id,
                    matched: false,
                    fields: ExtractedFields::default(),
                },
            }
        })
        .collect();
    Ok(rows)
}

/// Writes the extracted fields named in `apply_fields` into the edit layer for each matched track.
/// The pattern compiles once. Only enabled fields that the parse actually recovered are written, and
/// each is overlaid onto the track's current values, never clearing a field the user did not extract.
/// A track number lands only on an album member; on a loose track it is skipped and counted. Every
/// write reuses an existing writer under one held lock, so the batch is one consistent writer.
#[tauri::command]
pub fn extract_apply(
    pattern: String,
    track_ids: Vec<i64>,
    apply_fields: Vec<String>,
    state: State<'_, AppState>,
) -> Result<ExtractResult, String> {
    let compiled = extract::compile(&pattern).ok_or_else(|| "the pattern is malformed".to_string())?;
    let want = FieldSet::from_names(&apply_fields);

    let mut conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    let by_id: HashMap<i64, String> = db::load_track_export_paths(&conn, &track_ids)
        .map_err(|e| e.to_string())?
        .into_iter()
        .collect();

    let mut result = ExtractResult {
        applied: 0,
        unmatched: 0,
        track_no_skipped_loose: 0,
    };
    for &track_id in &track_ids {
        let parsed = by_id
            .get(&track_id)
            .and_then(|p| extract::parse(&compiled, p));
        let Some(fields) = parsed else {
            result.unmatched += 1;
            continue;
        };
        if apply_to_track(&mut conn, track_id, &fields, &want, &mut result)
            .map_err(|e| e.to_string())?
        {
            result.applied += 1;
        }
    }
    Ok(result)
}

/// Which fields an apply was asked to write, resolved from the frontend's name list once so the
/// per-track loop is a set of flag checks. An unrecognized name is ignored.
struct FieldSet {
    title: bool,
    artist: bool,
    album: bool,
    album_artist: bool,
    year: bool,
    disc_no: bool,
    track_no: bool,
    genre: bool,
}

impl FieldSet {
    fn from_names(names: &[String]) -> Self {
        let has = |k: &str| names.iter().any(|n| n == k);
        Self {
            title: has("title"),
            artist: has("artist"),
            album: has("album"),
            album_artist: has("album_artist"),
            year: has("year"),
            disc_no: has("disc_no"),
            track_no: has("track_no"),
            genre: has("genre"),
        }
    }
}

/// Applies one matched track's enabled fields, returning whether anything was written. The five
/// `track_edits` metadata fields plus disc overlay onto the track's current edit row and write back
/// as one full set, so untouched columns keep their value. A genre resolves to a vocabulary id and
/// appends to the track's list when absent. A track number sets the album-scoped position on a
/// member, preserving its disc, or is skipped and counted when the track is loose.
fn apply_to_track(
    conn: &mut Connection,
    track_id: i64,
    fields: &ParsedFields,
    want: &FieldSet,
    result: &mut ExtractResult,
) -> rusqlite::Result<bool> {
    let current = db::get_track_edit(conn, track_id)?;
    let mut wrote = false;

    // The metadata overlay: start from the current edit values, replace only the enabled fields the
    // parse recovered, then write the whole set back through the Files-view editor's writer.
    let mut title = current.title;
    let mut artist = current.artist;
    let mut album = current.album;
    let mut album_artist = current.album_artist;
    let mut year = current.year;
    let mut disc_no = current.disc_no;
    let mut edits_touched = false;
    overlay(&mut title, want.title, &fields.title, &mut edits_touched);
    overlay(&mut artist, want.artist, &fields.artist, &mut edits_touched);
    overlay(&mut album, want.album, &fields.album, &mut edits_touched);
    overlay(
        &mut album_artist,
        want.album_artist,
        &fields.album_artist,
        &mut edits_touched,
    );
    overlay_num(&mut year, want.year, fields.year, &mut edits_touched);
    overlay_num(&mut disc_no, want.disc_no, fields.disc_no, &mut edits_touched);
    if edits_touched {
        db::set_track_edit(
            conn, track_id, title, artist, album, album_artist, year, disc_no,
        )?;
        wrote = true;
    }

    // Genre appends to the track's list, never replacing it: resolve the name to a vocabulary id the
    // way create_genre does, and add it only when the track does not already carry it.
    if want.genre {
        if let Some(name) = &fields.genre {
            if !name.trim().is_empty() {
                let genre_id = db::get_or_create_genre(conn, name, super::now_unix())?;
                if !current.genre_ids.contains(&genre_id) {
                    let mut list = current.genre_ids.clone();
                    list.push(genre_id);
                    db::set_track_genres(conn, track_id, &list)?;
                }
                wrote = true;
            }
        }
    }

    // The track number is album-scoped, stored on the membership row. Set it through the album-layout
    // writer for a member - carrying the track's final disc so that write leaves the disc unchanged -
    // and skip it on a loose track, which has no album position to hold it.
    if want.track_no {
        if let Some(no) = fields.track_no {
            match db::membership_album(conn, track_id)? {
                Some(album_id) => {
                    let placement = crate::dto::TrackPlacement {
                        track_id,
                        disc_no,
                        track_no: Some(no),
                    };
                    db::set_album_layout(conn, album_id, &[placement])?;
                    wrote = true;
                }
                None => result.track_no_skipped_loose += 1,
            }
        }
    }

    Ok(wrote)
}

/// Replaces `slot` with a recovered free-text value when its field is enabled and the parse found
/// one, flagging that the overlay changed. Leaves the current value in place otherwise.
fn overlay(slot: &mut Option<String>, enabled: bool, value: &Option<String>, touched: &mut bool) {
    if enabled {
        if let Some(v) = value {
            *slot = Some(v.clone());
            *touched = true;
        }
    }
}

/// The numeric twin of overlay: replaces `slot` with a recovered integer when enabled and present.
fn overlay_num(slot: &mut Option<i64>, enabled: bool, value: Option<i64>, touched: &mut bool) {
    if enabled {
        if let Some(v) = value {
            *slot = Some(v);
            *touched = true;
        }
    }
}

/// Maps the engine's framework-free fields to the serde DTO the frontend reads.
fn to_dto(fields: ParsedFields) -> ExtractedFields {
    ExtractedFields {
        title: fields.title,
        artist: fields.artist,
        album: fields.album,
        album_artist: fields.album_artist,
        year: fields.year,
        disc_no: fields.disc_no,
        track_no: fields.track_no,
        genre: fields.genre,
    }
}
