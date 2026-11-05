/*
 * The worker's only writes: single-row UPDATEs conditioned on the row's `size_bytes` and `mtime`, so a
 * rescan that lands while a file is being read turns the write into a no-op. They touch the loudness
 * group, and for the tags backfill the `rg_*` columns and `gain_tags_read`, and nothing else: the
 * scan's change detection, the export fingerprint and the library deltas never see them.
 */

// -- Library Imports --
use std::path::Path;

use rusqlite::{params, Connection};

// -- Local Imports --
use crate::normalize::normalize_track;
use crate::scan::read_tags;

/// The file version a write is conditioned on: the row's stats when the visit started.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Stamp {
    pub size_bytes: i64,
    pub mtime: i64,
}

/// A file's tag ReplayGain, parsed through the scan's normalization.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct GainTags {
    pub track_gain: Option<f64>,
    pub track_peak: Option<f64>,
    pub album_gain: Option<f64>,
    pub album_peak: Option<f64>,
}

/// A measured integrated loudness in LUFS and sample peak as linear amplitude.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Loudness {
    pub lufs: f64,
    pub peak: f64,
}

/// Reads the ReplayGain tags of the file at `path` with the scan's own reader, so the Opus R128
/// handling and the parsing rules are the same. A file lofty cannot parse reads as untagged.
pub fn read_gain_tags(path: &Path) -> GainTags {
    let (raw, _) = read_tags(path);
    let rec = normalize_track(&path.to_string_lossy(), 0, 0, 0, &raw);
    GainTags {
        track_gain: rec.rg_track_gain,
        track_peak: rec.rg_track_peak,
        album_gain: rec.rg_album_gain,
        album_peak: rec.rg_album_peak,
    }
}

/// Stores the tag gains of a row whose tags were never examined. False when the row moved past
/// `stamp` or was examined meanwhile, in which case nothing is written.
pub fn write_gain_tags(
    conn: &Connection,
    id: i64,
    stamp: Stamp,
    tags: &GainTags,
) -> rusqlite::Result<bool> {
    let changed = conn.execute(
        "UPDATE tracks SET rg_track_gain = ?4, rg_track_peak = ?5, rg_album_gain = ?6,
                           rg_album_peak = ?7, gain_tags_read = 1
         WHERE id = ?1 AND size_bytes = ?2 AND mtime = ?3 AND gain_tags_read IS NULL",
        params![
            id,
            stamp.size_bytes,
            stamp.mtime,
            tags.track_gain,
            tags.track_peak,
            tags.album_gain,
            tags.album_peak
        ],
    )?;
    Ok(changed == 1)
}

/// Stamps a row with its measurement at `stamp`. None records a file that opened but gave no value
/// (undecodable or silent), so it is not tried again until it changes. False when the row moved past
/// `stamp`, in which case nothing is written.
pub fn write_loudness(
    conn: &Connection,
    id: i64,
    stamp: Stamp,
    loudness: Option<Loudness>,
) -> rusqlite::Result<bool> {
    let changed = conn.execute(
        "UPDATE tracks SET loudness_lufs = ?4, loudness_peak = ?5, loudness_size = ?2,
                           loudness_mtime = ?3
         WHERE id = ?1 AND size_bytes = ?2 AND mtime = ?3",
        params![
            id,
            stamp.size_bytes,
            stamp.mtime,
            loudness.map(|l| l.lufs),
            loudness.map(|l| l.peak)
        ],
    )?;
    Ok(changed == 1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::loudness::queue::tests::insert_track;

    const STAMP: Stamp = Stamp {
        size_bytes: 10,
        mtime: 20,
    };

    const MEASURED: Loudness = Loudness {
        lufs: -14.0,
        peak: 0.8,
    };

    fn loudness_of(
        conn: &Connection,
        id: i64,
    ) -> (Option<f64>, Option<f64>, Option<i64>, Option<i64>) {
        conn.query_row(
            "SELECT loudness_lufs, loudness_peak, loudness_size, loudness_mtime FROM tracks
             WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap()
    }

    // Every column of the row outside the loudness group and the tag gains, as text.
    fn other_columns(conn: &Connection, id: i64) -> Vec<String> {
        let skip = [
            "loudness_lufs",
            "loudness_peak",
            "loudness_size",
            "loudness_mtime",
            "rg_track_gain",
            "rg_track_peak",
            "rg_album_gain",
            "rg_album_peak",
            "gain_tags_read",
        ];
        let mut stmt = conn.prepare("SELECT * FROM tracks WHERE id = ?1").unwrap();
        let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
        stmt.query_row([id], |r| {
            let mut out = Vec::new();
            for (i, name) in names.iter().enumerate() {
                if !skip.contains(&name.as_str()) {
                    let v: rusqlite::types::Value = r.get(i)?;
                    out.push(format!("{name}={v:?}"));
                }
            }
            Ok(out)
        })
        .unwrap()
    }

    #[test]
    fn a_measurement_stamps_the_row() {
        let conn = db::open_in_memory().unwrap();
        let id = insert_track(&conn, "a");
        assert!(write_loudness(&conn, id, STAMP, Some(MEASURED)).unwrap());
        assert_eq!(
            loudness_of(&conn, id),
            (Some(-14.0), Some(0.8), Some(10), Some(20))
        );
    }

    #[test]
    fn a_file_with_no_value_is_stamped_with_a_null_loudness() {
        let conn = db::open_in_memory().unwrap();
        let id = insert_track(&conn, "a");
        assert!(write_loudness(&conn, id, STAMP, None).unwrap());
        assert_eq!(loudness_of(&conn, id), (None, None, Some(10), Some(20)));
    }

    #[test]
    fn a_write_is_a_no_op_once_the_size_or_mtime_moved() {
        let conn = db::open_in_memory().unwrap();
        let resized = insert_track(&conn, "resized");
        let touched = insert_track(&conn, "touched");
        // A rescan landing mid-measure moves the row's stats.
        conn.execute("UPDATE tracks SET size_bytes = 11 WHERE id = ?1", [resized])
            .unwrap();
        conn.execute("UPDATE tracks SET mtime = 21 WHERE id = ?1", [touched])
            .unwrap();

        for id in [resized, touched] {
            assert!(!write_loudness(&conn, id, STAMP, Some(MEASURED)).unwrap());
            assert_eq!(loudness_of(&conn, id), (None, None, None, None));
            let tags = GainTags {
                track_gain: Some(-6.0),
                ..GainTags::default()
            };
            assert!(!write_gain_tags(&conn, id, STAMP, &tags).unwrap());
            let read: Option<i64> = conn
                .query_row(
                    "SELECT gain_tags_read FROM tracks WHERE id = ?1",
                    [id],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(read, None);
        }
    }

    #[test]
    fn the_tags_backfill_writes_once_and_never_over_a_scan_read() {
        let conn = db::open_in_memory().unwrap();
        let id = insert_track(&conn, "a");
        let tags = GainTags {
            track_gain: Some(-6.5),
            track_peak: Some(0.9),
            album_gain: Some(-7.0),
            album_peak: Some(0.95),
        };
        assert!(write_gain_tags(&conn, id, STAMP, &tags).unwrap());
        assert!(!write_gain_tags(&conn, id, STAMP, &GainTags::default()).unwrap());

        let (gains, read): (GainTags, Option<i64>) = conn
            .query_row(
                "SELECT rg_track_gain, rg_track_peak, rg_album_gain, rg_album_peak, gain_tags_read
                 FROM tracks WHERE id = ?1",
                [id],
                |r| {
                    let gains = GainTags {
                        track_gain: r.get(0)?,
                        track_peak: r.get(1)?,
                        album_gain: r.get(2)?,
                        album_peak: r.get(3)?,
                    };
                    Ok((gains, r.get(4)?))
                },
            )
            .unwrap();
        assert_eq!((gains, read), (tags, Some(1)));
    }

    #[test]
    fn the_writes_touch_no_other_column() {
        let conn = db::open_in_memory().unwrap();
        let id = insert_track(&conn, "a");
        let before = other_columns(&conn, id);
        let tags = GainTags {
            track_gain: Some(-6.5),
            ..GainTags::default()
        };
        assert!(write_gain_tags(&conn, id, STAMP, &tags).unwrap());
        assert!(write_loudness(&conn, id, STAMP, Some(MEASURED)).unwrap());
        assert_eq!(other_columns(&conn, id), before);
    }
}
