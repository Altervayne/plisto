/*
 * Listing points. Each finished point is opened read-only and only its `meta` row is read. A file that
 * is cut short, does not open, or has no readable meta is listed as unreadable, and one written by a
 * newer format is listed as newer: the list itself never fails on a bad file.
 */

// -- Library Imports --
use std::io::{self, Read};
use std::path::Path;

use rusqlite::{Connection, OpenFlags};

// -- Local Imports --
use super::format::{Reason, FORMAT_VERSION};
use super::point_files;

/// One point file, newest first in a listing. `reason` and `created_at` come from its name.
#[derive(Debug, Clone, PartialEq)]
pub struct PointEntry {
    pub file: String,
    pub reason: Reason,
    pub created_at: i64,
    pub bytes: u64,
    pub status: PointStatus,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PointStatus {
    Ready(PointMeta),
    /// Written by a later format; this build cannot read past its meta format.
    Newer { format: i64 },
    Unreadable { error: String },
}

/// A point's meta row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PointMeta {
    pub format: i64,
    pub app_version: String,
    pub schema_version: i64,
    pub created_at: i64,
    pub reason: String,
    pub detail: Option<String>,
    pub albums: i64,
    pub singles: i64,
    pub playlists: i64,
    pub filed_tracks: i64,
    pub edited_tracks: i64,
    pub genre_tracks: i64,
    pub content_hash: String,
}

/// Every finished point in `dir`, newest first. A missing folder lists nothing.
pub fn list(dir: &Path) -> io::Result<Vec<PointEntry>> {
    let mut files = point_files(dir)?;
    files.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(b.name.cmp(&a.name)));
    Ok(files
        .into_iter()
        .map(|f| PointEntry {
            status: read_status(&f.path, f.bytes),
            file: f.name,
            reason: f.reason,
            created_at: f.created_at,
            bytes: f.bytes,
        })
        .collect())
}

fn read_status(path: &Path, bytes: u64) -> PointStatus {
    if let Err(error) = check_length(path, bytes) {
        return PointStatus::Unreadable { error };
    }
    match read_meta(path) {
        Ok(status) => status,
        Err(e) => PointStatus::Unreadable {
            error: e.to_string(),
        },
    }
}

// A cut-short file can still open and show its meta, so its length is checked against the page count
// its header records. The count is only trusted when the header marks it current.
fn check_length(path: &Path, bytes: u64) -> Result<(), String> {
    let mut header = [0u8; 100];
    std::fs::File::open(path)
        .and_then(|mut f| f.read_exact(&mut header))
        .map_err(|_| "not a database file".to_string())?;
    if &header[..16] != b"SQLite format 3\0" {
        return Err("not a database file".to_string());
    }
    let be32 = |at: usize| u32::from_be_bytes([header[at], header[at + 1], header[at + 2], header[at + 3]]);
    let page_size = match u16::from_be_bytes([header[16], header[17]]) {
        1 => 65_536,
        n => u64::from(n),
    };
    let pages = u64::from(be32(28));
    if pages == 0 || be32(24) != be32(92) {
        return Ok(());
    }
    if pages * page_size != bytes {
        return Err(format!(
            "file is {bytes} bytes, its header records {}",
            pages * page_size
        ));
    }
    Ok(())
}

fn read_meta(path: &Path) -> rusqlite::Result<PointStatus> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let format: i64 = conn.query_row("SELECT format FROM meta WHERE id = 1", [], |r| r.get(0))?;
    if format > FORMAT_VERSION {
        return Ok(PointStatus::Newer { format });
    }
    if format < 1 {
        return Ok(PointStatus::Unreadable {
            error: format!("unknown format {format}"),
        });
    }
    conn.query_row(
        "SELECT format, app_version, schema_version, created_at, reason, detail, albums, singles,
                playlists, filed_tracks, edited_tracks, genre_tracks, content_hash
         FROM meta WHERE id = 1",
        [],
        |r| {
            Ok(PointStatus::Ready(PointMeta {
                format: r.get(0)?,
                app_version: r.get(1)?,
                schema_version: r.get(2)?,
                created_at: r.get(3)?,
                reason: r.get(4)?,
                detail: r.get(5)?,
                albums: r.get(6)?,
                singles: r.get(7)?,
                playlists: r.get(8)?,
                filed_tracks: r.get(9)?,
                edited_tracks: r.get(10)?,
                genre_tracks: r.get(11)?,
                content_hash: r.get(12)?,
            }))
        },
    )
}
