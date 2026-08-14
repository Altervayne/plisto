/*
 * Building the list_tracks SQL as pure text, kept apart from the command so it is testable
 * without a database. The sort column is checked against an explicit allowlist: any column not
 * on it is rejected, so a sort request can never inject SQL. The filter binds a single LIKE
 * term across the text columns; offset and limit are typed integers, safe to inline.
 */

// -- Type Imports --
use crate::dto::{SortDir, SortSpec};

// The columns a caller may sort by. Only these literals ever reach the ORDER BY clause.
const SORTABLE: &[&str] = &[
    "id",
    "source_path",
    "filename",
    "ext",
    "size_bytes",
    "mtime",
    "duration_secs",
    "raw_title",
    "raw_artist",
    "raw_album",
    "raw_album_artist",
    "raw_track_no",
    "raw_disc_no",
    "raw_year",
    "raw_genre",
    "scanned_at",
    "missing_at",
];

// The columns the free-text filter searches.
const FILTER_COLUMNS: &[&str] = &[
    "raw_title",
    "raw_artist",
    "raw_album",
    "raw_album_artist",
    "raw_genre",
    "filename",
];

// The row source: `tracks` with its edit layer joined in. A LEFT JOIN so a track with no
// `track_edits` row still returns, its edit columns NULL. The join is 1:1 on the track's id, so it
// never fans a track out into more than one row.
const FROM_CLAUSE: &str = "tracks LEFT JOIN track_edits te ON te.track_id = tracks.id";

// The row projection, in TrackRow field order. Columns are qualified with `tracks.` so the join
// stays unambiguous; the edit layer follows as aliased `*_edit` columns the frontend resolves
// against the raw fields.
const ROW_COLUMNS: &str = "tracks.id, tracks.source_path, tracks.filename, tracks.ext, \
     tracks.size_bytes, tracks.mtime, tracks.duration_secs, tracks.raw_title, tracks.raw_artist, \
     tracks.raw_album, tracks.raw_album_artist, tracks.raw_track_no, tracks.raw_disc_no, \
     tracks.raw_year, tracks.raw_genre, tracks.scanned_at, tracks.missing_at, tracks.display_path, \
     te.title AS title_edit, te.artist AS artist_edit, te.album AS album_edit, \
     te.album_artist AS album_artist_edit, te.year AS year_edit, te.disc_no AS disc_edit";

/// A built query: the row select, the matching count select, and the LIKE term to bind when a
/// filter is present. Both statements share the term as `?1`.
pub struct ListQuery {
    pub rows_sql: String,
    pub count_sql: String,
    pub like_term: Option<String>,
}

/// Builds the row and count SQL for a list request. Returns an error when `sort` names a column
/// outside the allowlist. When both `offset` and `limit` are None, the row query returns every
/// matching row.
pub fn build_list_query(
    filter: Option<&str>,
    sort: Option<&SortSpec>,
    offset: Option<u32>,
    limit: Option<u32>,
) -> Result<ListQuery, String> {
    let like_term = filter
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| format!("%{s}%"));

    let where_clause = if like_term.is_some() {
        let ors = FILTER_COLUMNS
            .iter()
            .map(|c| format!("{c} LIKE ?1"))
            .collect::<Vec<_>>()
            .join(" OR ");
        format!(" WHERE {ors}")
    } else {
        String::new()
    };

    let order_clause = match sort {
        Some(spec) => {
            if !SORTABLE.contains(&spec.column.as_str()) {
                return Err(format!("invalid sort column: {}", spec.column));
            }
            let dir = match spec.dir {
                SortDir::Asc => "ASC",
                SortDir::Desc => "DESC",
            };
            format!(" ORDER BY {} {dir}", spec.column)
        }
        None => String::new(),
    };

    // SQLite needs a LIMIT before an OFFSET; -1 means unbounded so an offset can stand alone.
    let window_clause = match (limit, offset) {
        (None, None) => String::new(),
        (lim, off) => {
            let mut clause = format!(" LIMIT {}", lim.map(i64::from).unwrap_or(-1));
            if let Some(off) = off {
                clause.push_str(&format!(" OFFSET {off}"));
            }
            clause
        }
    };

    let rows_sql = format!(
        "SELECT {ROW_COLUMNS} FROM {FROM_CLAUSE}{where_clause}{order_clause}{window_clause}"
    );
    // The count stays on the bare table: a per-track count needs no join, and the LEFT JOIN would
    // not change it (one row per track) even if it were present.
    let count_sql = format!("SELECT COUNT(*) FROM tracks{where_clause}");

    Ok(ListQuery {
        rows_sql,
        count_sql,
        like_term,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_filter_no_sort_no_window_selects_all() {
        let q = build_list_query(None, None, None, None).unwrap();
        assert_eq!(
            q.rows_sql,
            format!("SELECT {ROW_COLUMNS} FROM {FROM_CLAUSE}")
        );
        assert_eq!(q.count_sql, "SELECT COUNT(*) FROM tracks");
        assert!(q.like_term.is_none());
    }

    #[test]
    fn projection_joins_the_edit_layer() {
        let q = build_list_query(None, None, None, None).unwrap();
        assert!(q
            .rows_sql
            .contains("LEFT JOIN track_edits te ON te.track_id = tracks.id"));
        assert!(q.rows_sql.contains("te.title AS title_edit"));
        // The count is not joined; it stays a per-track count over the bare table.
        assert_eq!(q.count_sql, "SELECT COUNT(*) FROM tracks");
    }

    #[test]
    fn filter_builds_like_across_text_columns() {
        let q = build_list_query(Some("beat"), None, None, None).unwrap();
        assert_eq!(q.like_term.as_deref(), Some("%beat%"));
        assert!(q.rows_sql.contains("raw_title LIKE ?1"));
        assert!(q.rows_sql.contains("filename LIKE ?1"));
        assert!(q.count_sql.contains("WHERE"));
    }

    #[test]
    fn blank_filter_is_ignored() {
        let q = build_list_query(Some("   "), None, None, None).unwrap();
        assert!(q.like_term.is_none());
        assert!(!q.rows_sql.contains("WHERE"));
    }

    #[test]
    fn allowlisted_sort_shapes_order_by() {
        let spec = SortSpec {
            column: "raw_artist".to_string(),
            dir: SortDir::Desc,
        };
        let q = build_list_query(None, Some(&spec), None, None).unwrap();
        assert!(q.rows_sql.ends_with("ORDER BY raw_artist DESC"));
    }

    #[test]
    fn non_allowlisted_sort_is_rejected() {
        let spec = SortSpec {
            column: "raw_artist; DROP TABLE tracks".to_string(),
            dir: SortDir::Asc,
        };
        assert!(build_list_query(None, Some(&spec), None, None).is_err());
    }

    #[test]
    fn limit_and_offset_shape_the_window() {
        let q = build_list_query(None, None, Some(50), Some(100)).unwrap();
        assert!(q.rows_sql.ends_with("LIMIT 100 OFFSET 50"));
    }

    #[test]
    fn offset_alone_uses_an_unbounded_limit() {
        let q = build_list_query(None, None, Some(25), None).unwrap();
        assert!(q.rows_sql.ends_with("LIMIT -1 OFFSET 25"));
    }
}
