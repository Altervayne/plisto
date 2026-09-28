/*
 * Per-disc membership numbering shared by the album writers. `album_tracks.track_no` is a track's
 * position within its disc, and the disc resolves from the edit layer over the raw scan, an unset disc
 * reading as disc 1. `album_tracks` holds no disc of its own, so every read here joins it back in.
 */

// -- Library Imports --
use std::collections::HashMap;

use rusqlite::{params, Connection};

// -- Local Imports --
use crate::dto::TagAlbumMember;

/// One incoming track as the writers need it: its resolved disc (unset reads as disc 1) and whether
/// its file is still present.
pub(super) struct Incoming {
    pub(super) track_id: i64,
    pub(super) disc: i64,
    pub(super) present: bool,
}

/// Reads one track's resolved disc and presence, or None when no row has that id.
pub(super) fn read_incoming(
    conn: &Connection,
    track_id: i64,
) -> rusqlite::Result<Option<Incoming>> {
    conn.query_row(
        "SELECT COALESCE(te.disc_no, t.raw_disc_no), t.missing_at IS NULL
         FROM tracks t
         LEFT JOIN track_edits te ON te.track_id = t.id
         WHERE t.id = ?1",
        params![track_id],
        |r| {
            Ok(Incoming {
                track_id,
                disc: r.get::<_, Option<i64>>(0)?.unwrap_or(1),
                present: r.get(1)?,
            })
        },
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other),
    })
}

/// Positions `tracks` in the given order, each disc continuing from its entry in `highest` (0 when the
/// disc is new), so every disc numbers densely on its own.
pub(super) fn number_per_disc(
    tracks: &[Incoming],
    mut highest: HashMap<i64, i64>,
) -> Vec<TagAlbumMember> {
    tracks
        .iter()
        .map(|t| TagAlbumMember {
            track_id: t.track_id,
            track_no: next_on_disc(&mut highest, t.disc),
        })
        .collect()
}

/// Claims the next position on `disc` and records it as that disc's new top.
pub(super) fn next_on_disc(highest: &mut HashMap<i64, i64>, disc: i64) -> i64 {
    let top = highest.entry(disc).or_insert(0);
    *top += 1;
    *top
}

/// The highest position on each disc of an album, keyed by resolved disc (unset reads as disc 1).
pub(super) fn disc_highest(
    conn: &Connection,
    album_id: i64,
) -> rusqlite::Result<HashMap<i64, i64>> {
    let mut stmt = conn.prepare(
        "SELECT COALESCE(te.disc_no, t.raw_disc_no), at.track_no
         FROM album_tracks at
         JOIN tracks t ON t.id = at.track_id
         LEFT JOIN track_edits te ON te.track_id = at.track_id
         WHERE at.album_id = ?1",
    )?;
    let rows = stmt
        .query_map(params![album_id], |r| {
            Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, Option<i64>>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut highest: HashMap<i64, i64> = HashMap::new();
    for (disc, track_no) in rows {
        let top = highest.entry(disc.unwrap_or(1)).or_insert(0);
        *top = (*top).max(track_no.unwrap_or(0));
    }
    Ok(highest)
}
