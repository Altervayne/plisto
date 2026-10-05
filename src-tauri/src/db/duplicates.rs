/*
 * The possible-duplicates writer: the dismissed-pair set, and the merge of duplicate tracks into one
 * keeper with its exact undo. A merge moves only what hangs off a track id - playlist slots, plays and
 * album membership - and records the group's dismissals; covers, genres, edits and the track rows
 * themselves stay put. Every check runs before the first write, so a refused merge or undo leaves the
 * database untouched. Albums are never created or deleted here.
 */

// -- Library Imports --
use std::collections::{BTreeMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension};

// -- Local Imports --
use super::tag_albums::{album_updated_at, set_updated_at};
use super::{album_kind, membership_album, remove_membership};
use crate::dto::{DismissedPair, MergeAlbumStamp, MergeMembership, MergeMovedRow, MergeReceipt};

// The two track-id tables a merge re-points, each keyed on its own row id.
const SLOTS: &str = "playlist_tracks";
const PLAYS: &str = "plays";

/// Why a merge or its undo was refused. Nothing is written in any case.
#[derive(Debug)]
pub enum MergeError {
    Sql(rusqlite::Error),
    KeeperGone,
    NoDiscards,
    KeeperInDiscards,
    RepeatedDiscard,
    UnknownTrack,
    // Removing the duplicates would leave this album, named for the message, with no member.
    EmptiesAlbum(String),
    // The keeper is loose and more than one duplicate is filed, so no single membership to take.
    SeveralAlbums,
    // The receipt's rows moved since the merge.
    Stale,
}

impl std::fmt::Display for MergeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MergeError::Sql(e) => write!(f, "{e}"),
            MergeError::KeeperGone => write!(f, "the track to keep is no longer in the library"),
            MergeError::NoDiscards => write!(f, "no duplicate was chosen to merge"),
            MergeError::KeeperInDiscards => {
                write!(f, "the track to keep cannot also be merged away")
            }
            MergeError::RepeatedDiscard => write!(f, "a duplicate was named twice"),
            MergeError::UnknownTrack => write!(f, "a duplicate is no longer in the library"),
            MergeError::EmptiesAlbum(name) => {
                write!(f, "merging would leave {name} with no tracks")
            }
            MergeError::SeveralAlbums => write!(
                f,
                "several duplicates are filed in albums and the track to keep is in none"
            ),
            MergeError::Stale => write!(f, "the library changed since the merge"),
        }
    }
}

impl From<rusqlite::Error> for MergeError {
    fn from(e: rusqlite::Error) -> Self {
        MergeError::Sql(e)
    }
}

/// Every pair among `track_ids`, lower id first, each once; self pairs and repeats drop out. The one
/// place a pair is built, so every write and delete agrees on its shape.
pub fn canonical_pairs(track_ids: &[i64]) -> Vec<DismissedPair> {
    let mut ids = track_ids.to_vec();
    ids.sort_unstable();
    ids.dedup();
    let mut pairs = Vec::with_capacity(ids.len() * ids.len().saturating_sub(1) / 2);
    for (i, &track_lo) in ids.iter().enumerate() {
        for &track_hi in &ids[i + 1..] {
            pairs.push(DismissedPair { track_lo, track_hi });
        }
    }
    pairs
}

/// Marks every pair among `track_ids` as not duplicates, in one transaction. A pair already
/// dismissed keeps its original stamp.
pub fn dismiss_duplicates(
    conn: &mut Connection,
    track_ids: &[i64],
    now: i64,
) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    insert_pairs(&tx, &canonical_pairs(track_ids), now)?;
    tx.commit()
}

/// Clears every dismissed pair among `track_ids`, in one transaction.
pub fn undismiss_duplicates(conn: &mut Connection, track_ids: &[i64]) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    delete_pairs(&tx, &canonical_pairs(track_ids))?;
    tx.commit()
}

/// Every dismissed pair, ordered by lower then higher id.
pub fn list_duplicate_dismissals(conn: &Connection) -> rusqlite::Result<Vec<DismissedPair>> {
    let mut stmt = conn.prepare(
        "SELECT track_lo, track_hi FROM duplicate_dismissals ORDER BY track_lo, track_hi",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(DismissedPair {
                track_lo: r.get(0)?,
                track_hi: r.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Folds the duplicates into the keeper in one transaction: re-points their playlist slots and plays
/// at it, resolves album membership under single membership, and dismisses every pair of the group.
/// A playlist may end up holding the keeper twice. Refused, nothing changed, on a gone keeper, a bad
/// discard list, or a membership the keeper cannot settle (see MergeError).
pub fn merge_duplicates(
    conn: &mut Connection,
    keeper_id: i64,
    discard_ids: &[i64],
    now: i64,
) -> Result<MergeReceipt, MergeError> {
    let tx = conn.transaction()?;

    if track_present(&tx, keeper_id)? != Some(true) {
        return Err(MergeError::KeeperGone);
    }
    if discard_ids.is_empty() {
        return Err(MergeError::NoDiscards);
    }
    let mut seen: HashSet<i64> = HashSet::new();
    for &id in discard_ids {
        if id == keeper_id {
            return Err(MergeError::KeeperInDiscards);
        }
        if !seen.insert(id) {
            return Err(MergeError::RepeatedDiscard);
        }
        if track_present(&tx, id)?.is_none() {
            return Err(MergeError::UnknownTrack);
        }
    }

    let mut filed = Vec::new();
    for &id in discard_ids {
        if let Some(m) = membership_row(&tx, id)? {
            filed.push(m);
        }
    }
    let mut added = None;
    match membership_album(&tx, keeper_id)? {
        Some(keeper_album) => {
            let mut leaving: BTreeMap<i64, i64> = BTreeMap::new();
            for m in &filed {
                *leaving.entry(m.album_id).or_default() += 1;
            }
            for (&album_id, &count) in &leaving {
                if album_id != keeper_album && member_count(&tx, album_id)? == count {
                    return Err(MergeError::EmptiesAlbum(album_label(&tx, album_id)?));
                }
            }
        }
        None => match filed.as_slice() {
            [] => {}
            [m] => {
                added = Some(MergeMembership {
                    album_id: m.album_id,
                    track_id: keeper_id,
                    track_no: m.track_no,
                    keep_own_cover: m.keep_own_cover,
                })
            }
            _ => return Err(MergeError::SeveralAlbums),
        },
    }

    let mut moved_slots = Vec::new();
    let mut moved_plays = Vec::new();
    for &id in discard_ids {
        moved_slots.extend(repoint(&tx, SLOTS, id, keeper_id)?);
        moved_plays.extend(repoint(&tx, PLAYS, id, keeper_id)?);
    }

    let mut touched: Vec<i64> = filed.iter().map(|m| m.album_id).collect();
    touched.sort_unstable();
    touched.dedup();
    let mut album_stamps = Vec::with_capacity(touched.len());
    for album_id in touched {
        album_stamps.push(MergeAlbumStamp {
            album_id,
            prev_updated_at: album_updated_at(&tx, album_id)?,
        });
    }
    for m in &filed {
        remove_membership(&tx, m.track_id)?;
    }
    if let Some(m) = &added {
        insert_membership(&tx, m)?;
    }
    for stamp in &album_stamps {
        set_updated_at(&tx, stamp.album_id, now)?;
    }

    let mut group = discard_ids.to_vec();
    group.push(keeper_id);
    let dismissed = insert_pairs(&tx, &canonical_pairs(&group), now)?;

    tx.commit()?;
    Ok(MergeReceipt {
        keeper_id,
        moved_slots,
        moved_plays,
        removed_memberships: filed,
        added_membership: added,
        album_stamps,
        dismissed,
    })
}

/// Undoes a merge from its receipt: points the slots and plays back at their former tracks, takes
/// the keeper's added membership away, restores the removed memberships and album stamps, and clears
/// only the pairs the merge dismissed. Refused with Stale, nothing changed, when any of those rows
/// moved since.
pub fn undo_merge_duplicates(
    conn: &mut Connection,
    receipt: &MergeReceipt,
) -> Result<(), MergeError> {
    let tx = conn.transaction()?;

    for (table, rows) in [(SLOTS, &receipt.moved_slots), (PLAYS, &receipt.moved_plays)] {
        for row in rows {
            if row_track(&tx, table, row.id)? != Some(receipt.keeper_id)
                || track_present(&tx, row.track_id)?.is_none()
            {
                return Err(MergeError::Stale);
            }
        }
    }
    if let Some(m) = &receipt.added_membership {
        if membership_album(&tx, m.track_id)? != Some(m.album_id) {
            return Err(MergeError::Stale);
        }
    }
    for m in &receipt.removed_memberships {
        if track_present(&tx, m.track_id)?.is_none()
            || membership_album(&tx, m.track_id)?.is_some()
            || album_kind(&tx, m.album_id)?.is_none()
        {
            return Err(MergeError::Stale);
        }
    }

    for (table, rows) in [(SLOTS, &receipt.moved_slots), (PLAYS, &receipt.moved_plays)] {
        for row in rows {
            tx.execute(
                &format!("UPDATE {table} SET track_id = ?1 WHERE id = ?2"),
                params![row.track_id, row.id],
            )?;
        }
    }
    if let Some(m) = &receipt.added_membership {
        remove_membership(&tx, m.track_id)?;
    }
    for m in &receipt.removed_memberships {
        insert_membership(&tx, m)?;
    }
    for stamp in &receipt.album_stamps {
        set_updated_at(&tx, stamp.album_id, stamp.prev_updated_at)?;
    }
    delete_pairs(&tx, &receipt.dismissed)?;

    tx.commit()?;
    Ok(())
}

/// Inserts each pair not already dismissed and returns just those, so an undo never clears a pair
/// that was there before.
fn insert_pairs(
    conn: &Connection,
    pairs: &[DismissedPair],
    now: i64,
) -> rusqlite::Result<Vec<DismissedPair>> {
    let mut stmt = conn.prepare(
        "INSERT OR IGNORE INTO duplicate_dismissals (track_lo, track_hi, dismissed_at)
         VALUES (?1, ?2, ?3)",
    )?;
    let mut inserted = Vec::new();
    for pair in pairs {
        if stmt.execute(params![pair.track_lo, pair.track_hi, now])? > 0 {
            inserted.push(*pair);
        }
    }
    Ok(inserted)
}

fn delete_pairs(conn: &Connection, pairs: &[DismissedPair]) -> rusqlite::Result<()> {
    let mut stmt =
        conn.prepare("DELETE FROM duplicate_dismissals WHERE track_lo = ?1 AND track_hi = ?2")?;
    for pair in pairs {
        stmt.execute(params![pair.track_lo, pair.track_hi])?;
    }
    Ok(())
}

/// None when the track has no row, else whether its file is present.
fn track_present(conn: &Connection, track_id: i64) -> rusqlite::Result<Option<bool>> {
    conn.query_row(
        "SELECT missing_at IS NULL FROM tracks WHERE id = ?1",
        params![track_id],
        |r| r.get(0),
    )
    .optional()
}

/// The track's whole membership row, or None when it is loose.
fn membership_row(conn: &Connection, track_id: i64) -> rusqlite::Result<Option<MergeMembership>> {
    conn.query_row(
        "SELECT album_id, track_no, keep_own_cover FROM album_tracks WHERE track_id = ?1",
        params![track_id],
        |r| {
            Ok(MergeMembership {
                album_id: r.get(0)?,
                track_id,
                track_no: r.get(1)?,
                keep_own_cover: r.get(2)?,
            })
        },
    )
    .optional()
}

/// Writes a membership row with its exact position and keep-own-cover flag.
fn insert_membership(conn: &Connection, m: &MergeMembership) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO album_tracks (album_id, track_id, track_no, keep_own_cover)
         VALUES (?1, ?2, ?3, ?4)",
        params![m.album_id, m.track_id, m.track_no, m.keep_own_cover],
    )?;
    Ok(())
}

fn member_count(conn: &Connection, album_id: i64) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM album_tracks WHERE album_id = ?1",
        params![album_id],
        |r| r.get(0),
    )
}

/// The album as a refusal names it: its quoted title, or its kind when it has none.
fn album_label(conn: &Connection, album_id: i64) -> rusqlite::Result<String> {
    let (title, kind): (Option<String>, String) = conn.query_row(
        "SELECT title, kind FROM albums WHERE id = ?1",
        params![album_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    Ok(match title {
        Some(title) => format!("\"{title}\""),
        None => format!("an untitled {kind}"),
    })
}

/// Points every row of `table` held by `from` at `to` and returns each row with its former track.
fn repoint(
    conn: &Connection,
    table: &str,
    from: i64,
    to: i64,
) -> rusqlite::Result<Vec<MergeMovedRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT id FROM {table} WHERE track_id = ?1 ORDER BY id"
    ))?;
    let ids = stmt
        .query_map(params![from], |r| r.get::<_, i64>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    conn.execute(
        &format!("UPDATE {table} SET track_id = ?1 WHERE track_id = ?2"),
        params![to, from],
    )?;
    Ok(ids
        .into_iter()
        .map(|id| MergeMovedRow { id, track_id: from })
        .collect())
}

/// The track a row of `table` points at, or None when the row is gone.
fn row_track(conn: &Connection, table: &str, id: i64) -> rusqlite::Result<Option<i64>> {
    conn.query_row(
        &format!("SELECT track_id FROM {table} WHERE id = ?1"),
        params![id],
        |r| r.get(0),
    )
    .optional()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use rusqlite::types::Value;

    // Inserts a track; `missing` flags its file gone.
    fn insert_track(conn: &Connection, path: &str, missing: bool) -> i64 {
        conn.execute(
            "INSERT INTO tracks (source_path, filename, ext, size_bytes, mtime, has_embedded_cover, scanned_at,
                                 missing_at)
             VALUES (?1, 'song.mp3', 'mp3', 10, 20, 0, 30, ?2)",
            params![path, if missing { Some(40) } else { None }],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    // Inserts an album at the given stamp holding `members` at positions 1..k.
    fn insert_album(
        conn: &Connection,
        title: Option<&str>,
        updated_at: i64,
        members: &[i64],
    ) -> i64 {
        conn.execute(
            "INSERT INTO albums (title, created_at, updated_at) VALUES (?1, 1, ?2)",
            params![title, updated_at],
        )
        .unwrap();
        let id = conn.last_insert_rowid();
        for (i, &track_id) in members.iter().enumerate() {
            conn.execute(
                "INSERT INTO album_tracks (album_id, track_id, track_no) VALUES (?1, ?2, ?3)",
                params![id, track_id, i as i64 + 1],
            )
            .unwrap();
        }
        id
    }

    fn insert_playlist(conn: &Connection, tracks: &[i64]) -> i64 {
        conn.execute(
            "INSERT INTO playlists (created_at, updated_at) VALUES (1, 1)",
            [],
        )
        .unwrap();
        let id = conn.last_insert_rowid();
        for (i, &track_id) in tracks.iter().enumerate() {
            conn.execute(
                "INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?1, ?2, ?3)",
                params![id, track_id, i as i64 + 1],
            )
            .unwrap();
        }
        id
    }

    fn insert_plays(conn: &Connection, track_id: i64, n: i64) {
        for i in 0..n {
            conn.execute(
                "INSERT INTO plays (track_id, played_at, completed) VALUES (?1, ?2, 1)",
                params![track_id, 100 + i],
            )
            .unwrap();
        }
    }

    // Every row of `table` in a stable order, every column as a raw value.
    fn dump(conn: &Connection, table: &str, order: &str) -> Vec<Vec<Value>> {
        let mut stmt = conn
            .prepare(&format!("SELECT * FROM {table} ORDER BY {order}"))
            .unwrap();
        let cols = stmt.column_count();
        stmt.query_map([], |r| (0..cols).map(|i| r.get::<_, Value>(i)).collect())
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    }

    // The tables a merge may write, dumped together for before/after comparison.
    fn index_state(conn: &Connection) -> Vec<Vec<Vec<Value>>> {
        vec![
            dump(conn, "albums", "id"),
            dump(conn, "album_tracks", "track_id"),
            dump(conn, "playlist_tracks", "id"),
            dump(conn, "plays", "id"),
            dump(conn, "duplicate_dismissals", "track_lo, track_hi"),
        ]
    }

    fn untouchable(conn: &Connection) -> Vec<Vec<Vec<Value>>> {
        vec![
            dump(conn, "tracks", "id"),
            dump(conn, "track_edits", "track_id"),
        ]
    }

    fn pair(track_lo: i64, track_hi: i64) -> DismissedPair {
        DismissedPair { track_lo, track_hi }
    }

    fn plays_of(conn: &Connection, track_id: i64) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM plays WHERE track_id = ?1",
            params![track_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn membership(conn: &Connection, track_id: i64) -> Option<MergeMembership> {
        membership_row(conn, track_id).unwrap()
    }

    #[test]
    fn pairs_are_canonical_whatever_the_input_order() {
        assert_eq!(canonical_pairs(&[3, 1]), vec![pair(1, 3)]);
        assert_eq!(canonical_pairs(&[5, 5]), vec![]);
        assert_eq!(canonical_pairs(&[7]), vec![]);
        assert_eq!(
            canonical_pairs(&[3, 1, 2, 3, 1]),
            vec![pair(1, 2), pair(1, 3), pair(2, 3)]
        );
    }

    #[test]
    fn dismiss_and_undismiss_round_trip_and_ignore_repeats() {
        let mut conn = db::open_in_memory().unwrap();
        let a = insert_track(&conn, "/m/a.mp3", false);
        let b = insert_track(&conn, "/m/b.mp3", false);
        let c = insert_track(&conn, "/m/c.mp3", false);

        dismiss_duplicates(&mut conn, &[c, a, b, a], 10).unwrap();
        dismiss_duplicates(&mut conn, &[b, a], 20).unwrap();
        assert_eq!(
            list_duplicate_dismissals(&conn).unwrap(),
            vec![pair(a, b), pair(a, c), pair(b, c)]
        );
        let stamp: i64 = conn
            .query_row(
                "SELECT dismissed_at FROM duplicate_dismissals WHERE track_lo = ?1 AND track_hi = ?2",
                params![a, b],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stamp, 10, "a repeat keeps the first stamp");

        undismiss_duplicates(&mut conn, &[b, a]).unwrap();
        assert_eq!(
            list_duplicate_dismissals(&conn).unwrap(),
            vec![pair(a, c), pair(b, c)]
        );
    }

    #[test]
    fn deleting_a_track_cascades_its_pairs() {
        let mut conn = db::open_in_memory().unwrap();
        let a = insert_track(&conn, "/m/a.mp3", false);
        let b = insert_track(&conn, "/m/b.mp3", false);
        let c = insert_track(&conn, "/m/c.mp3", false);
        dismiss_duplicates(&mut conn, &[a, b, c], 10).unwrap();

        conn.execute("DELETE FROM tracks WHERE id = ?1", params![b])
            .unwrap();

        assert_eq!(list_duplicate_dismissals(&conn).unwrap(), vec![pair(a, c)]);
    }

    #[test]
    fn a_bad_keeper_or_discard_list_is_refused_with_nothing_changed() {
        let mut conn = db::open_in_memory().unwrap();
        let keeper = insert_track(&conn, "/m/k.mp3", false);
        let gone = insert_track(&conn, "/m/gone.mp3", true);
        let dup = insert_track(&conn, "/m/d.mp3", false);
        insert_playlist(&conn, &[dup]);
        insert_plays(&conn, dup, 2);
        let before = index_state(&conn);

        assert!(matches!(
            merge_duplicates(&mut conn, gone, &[dup], 50),
            Err(MergeError::KeeperGone)
        ));
        assert!(matches!(
            merge_duplicates(&mut conn, 999, &[dup], 50),
            Err(MergeError::KeeperGone)
        ));
        assert!(matches!(
            merge_duplicates(&mut conn, keeper, &[], 50),
            Err(MergeError::NoDiscards)
        ));
        assert!(matches!(
            merge_duplicates(&mut conn, keeper, &[dup, keeper], 50),
            Err(MergeError::KeeperInDiscards)
        ));
        assert!(matches!(
            merge_duplicates(&mut conn, keeper, &[dup, dup], 50),
            Err(MergeError::RepeatedDiscard)
        ));
        assert!(matches!(
            merge_duplicates(&mut conn, keeper, &[dup, 999], 50),
            Err(MergeError::UnknownTrack)
        ));
        assert_eq!(index_state(&conn), before);
    }

    #[test]
    fn slots_and_plays_move_to_the_keeper_and_a_playlist_may_hold_it_twice() {
        let mut conn = db::open_in_memory().unwrap();
        let keeper = insert_track(&conn, "/m/k.mp3", false);
        let dup = insert_track(&conn, "/m/d.mp3", false);
        let other = insert_track(&conn, "/m/o.mp3", false);
        let list = insert_playlist(&conn, &[keeper, other, dup]);
        insert_plays(&conn, keeper, 2);
        insert_plays(&conn, dup, 3);

        let receipt = merge_duplicates(&mut conn, keeper, &[dup], 50).unwrap();

        let slots: Vec<(i64, i64)> = conn
            .prepare(
                "SELECT track_id, position FROM playlist_tracks WHERE playlist_id = ?1 ORDER BY id",
            )
            .unwrap()
            .query_map(params![list], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(slots, vec![(keeper, 1), (other, 2), (keeper, 3)]);
        assert_eq!(receipt.moved_slots.len(), 1);
        assert_eq!(receipt.moved_slots[0].track_id, dup);

        assert_eq!(plays_of(&conn, keeper), 5);
        assert_eq!(plays_of(&conn, dup), 0);
        assert_eq!(receipt.moved_plays.len(), 3);
    }

    #[test]
    fn a_filed_keeper_stays_and_the_duplicate_leaves_its_album() {
        let mut conn = db::open_in_memory().unwrap();
        let keeper = insert_track(&conn, "/m/k.mp3", false);
        let dup = insert_track(&conn, "/m/d.mp3", false);
        let sibling = insert_track(&conn, "/m/s.mp3", false);
        let same = insert_track(&conn, "/m/same.mp3", false);
        let k = insert_album(&conn, Some("K"), 5, &[keeper, same]);
        let b = insert_album(&conn, Some("B"), 6, &[sibling, dup]);

        let receipt = merge_duplicates(&mut conn, keeper, &[dup, same], 50).unwrap();

        assert_eq!(membership(&conn, keeper).unwrap().album_id, k);
        assert_eq!(membership(&conn, dup), None);
        assert_eq!(membership(&conn, same), None);
        assert_eq!(membership(&conn, sibling).unwrap().album_id, b);
        assert_eq!(receipt.added_membership, None);
        assert_eq!(receipt.removed_memberships.len(), 2);
        assert_eq!(
            receipt.album_stamps,
            vec![
                MergeAlbumStamp {
                    album_id: k,
                    prev_updated_at: 5
                },
                MergeAlbumStamp {
                    album_id: b,
                    prev_updated_at: 6
                },
            ]
        );
        assert_eq!(db::get_album(&conn, b).unwrap().unwrap().updated_at, 50);
    }

    #[test]
    fn a_duplicate_that_is_its_albums_only_member_refuses_the_merge() {
        let mut conn = db::open_in_memory().unwrap();
        let keeper = insert_track(&conn, "/m/k.mp3", false);
        let dup = insert_track(&conn, "/m/d.mp3", false);
        let loose = insert_track(&conn, "/m/l.mp3", false);
        insert_album(&conn, Some("K"), 5, &[keeper]);
        insert_album(&conn, Some("Lonely"), 6, &[dup]);
        insert_playlist(&conn, &[dup, loose]);
        insert_plays(&conn, loose, 1);
        let before = index_state(&conn);

        let result = merge_duplicates(&mut conn, keeper, &[loose, dup], 50);

        match result {
            Err(e @ MergeError::EmptiesAlbum(_)) => {
                assert!(e.to_string().contains("\"Lonely\""));
            }
            other => panic!("expected EmptiesAlbum, got {other:?}"),
        }
        assert_eq!(index_state(&conn), before);
    }

    #[test]
    fn a_loose_keeper_takes_the_one_filed_duplicates_place() {
        let mut conn = db::open_in_memory().unwrap();
        let keeper = insert_track(&conn, "/m/k.mp3", false);
        let first = insert_track(&conn, "/m/1.mp3", false);
        let dup = insert_track(&conn, "/m/d.mp3", false);
        let loose = insert_track(&conn, "/m/l.mp3", false);
        let a = insert_album(&conn, Some("A"), 5, &[first, dup]);
        conn.execute(
            "UPDATE album_tracks SET track_no = 9, keep_own_cover = 1 WHERE track_id = ?1",
            params![dup],
        )
        .unwrap();

        let receipt = merge_duplicates(&mut conn, keeper, &[dup, loose], 50).unwrap();

        let taken = membership(&conn, keeper).unwrap();
        assert_eq!(taken.album_id, a);
        assert_eq!(taken.track_no, Some(9));
        assert!(taken.keep_own_cover);
        assert_eq!(membership(&conn, dup), None);
        assert_eq!(receipt.added_membership, Some(taken));
        assert_eq!(db::get_album(&conn, a).unwrap().unwrap().updated_at, 50);
    }

    #[test]
    fn a_loose_keeper_with_two_filed_duplicates_is_refused() {
        let mut conn = db::open_in_memory().unwrap();
        let keeper = insert_track(&conn, "/m/k.mp3", false);
        let one = insert_track(&conn, "/m/1.mp3", false);
        let two = insert_track(&conn, "/m/2.mp3", false);
        let pad = insert_track(&conn, "/m/p.mp3", false);
        insert_album(&conn, Some("A"), 5, &[one, pad]);
        insert_album(&conn, Some("B"), 6, &[two]);
        let before = index_state(&conn);

        assert!(matches!(
            merge_duplicates(&mut conn, keeper, &[one, two], 50),
            Err(MergeError::SeveralAlbums)
        ));
        assert_eq!(index_state(&conn), before);
    }

    #[test]
    fn a_merge_dismisses_the_group_and_records_only_new_pairs() {
        let mut conn = db::open_in_memory().unwrap();
        let keeper = insert_track(&conn, "/m/k.mp3", false);
        let d1 = insert_track(&conn, "/m/1.mp3", false);
        let d2 = insert_track(&conn, "/m/2.mp3", false);
        dismiss_duplicates(&mut conn, &[d1, d2], 10).unwrap();

        let receipt = merge_duplicates(&mut conn, keeper, &[d2, d1], 50).unwrap();

        assert_eq!(
            list_duplicate_dismissals(&conn).unwrap(),
            canonical_pairs(&[keeper, d1, d2])
        );
        assert_eq!(receipt.dismissed, vec![pair(keeper, d1), pair(keeper, d2)]);
    }

    #[test]
    fn a_merge_never_writes_tracks_or_edits() {
        let mut conn = db::open_in_memory().unwrap();
        let keeper = insert_track(&conn, "/m/k.mp3", false);
        let dup = insert_track(&conn, "/m/d.mp3", false);
        conn.execute(
            "INSERT INTO track_edits (track_id, title, updated_at) VALUES (?1, 'Edited', 1)",
            params![dup],
        )
        .unwrap();
        insert_album(&conn, Some("A"), 5, &[dup]);
        insert_playlist(&conn, &[dup]);
        insert_plays(&conn, dup, 1);
        let before = untouchable(&conn);

        let receipt = merge_duplicates(&mut conn, keeper, &[dup], 50).unwrap();
        assert_eq!(untouchable(&conn), before);

        undo_merge_duplicates(&mut conn, &receipt).unwrap();
        assert_eq!(untouchable(&conn), before);
    }

    #[test]
    fn undo_restores_every_row_and_stamp_exactly() {
        let mut conn = db::open_in_memory().unwrap();
        let keeper = insert_track(&conn, "/m/k.mp3", false);
        let d1 = insert_track(&conn, "/m/1.mp3", false);
        let d2 = insert_track(&conn, "/m/2.mp3", false);
        let pad = insert_track(&conn, "/m/p.mp3", false);
        insert_album(&conn, Some("A"), 5, &[pad, d1]);
        conn.execute(
            "UPDATE album_tracks SET keep_own_cover = 1 WHERE track_id = ?1",
            params![d1],
        )
        .unwrap();
        insert_playlist(&conn, &[d1, keeper, d2, d2]);
        insert_plays(&conn, d1, 2);
        insert_plays(&conn, d2, 1);
        dismiss_duplicates(&mut conn, &[d1, d2], 10).unwrap();
        let before = index_state(&conn);

        let receipt = merge_duplicates(&mut conn, keeper, &[d1, d2], 50).unwrap();
        assert_ne!(index_state(&conn), before);

        // The receipt survives the trip to the frontend and back.
        let wire = serde_json::to_string(&receipt).unwrap();
        let back: MergeReceipt = serde_json::from_str(&wire).unwrap();
        assert_eq!(back, receipt);

        undo_merge_duplicates(&mut conn, &back).unwrap();
        assert_eq!(index_state(&conn), before);
    }

    #[test]
    fn undo_restores_a_membership_the_keeper_took_over() {
        let mut conn = db::open_in_memory().unwrap();
        let keeper = insert_track(&conn, "/m/k.mp3", false);
        let dup = insert_track(&conn, "/m/d.mp3", false);
        insert_album(&conn, Some("A"), 5, &[dup]);
        let before = index_state(&conn);

        let receipt = merge_duplicates(&mut conn, keeper, &[dup], 50).unwrap();
        undo_merge_duplicates(&mut conn, &receipt).unwrap();

        assert_eq!(index_state(&conn), before);
    }

    #[test]
    fn a_stale_undo_is_refused_with_nothing_changed() {
        let mut conn = db::open_in_memory().unwrap();
        let keeper = insert_track(&conn, "/m/k.mp3", false);
        let dup = insert_track(&conn, "/m/d.mp3", false);
        let other = insert_track(&conn, "/m/o.mp3", false);
        insert_album(&conn, Some("A"), 5, &[other, dup]);
        insert_playlist(&conn, &[dup]);
        insert_plays(&conn, dup, 1);
        let receipt = merge_duplicates(&mut conn, keeper, &[dup], 50).unwrap();

        conn.execute(
            "UPDATE playlist_tracks SET track_id = ?1 WHERE id = ?2",
            params![other, receipt.moved_slots[0].id],
        )
        .unwrap();
        let before = index_state(&conn);

        assert!(matches!(
            undo_merge_duplicates(&mut conn, &receipt),
            Err(MergeError::Stale)
        ));
        assert_eq!(index_state(&conn), before);
    }
}
