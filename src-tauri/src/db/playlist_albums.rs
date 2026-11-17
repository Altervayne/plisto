/*
 * Album entries in playlists: a `playlist_tracks` row that holds an `album_id` instead of a `track_id`
 * stands for the album's live member list, played in album order. This module writes entries, turns an
 * entry back into track slots (dissolve), and expands a playlist into the tracks it plays. Positions are
 * not unique, so every order here is (position, slot id), and a dissolve renumbers the whole playlist
 * 1..K while every other slot keeps its id. A single never becomes an entry: it is added as a track
 * slot of its one member.
 */

// -- Library Imports --
use rusqlite::{params, Connection, OptionalExtension};

// -- Local Imports --
use super::{album_kind, ALBUM_KIND, SINGLE_KIND};

/// An album member's place in the album: disc, then track number, as one integer. The disc follows the
/// edit over the raw tag with an unset disc reading as disc 1; an unset track number reads as 0 and
/// leads its disc. Disc clamps to 0..=99999 and track to 0..=999999, so each pair maps to its own key
/// and the key orders like the pair. Needs the `t`, `te` and `at` joins.
pub const ALBUM_MEMBER_KEY: &str = "(MIN(MAX(COALESCE(te.disc_no, t.raw_disc_no, 1), 0), 99999) \
     * 1000000 + MIN(MAX(COALESCE(at.track_no, 0), 0), 999999))";

/// One track a playlist plays, in play order. `album_id` and `keep_order` come from the album entry the
/// track expands from; a track slot carries None and false.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpandedRow {
    pub slot_id: i64,
    pub track_id: i64,
    pub album_id: Option<i64>,
    pub keep_order: bool,
    pub missing: bool,
}

/// Appends each album in `album_ids` as an album entry after the playlist's last position, in the given
/// order, in one transaction, and bumps `updated_at`. A single is appended as a track slot of its
/// member; an unknown id or any other kind is skipped.
pub fn add_albums_to_playlist(
    conn: &mut Connection,
    playlist_id: i64,
    album_ids: &[i64],
    keep_order: bool,
    now: i64,
) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    let mut next: i64 = tx.query_row(
        "SELECT COALESCE(MAX(position), 0) FROM playlist_tracks WHERE playlist_id = ?1",
        params![playlist_id],
        |r| r.get(0),
    )?;
    for &album_id in album_ids {
        match album_kind(&tx, album_id)?.as_deref() {
            None => continue,
            Some(SINGLE_KIND) => {
                let Some(&track_id) = album_members(&tx, album_id)?.first() else {
                    continue;
                };
                next += 1;
                tx.execute(
                    "INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?1, ?2, ?3)",
                    params![playlist_id, track_id, next],
                )?;
            }
            Some(ALBUM_KIND) => {
                next += 1;
                tx.execute(
                    "INSERT INTO playlist_tracks (playlist_id, album_id, keep_order, position)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![playlist_id, album_id, keep_order, next],
                )?;
            }
            Some(_) => continue,
        }
    }
    touch_playlist(&tx, playlist_id, now)?;
    tx.commit()
}

/// Sets an album entry's keep-order flag and bumps its playlist's `updated_at`. A track slot or an
/// unknown id matches nothing.
pub fn set_entry_keep_order(
    conn: &mut Connection,
    slot_id: i64,
    keep: bool,
    now: i64,
) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    if let Some((playlist_id, _)) = entry(&tx, slot_id)? {
        tx.execute(
            "UPDATE playlist_tracks SET keep_order = ?1 WHERE id = ?2",
            params![keep, slot_id],
        )?;
        touch_playlist(&tx, playlist_id, now)?;
    }
    tx.commit()
}

/// Turns one album entry into track slots of its members, in one transaction, and bumps its playlist's
/// `updated_at`. A track slot or an unknown id is left alone.
pub fn unpack_album_entry(conn: &mut Connection, slot_id: i64, now: i64) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    if let Some((playlist_id, _)) = entry(&tx, slot_id)? {
        dissolve_entry(&tx, slot_id)?;
        touch_playlist(&tx, playlist_id, now)?;
    }
    tx.commit()
}

/// Replaces an album entry by its members as track slots, in album order and at the entry's place,
/// missing files included. An album with no member leaves nothing. The caller holds the transaction.
///
/// The dissolves never touch the playlist's `updated_at`. A user's edit of the playlist (add,
/// keep-order, unpack) bumps it in its own writer; a dissolve caused by a library change (album delete,
/// tag-batch undo, relocate merge) does not, like a track-delete cascade.
pub fn dissolve_entry(conn: &Connection, slot_id: i64) -> rusqlite::Result<()> {
    let Some((playlist_id, album_id)) = entry(conn, slot_id)? else {
        return Ok(());
    };
    let members = album_members(conn, album_id)?;
    replace_entry(conn, playlist_id, slot_id, &members)
}

/// Dissolves every entry of `album_id` across all playlists, before the album itself goes. Returns how
/// many entries were dissolved.
pub fn dissolve_album_entries(conn: &Connection, album_id: i64) -> rusqlite::Result<usize> {
    let members = album_members(conn, album_id)?;
    dissolve_entries_into(conn, album_id, &members)
}

/// Dissolves every entry of `album_id` into `track_ids`, in that order: the tracks its members live on
/// as once they have left it. Returns how many entries were dissolved.
pub fn dissolve_entries_into(
    conn: &Connection,
    album_id: i64,
    track_ids: &[i64],
) -> rusqlite::Result<usize> {
    let mut dissolved = 0;
    // One entry at a time: the same album can sit twice in one playlist, and each dissolve renumbers it.
    while let Some((slot_id, playlist_id)) = conn
        .query_row(
            "SELECT id, playlist_id FROM playlist_tracks WHERE album_id = ?1 ORDER BY id LIMIT 1",
            params![album_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
    {
        replace_entry(conn, playlist_id, slot_id, track_ids)?;
        dissolved += 1;
    }
    Ok(dissolved)
}

/// Every album an entry references, with its members in album order as they stand now.
pub(super) fn referenced_album_members(
    conn: &Connection,
) -> rusqlite::Result<Vec<(i64, Vec<i64>)>> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT album_id FROM playlist_tracks WHERE album_id IS NOT NULL ORDER BY album_id",
    )?;
    let album_ids = stmt
        .query_map([], |r| r.get::<_, i64>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    album_ids
        .into_iter()
        .map(|id| Ok((id, album_members(conn, id)?)))
        .collect()
}

/// Every track one playlist plays, in play order: slots by position then slot id, and an entry's
/// members in album order, missing files included. The one expansion every reader of a playlist's
/// tracks goes through.
pub fn playlist_expanded(
    conn: &Connection,
    playlist_id: i64,
) -> rusqlite::Result<Vec<ExpandedRow>> {
    let sql = format!(
        "SELECT pt.id, t.id, NULL, 0, t.missing_at IS NOT NULL, pt.position, 0, t.id
         FROM playlist_tracks pt
         JOIN tracks t ON t.id = pt.track_id
         WHERE pt.playlist_id = ?1 AND pt.track_id IS NOT NULL
         UNION ALL
         SELECT pt.id, t.id, pt.album_id, pt.keep_order, t.missing_at IS NOT NULL, pt.position,
                {ALBUM_MEMBER_KEY}, t.id
         FROM playlist_tracks pt
         JOIN album_tracks at ON at.album_id = pt.album_id
         JOIN tracks t ON t.id = at.track_id
         LEFT JOIN track_edits te ON te.track_id = t.id
         WHERE pt.playlist_id = ?1 AND pt.album_id IS NOT NULL
         ORDER BY 6, 1, 7, 8"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(params![playlist_id], |r| {
            Ok(ExpandedRow {
                slot_id: r.get(0)?,
                track_id: r.get(1)?,
                album_id: r.get(2)?,
                keep_order: r.get(3)?,
                missing: r.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// The queue an expansion plays: its track ids, and a `[start, length]` span over the ids of each
/// keep-order entry. With `present_only`, missing tracks drop out before the spans are counted, so an
/// entry with no present member has no span. An entry with one row gives `[i, 1]`; the engine takes it
/// and leaves it off the wire.
#[cfg_attr(not(test), allow(dead_code))]
pub fn expanded_queue(rows: &[ExpandedRow], present_only: bool) -> (Vec<i64>, Vec<[usize; 2]>) {
    let mut ids = Vec::with_capacity(rows.len());
    let mut spans: Vec<[usize; 2]> = Vec::new();
    let mut open: Option<i64> = None;
    for row in rows.iter().filter(|r| !(present_only && r.missing)) {
        let kept = row.album_id.is_some() && row.keep_order;
        if kept && open == Some(row.slot_id) {
            if let Some(span) = spans.last_mut() {
                span[1] += 1;
            }
        } else if kept {
            spans.push([ids.len(), 1]);
        }
        open = kept.then_some(row.slot_id);
        ids.push(row.track_id);
    }
    (ids, spans)
}

/// The (playlist id, album id) of an album entry, or None when the slot is gone or is a track slot.
fn entry(conn: &Connection, slot_id: i64) -> rusqlite::Result<Option<(i64, i64)>> {
    conn.query_row(
        "SELECT playlist_id, album_id FROM playlist_tracks WHERE id = ?1 AND album_id IS NOT NULL",
        params![slot_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
}

/// Every member of an album in album order, missing files included.
fn album_members(conn: &Connection, album_id: i64) -> rusqlite::Result<Vec<i64>> {
    let sql = format!(
        "SELECT t.id FROM album_tracks at JOIN tracks t ON t.id = at.track_id
         LEFT JOIN track_edits te ON te.track_id = t.id
         WHERE at.album_id = ?1 ORDER BY {ALBUM_MEMBER_KEY}, t.id"
    );
    let mut stmt = conn.prepare(&sql)?;
    let ids = stmt
        .query_map(params![album_id], |r| r.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(ids)
}

/// Puts `track_ids` as new slots where the entry `slot_id` sits, deletes the entry, and rewrites every
/// position of the playlist 1..K in (position, slot id) order.
fn replace_entry(
    conn: &Connection,
    playlist_id: i64,
    slot_id: i64,
    track_ids: &[i64],
) -> rusqlite::Result<()> {
    let mut stmt = conn
        .prepare("SELECT id FROM playlist_tracks WHERE playlist_id = ?1 ORDER BY position, id")?;
    let order = stmt
        .query_map(params![playlist_id], |r| r.get::<_, i64>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    // Insert before the delete, so no new slot can take the entry's id.
    let mut inserted = Vec::with_capacity(track_ids.len());
    for &track_id in track_ids {
        conn.execute(
            "INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?1, ?2, 0)",
            params![playlist_id, track_id],
        )?;
        inserted.push(conn.last_insert_rowid());
    }
    conn.execute(
        "DELETE FROM playlist_tracks WHERE id = ?1",
        params![slot_id],
    )?;

    let mut renumber = conn.prepare("UPDATE playlist_tracks SET position = ?1 WHERE id = ?2")?;
    let mut position: i64 = 0;
    for id in order {
        let placed = if id == slot_id {
            inserted.as_slice()
        } else {
            std::slice::from_ref(&id)
        };
        for &slot in placed {
            position += 1;
            renumber.execute(params![position, slot])?;
        }
    }
    Ok(())
}

fn touch_playlist(conn: &Connection, playlist_id: i64, now: i64) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE playlists SET updated_at = ?1 WHERE id = ?2",
        params![now, playlist_id],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests;
