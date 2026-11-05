/*
 * The measurement queue, read straight from `tracks`: a present row is pending while its tags were never
 * examined for ReplayGain, or while it has no tag track gain and no measurement stamped at its current
 * size and mtime. A stamp equal to the row's stats is final, whatever value it holds, so a silent or
 * undecodable file is tried once per version. The coverage counts partition the present rows on the same
 * predicate, so pending there is exactly what the worker still has to visit.
 */

// -- Library Imports --
use std::path::PathBuf;

use rusqlite::{params, Connection, OptionalExtension};

// -- Type Imports --
use crate::dto::LoudnessCoverage;

// A measurement stamp that does not describe the row's current file.
const STALE: &str = "NOT (loudness_size IS size_bytes AND loudness_mtime IS mtime)";

/// The pending predicate over `tracks`.
fn pending_sql() -> String {
    format!(
        "missing_at IS NULL AND (gain_tags_read IS NULL OR (rg_track_gain IS NULL AND {STALE}))"
    )
}

/// One row the worker still has to visit. `path` is the real-case path; `size_bytes` and `mtime` are
/// the stats every write is conditioned on.
#[derive(Debug, Clone, PartialEq)]
pub struct PendingRow {
    pub id: i64,
    pub path: PathBuf,
    pub root_id: Option<i64>,
    pub size_bytes: i64,
    pub mtime: i64,
    /// The tags were never examined for ReplayGain.
    pub needs_tags: bool,
    /// No tag track gain is known and no measurement is stamped at the current stats.
    pub needs_measure: bool,
}

/// The first pending row with an id above `after`, in id order, so a sweep moves past a row it had to
/// leave without writing.
pub fn next_pending(conn: &Connection, after: i64) -> rusqlite::Result<Option<PendingRow>> {
    let sql = format!(
        "SELECT id, COALESCE(display_path, source_path), root_id, size_bytes, mtime,
                gain_tags_read IS NULL, rg_track_gain IS NULL AND {STALE}
         FROM tracks WHERE id > ?1 AND {} ORDER BY id LIMIT 1",
        pending_sql()
    );
    conn.query_row(&sql, params![after], |r| {
        Ok(PendingRow {
            id: r.get(0)?,
            path: PathBuf::from(r.get::<_, String>(1)?),
            root_id: r.get(2)?,
            size_bytes: r.get(3)?,
            mtime: r.get(4)?,
            needs_tags: r.get(5)?,
            needs_measure: r.get(6)?,
        })
    })
    .optional()
}

/// How the present rows stand: a tag track gain, a measured value, tried with no value, or pending.
/// The four buckets sum to `total`.
pub fn coverage(conn: &Connection) -> rusqlite::Result<LoudnessCoverage> {
    let settled = format!("rg_track_gain IS NULL AND gain_tags_read IS NOT NULL AND NOT {STALE}");
    let sql = format!(
        "SELECT COUNT(*),
                COALESCE(SUM(rg_track_gain IS NOT NULL), 0),
                COALESCE(SUM({settled} AND loudness_lufs IS NOT NULL), 0),
                COALESCE(SUM({settled} AND loudness_lufs IS NULL), 0),
                COALESCE(SUM({}), 0)
         FROM tracks WHERE missing_at IS NULL",
        pending_sql()
    );
    conn.query_row(&sql, [], |r| {
        Ok(LoudnessCoverage {
            total: r.get(0)?,
            tagged: r.get(1)?,
            measured: r.get(2)?,
            unmeasurable: r.get(3)?,
            pending: r.get(4)?,
        })
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::db;

    /// Inserts a present row at size 10, mtime 20 and returns its id.
    pub(crate) fn insert_track(conn: &Connection, name: &str) -> i64 {
        conn.execute(
            "INSERT INTO tracks (source_path, display_path, filename, ext, size_bytes, mtime,
                                 has_embedded_cover, scanned_at)
             VALUES (?1, ?1, ?1, 'flac', 10, 20, 0, 30)",
            params![format!("/m/{name}")],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    fn set(conn: &Connection, id: i64, assignments: &str) {
        conn.execute(
            &format!("UPDATE tracks SET {assignments} WHERE id = ?1"),
            params![id],
        )
        .unwrap();
    }

    fn pending_ids(conn: &Connection) -> Vec<i64> {
        let mut ids = Vec::new();
        let mut after = 0;
        while let Some(row) = next_pending(conn, after).unwrap() {
            ids.push(row.id);
            after = row.id;
        }
        ids
    }

    #[test]
    fn the_queue_holds_exactly_the_rows_still_to_visit() {
        let conn = db::open_in_memory().unwrap();
        let never_read = insert_track(&conn, "never_read");
        let tagged = insert_track(&conn, "tagged");
        set(&conn, tagged, "gain_tags_read = 1, rg_track_gain = -6.0");
        let unstamped = insert_track(&conn, "unstamped");
        set(&conn, unstamped, "gain_tags_read = 1");
        let measured = insert_track(&conn, "measured");
        set(
            &conn,
            measured,
            "gain_tags_read = 1, loudness_lufs = -14.0, loudness_size = 10, loudness_mtime = 20",
        );
        let tried = insert_track(&conn, "tried");
        set(
            &conn,
            tried,
            "gain_tags_read = 1, loudness_size = 10, loudness_mtime = 20",
        );
        let size_moved = insert_track(&conn, "size_moved");
        set(
            &conn,
            size_moved,
            "gain_tags_read = 1, loudness_lufs = -14.0, loudness_size = 11, loudness_mtime = 20",
        );
        let mtime_moved = insert_track(&conn, "mtime_moved");
        set(
            &conn,
            mtime_moved,
            "gain_tags_read = 1, loudness_lufs = -14.0, loudness_size = 10, loudness_mtime = 21",
        );
        let missing = insert_track(&conn, "missing");
        set(&conn, missing, "missing_at = 5");

        assert_eq!(
            pending_ids(&conn),
            vec![never_read, unstamped, size_moved, mtime_moved]
        );
    }

    #[test]
    fn a_pending_row_says_what_it_needs() {
        let conn = db::open_in_memory().unwrap();
        let never_read = insert_track(&conn, "never_read");
        let read_unmeasured = insert_track(&conn, "read_unmeasured");
        set(&conn, read_unmeasured, "gain_tags_read = 1");
        // Measured under an earlier version of the file, tags never examined since.
        let stamped_unread = insert_track(&conn, "stamped_unread");
        set(
            &conn,
            stamped_unread,
            "loudness_lufs = -9.0, loudness_size = 10, loudness_mtime = 20",
        );

        let row = next_pending(&conn, 0).unwrap().unwrap();
        assert_eq!(row.id, never_read);
        assert!(row.needs_tags && row.needs_measure);
        assert_eq!(row.path, PathBuf::from("/m/never_read"));
        assert_eq!((row.size_bytes, row.mtime), (10, 20));

        let row = next_pending(&conn, never_read).unwrap().unwrap();
        assert_eq!(row.id, read_unmeasured);
        assert!(!row.needs_tags && row.needs_measure);

        let row = next_pending(&conn, read_unmeasured).unwrap().unwrap();
        assert_eq!(row.id, stamped_unread);
        assert!(row.needs_tags && !row.needs_measure);

        assert_eq!(next_pending(&conn, stamped_unread).unwrap(), None);
    }

    #[test]
    fn coverage_partitions_the_present_rows() {
        let conn = db::open_in_memory().unwrap();
        insert_track(&conn, "never_read");
        let tagged = insert_track(&conn, "tagged");
        set(&conn, tagged, "gain_tags_read = 1, rg_track_gain = -6.0");
        let measured = insert_track(&conn, "measured");
        set(
            &conn,
            measured,
            "gain_tags_read = 1, loudness_lufs = -14.0, loudness_size = 10, loudness_mtime = 20",
        );
        let tried = insert_track(&conn, "tried");
        set(
            &conn,
            tried,
            "gain_tags_read = 1, loudness_size = 10, loudness_mtime = 20",
        );
        let stale = insert_track(&conn, "stale");
        set(
            &conn,
            stale,
            "gain_tags_read = 1, loudness_lufs = -14.0, loudness_size = 9, loudness_mtime = 20",
        );
        let missing = insert_track(&conn, "missing");
        set(&conn, missing, "missing_at = 5");

        let c = coverage(&conn).unwrap();
        assert_eq!(
            (c.total, c.tagged, c.measured, c.unmeasurable, c.pending),
            (5, 1, 1, 1, 2)
        );
        assert_eq!(c.tagged + c.measured + c.unmeasurable + c.pending, c.total);
    }

    #[test]
    fn an_empty_library_has_zero_coverage() {
        let conn = db::open_in_memory().unwrap();
        let c = coverage(&conn).unwrap();
        assert_eq!(
            (c.total, c.tagged, c.measured, c.unmeasurable, c.pending),
            (0, 0, 0, 0, 0)
        );
    }
}
