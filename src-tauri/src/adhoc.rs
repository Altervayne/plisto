/*
 * Ad-hoc playback: a file played straight, with no library row behind it. Library rowids are always
 * positive, so a negative id means "not in the index, look in the stash". player_play_file caches one
 * entry per opened file under a freshly allocated negative id, and the now-playing surfaces resolve
 * its title, artist and cover from that stash instead of the DB. The allocator only ever decreases,
 * so every entry gets its own id distinct from a library rowid and from every other ad-hoc entry -
 * a later multi-file open can tell its entries apart.
 */

// -- Library Imports --
use std::sync::atomic::{AtomicI64, Ordering};

/// The next ad-hoc id to hand out. Starts at -1 and only decreases, so an id is never a positive
/// library rowid and never repeats within a session.
static NEXT_AD_HOC_ID: AtomicI64 = AtomicI64::new(-1);

/// Whether an id names an ad-hoc track rather than a library row. The single point the sentinel
/// convention lives: a resolver keys off this to read the stash instead of the index.
pub fn is_ad_hoc(track_id: i64) -> bool {
    track_id < 0
}

/// Allocates the next ad-hoc id: a distinct negative number, decreasing and never reused, so a queue
/// can hold several ad-hoc entries at once and each resolves to its own stash entry.
pub fn next_ad_hoc_id() -> i64 {
    NEXT_AD_HOC_ID.fetch_sub(1, Ordering::Relaxed)
}

/// The cover cached for an ad-hoc track: its content hash and the source art's pixel dimensions,
/// enough to resolve a CoverRef at either thumb size straight from the cache. The image was cached at
/// both thumb sizes by hash when the track was opened, so `thumb_cache_path(covers_dir, &hash, edge)`
/// resolves each size with no decode - the same warm-cache read a bound folder cover takes.
#[derive(Clone)]
pub struct AdHocCover {
    pub hash: String,
    pub width: i64,
    pub height: i64,
}

/// One ad-hoc track's now-playing display. `title` already carries the filename-stem fallback, so it
/// is never empty; `artist` is None when the file carries no artist tag; `cover` is None when neither
/// the file nor its folder held art. Stashed under a negative id so the sentinel fan-out names the
/// current track without the DB.
#[derive(Clone)]
pub struct AdHocTrack {
    pub title: String,
    pub artist: Option<String>,
    pub cover: Option<AdHocCover>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_ad_hoc_splits_on_the_sign() {
        assert!(is_ad_hoc(-1));
        assert!(is_ad_hoc(-42));
        assert!(!is_ad_hoc(0));
        assert!(!is_ad_hoc(1));
    }

    #[test]
    fn ids_are_negative_distinct_and_decreasing() {
        let a = next_ad_hoc_id();
        let b = next_ad_hoc_id();
        assert!(a < 0 && b < 0, "every id is negative");
        assert!(b < a, "each id is smaller than the last, even under interleaving");
        assert_ne!(a, b, "no two opens share an id");
    }
}
