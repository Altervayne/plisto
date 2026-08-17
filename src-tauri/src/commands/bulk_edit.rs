/*
 * The IPC command surface for bulk tag editing: set one shared value across a whole track selection
 * and add or remove genres over it, in one held lock. Every write reuses an existing edit-layer
 * writer verbatim - get_track_edit plus set_track_edit for the metadata overlay, get_or_create_genre
 * plus set_track_genres for the genre list - so it invents no write path of its own. The add names
 * and remove names resolve to vocabulary ids once, before the per-track loop, so a bulk add creates a
 * new genre at most once; a remove name that is not in the vocabulary is skipped rather than created.
 */

// -- Library Imports --
use std::collections::{HashMap, HashSet};

use rusqlite::Connection;
use tauri::State;

// -- Local Imports --
use crate::db;
use crate::dto::{BulkEditResult, BulkSetFields};
use crate::normalize::normalize_genre_key;
use crate::state::AppState;

/// Applies one bulk tag patch across `track_ids`: overlays the provided set-fields onto each track's
/// edit row and adds or removes the named genres. Set-fields are tri-state - a None leaves the column
/// untouched, an empty string clears it, a value sets it - so a selection can gain a shared artist
/// without disturbing per-track title or disc. Genre names resolve once: adds get-or-create their
/// vocabulary row, removes match an existing row or are skipped. Holds the DB lock for the whole
/// batch, so it lands as one consistent writer. Returns how many tracks were written.
#[tauri::command]
pub fn bulk_edit_tracks(
    track_ids: Vec<i64>,
    set: BulkSetFields,
    add_genres: Vec<String>,
    remove_genres: Vec<String>,
    state: State<'_, AppState>,
) -> Result<BulkEditResult, String> {
    let conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    let edited = apply_bulk_edit(
        &conn,
        &track_ids,
        &set,
        &add_genres,
        &remove_genres,
        super::now_unix(),
    )
    .map_err(|e| e.to_string())?;
    Ok(BulkEditResult { edited })
}

/// The lock-free core: resolves the genre names once, then writes each track's overlaid edit row and
/// merged genre list. Returns the count of tracks that had at least one write. A selection with no
/// set-field and no genre change writes nothing and returns zero.
fn apply_bulk_edit(
    conn: &Connection,
    track_ids: &[i64],
    set: &BulkSetFields,
    add_genres: &[String],
    remove_genres: &[String],
    now: i64,
) -> rusqlite::Result<i64> {
    let has_set = set.artist.is_some()
        || set.album.is_some()
        || set.album_artist.is_some()
        || set.year.is_some();

    // Resolve the add names to ids once, creating a missing genre at most one time; a blank name is
    // ignored. Removes resolve against the current vocabulary by folded key, so a name not in the
    // vocabulary drops out rather than spawning a genre.
    let add_ids: Vec<i64> = add_genres
        .iter()
        .filter(|name| !name.trim().is_empty())
        .map(|name| db::get_or_create_genre(conn, name, now))
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let remove_ids: HashSet<i64> = if remove_genres.is_empty() {
        HashSet::new()
    } else {
        let by_key: HashMap<String, i64> = db::list_genres(conn)?
            .into_iter()
            .map(|g| (normalize_genre_key(&g.name), g.id))
            .collect();
        remove_genres
            .iter()
            .filter_map(|name| by_key.get(&normalize_genre_key(name)).copied())
            .collect()
    };
    let has_genre_change = !add_ids.is_empty() || !remove_ids.is_empty();

    let mut edited = 0;
    for &track_id in track_ids {
        let mut wrote = false;

        // The metadata overlay: start from the track's current edit values, replace only the provided
        // set-fields, and write the whole set back through the Files-view editor's writer. Title and
        // disc are never part of a bulk edit, so they carry through untouched.
        if has_set {
            let current = db::get_track_edit(conn, track_id)?;
            let artist = overlay(current.artist, &set.artist);
            let album = overlay(current.album, &set.album);
            let album_artist = overlay(current.album_artist, &set.album_artist);
            let year = overlay_year(current.year, &set.year);
            db::set_track_edit(
                conn,
                track_id,
                current.title,
                artist,
                album,
                album_artist,
                year,
                current.disc_no,
            )?;
            wrote = true;
        }

        // The genre merge: current + adds, deduped in place and in order, minus the removes. A removal
        // wins over an add of the same genre, the only way the two can contradict.
        if has_genre_change {
            let current_ids: Vec<i64> = db::load_track_genre_ids_for(conn, &[track_id])?
                .into_iter()
                .map(|(_, genre_id)| genre_id)
                .collect();
            let mut seen: HashSet<i64> = HashSet::new();
            let mut merged: Vec<i64> = Vec::new();
            for &genre_id in current_ids.iter().chain(add_ids.iter()) {
                if remove_ids.contains(&genre_id) {
                    continue;
                }
                if seen.insert(genre_id) {
                    merged.push(genre_id);
                }
            }
            db::set_track_genres(conn, track_id, &merged)?;
            wrote = true;
        }

        if wrote {
            edited += 1;
        }
    }

    Ok(edited)
}

/// Overlays one text set-field onto the current value: a None leaves it, an empty string clears it to
/// NULL, a value replaces it.
fn overlay(current: Option<String>, provided: &Option<String>) -> Option<String> {
    match provided {
        None => current,
        Some(value) if value.is_empty() => None,
        Some(value) => Some(value.clone()),
    }
}

/// The year twin of overlay: a None leaves it, an empty string clears it, a numeric string sets it.
/// A non-numeric string leaves the year untouched rather than writing a bad value.
fn overlay_year(current: Option<i64>, provided: &Option<String>) -> Option<i64> {
    match provided {
        None => current,
        Some(value) if value.trim().is_empty() => None,
        Some(value) => value.trim().parse::<i64>().ok().or(current),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn sets_a_shared_field_and_adds_and_removes_a_genre_across_the_selection() {
        let conn = db::open_in_memory().unwrap();
        let a = insert_track(&conn, "/music/1.mp3");
        let b = insert_track(&conn, "/music/2.mp3");

        let set = BulkSetFields {
            artist: Some("Boards of Canada".into()),
            ..Default::default()
        };
        let edited =
            apply_bulk_edit(&conn, &[a, b], &set, &["Electronic".into()], &[], 100).unwrap();
        assert_eq!(edited, 2);

        // Both tracks carry the shared artist and the added genre.
        for id in [a, b] {
            let edit = db::get_track_edit(&conn, id).unwrap();
            assert_eq!(edit.artist.as_deref(), Some("Boards of Canada"));
            assert_eq!(edit.genre_ids.len(), 1);
        }

        // Re-adding the same genre is a no-op: the list stays a single entry.
        apply_bulk_edit(&conn, &[a, b], &BulkSetFields::default(), &["Electronic".into()], &[], 100)
            .unwrap();
        assert_eq!(db::get_track_edit(&conn, a).unwrap().genre_ids.len(), 1);

        // Removing it clears the genre from every track, and a remove of an unknown name is ignored.
        apply_bulk_edit(
            &conn,
            &[a, b],
            &BulkSetFields::default(),
            &[],
            &["Electronic".into(), "Nonexistent".into()],
            100,
        )
        .unwrap();
        assert!(db::get_track_edit(&conn, a).unwrap().genre_ids.is_empty());
        assert!(db::get_track_edit(&conn, b).unwrap().genre_ids.is_empty());
    }

    #[test]
    fn an_empty_string_clears_a_field_and_a_none_leaves_it() {
        let conn = db::open_in_memory().unwrap();
        let t = insert_track(&conn, "/music/1.mp3");

        // Seed an album and a year, then a second edit that clears the album but leaves the year.
        apply_bulk_edit(
            &conn,
            &[t],
            &BulkSetFields {
                album: Some("First".into()),
                year: Some("1998".into()),
                ..Default::default()
            },
            &[],
            &[],
            100,
        )
        .unwrap();
        apply_bulk_edit(
            &conn,
            &[t],
            &BulkSetFields {
                album: Some(String::new()),
                ..Default::default()
            },
            &[],
            &[],
            100,
        )
        .unwrap();

        let edit = db::get_track_edit(&conn, t).unwrap();
        assert_eq!(edit.album, None, "an empty string cleared the album");
        assert_eq!(edit.year, Some(1998), "an absent field left the year in place");
    }
}
