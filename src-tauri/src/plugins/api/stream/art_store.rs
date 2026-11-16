/*
 * Where stream artwork lives on disk: thumbnail files in the covers folder, the one folder the
 * windows may load images from, under names no library cover can have. Every name starts with
 * `ART_PREFIX` and carries the item's id, so two items never share a file and cleaning one item's
 * files can never touch a library cover, whose names are bare content hashes.
 *
 * The store is bounded by its owners: a seated item keeps at most `ART_KEPT` artworks (the one shown
 * and the one before it, which a window may still be loading), an artwork that lands for an item
 * that is gone or was replaced is deleted at once, an item's files go when it ends, and the whole
 * store is emptied when the hub is attached at start-up, so a crash leaves nothing behind for long.
 */

// -- Library Imports --
use std::fs;
use std::path::Path;

// -- Local Imports --
use crate::commands::covers::{DETAIL_EDGE, THUMB_EDGE};
use crate::covers::thumb_cache_path;

/// The start of every stream artwork file name.
pub const ART_PREFIX: &str = "stream-art-";
/// The artworks a seated item keeps: the one shown and the one before it.
pub const ART_KEPT: usize = 2;

/// The name an artwork of item `item` is cached under, in place of a content hash.
pub fn art_key(item: i64, hash: &str) -> String {
    format!("{ART_PREFIX}{}-{hash}", item.unsigned_abs())
}

/// Deletes every file of the artwork `key`: both thumbnails and the palettes computed from them.
/// Files that are already gone are fine.
pub fn drop_art_files(covers: &Path, key: &str) {
    if !key.starts_with(ART_PREFIX) {
        return;
    }
    for edge in [THUMB_EDGE, DETAIL_EDGE] {
        let thumb = thumb_cache_path(covers, key, edge);
        let _ = fs::remove_file(thumb.with_extension("palette"));
        let _ = fs::remove_file(thumb);
    }
}

/// Deletes every stream artwork file in the covers folder.
pub fn clear_art_files(covers: &Path) {
    let Ok(entries) = fs::read_dir(covers) else {
        return;
    };
    for entry in entries.flatten() {
        let stream_art = entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.starts_with(ART_PREFIX));
        if stream_art {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// Records `key` as the newest artwork an item keeps. Returns the key that falls out past
/// `ART_KEPT`, whose files the caller deletes.
pub fn keep(kept: &mut Vec<String>, key: String) -> Option<String> {
    kept.retain(|k| *k != key);
    kept.push(key);
    (kept.len() > ART_KEPT).then(|| kept.remove(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_item_keeps_the_two_newest_once_each() {
        let mut kept = Vec::new();
        assert_eq!(keep(&mut kept, "a".into()), None);
        assert_eq!(keep(&mut kept, "b".into()), None);
        assert_eq!(
            keep(&mut kept, "a".into()),
            None,
            "a repeat becomes the newest"
        );
        assert_eq!(keep(&mut kept, "c".into()), Some("b".into()));
        assert_eq!(kept, ["a", "c"]);
    }
}
