/*
 * The export record: per destination, the fingerprint of every file an export landed there. A
 * changed-only export diffs its plan against these rows. Rows are only ever added, refreshed, or
 * dropped whole for a destination found empty; a file that leaves the plan keeps its row, since the
 * copy is still on the destination.
 */

// -- Library Imports --
use std::collections::HashMap;

use rusqlite::{params, Connection};

/// Every recorded file of one destination as `rel_path -> fingerprint`.
pub fn export_ledger(
    conn: &Connection,
    dest_key: &str,
) -> rusqlite::Result<HashMap<String, String>> {
    let mut stmt =
        conn.prepare("SELECT rel_path, fingerprint FROM export_ledger WHERE dest_key = ?1")?;
    let rows = stmt
        .query_map(params![dest_key], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<HashMap<_, _>>>()?;
    Ok(rows)
}

/// When one destination last received a file, or None when it carries no record at all.
pub fn export_ledger_last(conn: &Connection, dest_key: &str) -> rusqlite::Result<Option<i64>> {
    conn.query_row(
        "SELECT MAX(exported_at) FROM export_ledger WHERE dest_key = ?1",
        params![dest_key],
        |r| r.get(0),
    )
}

/// Upserts one row per `(rel_path, fingerprint)` for a destination, stamped `exported_at`, in one
/// transaction. A row already there takes the new fingerprint and stamp.
pub fn record_export_files(
    conn: &mut Connection,
    dest_key: &str,
    files: &[(String, String)],
    exported_at: i64,
) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO export_ledger (dest_key, rel_path, fingerprint, exported_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(dest_key, rel_path) DO UPDATE SET
                fingerprint = excluded.fingerprint,
                exported_at = excluded.exported_at",
        )?;
        for (rel_path, fingerprint) in files {
            stmt.execute(params![dest_key, rel_path, fingerprint, exported_at])?;
        }
    }
    tx.commit()
}

/// Drops a destination's whole record, for one found missing or empty: nothing recorded is there.
pub fn clear_export_ledger(conn: &Connection, dest_key: &str) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM export_ledger WHERE dest_key = ?1",
        params![dest_key],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn rows(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect()
    }

    #[test]
    fn records_upsert_per_destination_and_clear_drops_one_destination() {
        let mut conn = db::open_in_memory().unwrap();
        record_export_files(&mut conn, "a", &rows(&[("x.mp3", "1"), ("y.mp3", "2")]), 10).unwrap();
        record_export_files(&mut conn, "b", &rows(&[("x.mp3", "9")]), 20).unwrap();
        record_export_files(&mut conn, "a", &rows(&[("x.mp3", "3")]), 30).unwrap();

        let a = export_ledger(&conn, "a").unwrap();
        assert_eq!(a.len(), 2);
        assert_eq!(a["x.mp3"], "3", "a re-record refreshes the fingerprint");
        assert_eq!(a["y.mp3"], "2", "an untouched row stays");
        assert_eq!(export_ledger_last(&conn, "a").unwrap(), Some(30));
        assert_eq!(export_ledger_last(&conn, "none").unwrap(), None);

        clear_export_ledger(&conn, "a").unwrap();
        assert!(export_ledger(&conn, "a").unwrap().is_empty());
        assert_eq!(
            export_ledger(&conn, "b").unwrap().len(),
            1,
            "another destination keeps its record"
        );
    }
}
