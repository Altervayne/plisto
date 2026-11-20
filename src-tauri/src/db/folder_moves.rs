/*
 * The record of folders located at a new place: each entry says that the files under one folder of a
 * root were found under another folder, of the same root or another. Both folders are stored folded
 * and relative to their roots, so a root pointed at a new location leaves every entry valid. A restore
 * reads the record to follow a point's tracks to where a locate put them. Kept newest first and capped,
 * so a point older than the oldest entry falls back to the other matching rules.
 */

// -- Library Imports --
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

// -- Local Imports --
use super::{get_setting, set_setting};

// The settings key holding the record, as JSON.
const FOLDER_MOVES: &str = "folder_moves";
const MAX_MOVES: usize = 64;

/// One located folder: the folded path below `from_root_id` its files left, the folded path below
/// `to_root_id` they were found under, and the locate's time. An empty path is the root itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FolderMove {
    pub from_root_id: i64,
    pub from_rel: String,
    pub to_root_id: i64,
    pub to_rel: String,
    pub at: i64,
}

/// Every recorded folder move, newest first. An absent or unreadable value reads as none.
pub fn folder_moves(conn: &Connection) -> rusqlite::Result<Vec<FolderMove>> {
    Ok(get_setting(conn, FOLDER_MOVES)?
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default())
}

/// Records `entry` as the newest move, dropping the oldest past MAX_MOVES.
pub(super) fn record_folder_move(conn: &Connection, entry: FolderMove) -> rusqlite::Result<()> {
    let mut moves = folder_moves(conn)?;
    moves.insert(0, entry);
    moves.truncate(MAX_MOVES);
    write_moves(conn, &moves)
}

/// Hands every move naming `absorbed` to `kept`, for a root folded into another. A move that now
/// leads from a folder to itself says nothing and goes.
pub(super) fn reid_folder_moves(conn: &Connection, absorbed: i64, kept: i64) -> rusqlite::Result<()> {
    let moves = folder_moves(conn)?;
    if !moves.iter().any(|m| names(m, absorbed)) {
        return Ok(());
    }
    let reid = |id: i64| if id == absorbed { kept } else { id };
    let moves: Vec<FolderMove> = moves
        .into_iter()
        .map(|m| FolderMove {
            from_root_id: reid(m.from_root_id),
            to_root_id: reid(m.to_root_id),
            ..m
        })
        .filter(|m| m.from_root_id != m.to_root_id || m.from_rel != m.to_rel)
        .collect();
    write_moves(conn, &moves)
}

/// Drops every move naming `root_id` on either side, for a root removed from the library.
pub(super) fn forget_folder_moves(conn: &Connection, root_id: i64) -> rusqlite::Result<()> {
    let mut moves = folder_moves(conn)?;
    let before = moves.len();
    moves.retain(|m| !names(m, root_id));
    if moves.len() == before {
        return Ok(());
    }
    write_moves(conn, &moves)
}

fn names(m: &FolderMove, root_id: i64) -> bool {
    m.from_root_id == root_id || m.to_root_id == root_id
}

fn write_moves(conn: &Connection, moves: &[FolderMove]) -> rusqlite::Result<()> {
    let json = serde_json::to_string(moves)
        .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
    set_setting(conn, FOLDER_MOVES, &json)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::normalize::normalize_path_key;

    fn add_root(conn: &Connection, path: &str) -> i64 {
        db::insert_root(conn, &normalize_path_key(path), path, 1).unwrap()
    }

    fn entry(from_root_id: i64, from_rel: &str, to_root_id: i64, to_rel: &str, at: i64) -> FolderMove {
        FolderMove {
            from_root_id,
            from_rel: from_rel.to_string(),
            to_root_id,
            to_rel: to_rel.to_string(),
            at,
        }
    }

    #[test]
    fn the_record_keeps_the_newest_moves_first_up_to_the_cap() {
        let conn = db::open_in_memory().unwrap();
        for at in 1..=(MAX_MOVES as i64 + 6) {
            record_folder_move(&conn, entry(1, "old", 1, "new", at)).unwrap();
        }

        let moves = folder_moves(&conn).unwrap();
        assert_eq!(moves.len(), MAX_MOVES);
        assert_eq!(moves[0].at, MAX_MOVES as i64 + 6, "newest first");
        assert_eq!(moves[MAX_MOVES - 1].at, 7, "the oldest six are dropped");
    }

    #[test]
    fn an_absent_or_garbled_record_reads_as_none() {
        let conn = db::open_in_memory().unwrap();
        assert_eq!(folder_moves(&conn).unwrap(), vec![]);
        set_setting(&conn, FOLDER_MOVES, "{not json").unwrap();
        assert_eq!(folder_moves(&conn).unwrap(), vec![]);
    }

    #[test]
    fn a_merge_hands_the_absorbed_roots_moves_to_the_kept_root() {
        let mut conn = db::open_in_memory().unwrap();
        let keep = add_root(&conn, "/Music/Old");
        let absorb = add_root(&conn, "/Music/New");
        let other = add_root(&conn, "/Other");
        record_folder_move(&conn, entry(absorb, "a", absorb, "b", 1)).unwrap();
        record_folder_move(&conn, entry(other, "x", absorb, "y", 2)).unwrap();
        record_folder_move(&conn, entry(keep, "same", absorb, "same", 3)).unwrap();
        record_folder_move(&conn, entry(other, "p", other, "q", 4)).unwrap();

        db::merge_root(&mut conn, keep, absorb, 50).unwrap();

        assert_eq!(
            folder_moves(&conn).unwrap(),
            vec![
                entry(other, "p", other, "q", 4),
                entry(other, "x", keep, "y", 2),
                entry(keep, "a", keep, "b", 1),
            ],
            "a move into the absorbed root's same folder leads nowhere once both are one root"
        );
    }

    #[test]
    fn removing_a_root_forgets_every_move_naming_it() {
        let mut conn = db::open_in_memory().unwrap();
        let a = add_root(&conn, "/A");
        let b = add_root(&conn, "/B");
        let c = add_root(&conn, "/C");
        record_folder_move(&conn, entry(a, "x", a, "y", 1)).unwrap();
        record_folder_move(&conn, entry(b, "x", a, "y", 2)).unwrap();
        record_folder_move(&conn, entry(b, "x", c, "y", 3)).unwrap();

        db::remove_root(&mut conn, a).unwrap();

        assert_eq!(folder_moves(&conn).unwrap(), vec![entry(b, "x", c, "y", 3)]);
    }
}
