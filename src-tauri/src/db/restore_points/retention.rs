/*
 * Retention and disk use. Each reason is a ring that keeps its newest points by the creation time in
 * the file name, so a point that no longer opens still ages out with its ring. A take names its point
 * after the ring's newest, so that order is the order of writing. Only finished points count; a
 * `.tmp` is never pruned here.
 */

// -- Library Imports --
use std::io;
use std::path::Path;

// -- Local Imports --
use super::format::Reason;
use super::point_files;

/// How many points a ring keeps.
pub fn ring_size(reason: Reason) -> usize {
    match reason {
        Reason::Version => 3,
        Reason::Daily => 7,
        Reason::Action => 5,
        Reason::Restore => 2,
    }
}

/// What one prune did: points removed, and points of the ring still on disk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Pruned {
    pub removed: usize,
    pub kept: usize,
}

/// Removes the points of `reason` beyond its ring size, oldest first. A point that cannot be removed
/// stays and counts as kept.
pub fn prune(dir: &Path, reason: Reason) -> io::Result<Pruned> {
    let mut ring: Vec<_> = point_files(dir)?
        .into_iter()
        .filter(|p| p.reason == reason)
        .collect();
    ring.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(b.name.cmp(&a.name)));
    let mut removed = 0;
    for old in ring.iter().skip(ring_size(reason)) {
        if std::fs::remove_file(&old.path).is_ok() {
            removed += 1;
        }
    }
    Ok(Pruned {
        removed,
        kept: ring.len() - removed,
    })
}

/// How many finished points the folder holds and their total size.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DiskUse {
    pub points: usize,
    pub bytes: u64,
}

pub fn disk_use(dir: &Path) -> io::Result<DiskUse> {
    let files = point_files(dir)?;
    Ok(DiskUse {
        points: files.len(),
        bytes: files.iter().map(|p| p.bytes).sum(),
    })
}
