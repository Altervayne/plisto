/*
 * Which live track each track of a point becomes. Matching is exact: the rules run in order and the
 * first to name a live track wins, so a track is either bound to the file it was or left unmatched,
 * never to a lookalike. Each rule is one function over shared lookups, so a further kind of recorded
 * move is one more entry in `RULES`. Pure: the caller reads the library and the point.
 */

// -- Library Imports --
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};

// -- Local Imports --
use super::load::{PointRoot, PointTrack};
use crate::db::{FolderMove, RootMove};
use crate::normalize::normalize_path_key;
use crate::paths::relative_under;

/// A live track as matching reads it: its folded key is `tracks.source_path`.
pub(super) struct LiveTrack {
    pub id: i64,
    pub root_id: Option<i64>,
    pub key: String,
}

/// A live root's current real-case path.
pub(super) struct LiveRoot {
    pub id: i64,
    pub path: String,
}

/// Point track ids to the live track ids they matched, and the point tracks no rule matched.
#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct TrackMap {
    pub matched: HashMap<i64, i64>,
    pub unmatched: BTreeSet<i64>,
}

/// What the rules read: the library and the point's roots, indexed once.
struct Lookups<'a> {
    by_key: HashMap<&'a str, i64>,
    by_id: HashMap<i64, &'a LiveTrack>,
    live_roots: HashMap<i64, &'a str>,
    /// Each live root's folded current and earlier paths.
    root_keys: HashMap<i64, HashSet<String>>,
    point_roots: HashMap<i64, &'a str>,
    /// Every recorded folder move, oldest first.
    folder_moves: Vec<&'a FolderMove>,
}

/// A rule names the live track a point track is, or passes.
type Rule = fn(&Lookups, &PointTrack) -> Option<i64>;

const RULES: &[Rule] = &[same_path, moved_root, moved_folder];

/// Matches every point track against the library. `folder_moves` is newest first, as recorded.
pub(super) fn match_tracks(
    point_roots: &[PointRoot],
    point_tracks: &[PointTrack],
    live_roots: &[LiveRoot],
    live_tracks: &[LiveTrack],
    moves: &[RootMove],
    folder_moves: &[FolderMove],
) -> TrackMap {
    let mut root_keys: HashMap<i64, HashSet<String>> = live_roots
        .iter()
        .map(|r| (r.id, HashSet::from([normalize_path_key(&r.path)])))
        .collect();
    for m in moves {
        if let Some(keys) = root_keys.get_mut(&m.root_id) {
            keys.extend(m.earlier.iter().map(|p| normalize_path_key(p)));
        }
    }
    let lookups = Lookups {
        by_key: live_tracks.iter().map(|t| (t.key.as_str(), t.id)).collect(),
        by_id: live_tracks.iter().map(|t| (t.id, t)).collect(),
        live_roots: live_roots.iter().map(|r| (r.id, r.path.as_str())).collect(),
        root_keys,
        point_roots: point_roots.iter().map(|r| (r.id, r.path.as_str())).collect(),
        folder_moves: folder_moves.iter().rev().collect(),
    };

    let mut map = TrackMap::default();
    for track in point_tracks {
        match RULES.iter().find_map(|rule| rule(&lookups, track)) {
            Some(live) => {
                map.matched.insert(track.id, live);
            }
            None => {
                map.unmatched.insert(track.id);
            }
        }
    }
    map
}

/// A live track holds the point track's folded path: the same file, whatever its id is now. Covers a
/// rescan, and a folder removed and added again.
fn same_path(l: &Lookups, track: &PointTrack) -> Option<i64> {
    l.by_key.get(track.key.as_str()).copied()
}

/// The same id under the same root, where the point's root path is the root's path now or one it
/// held before, and the point's path moved with the root lands on the live track's key. Covers a
/// folder pointed at its new location.
fn moved_root(l: &Lookups, track: &PointTrack) -> Option<i64> {
    let root_id = track.root_id?;
    let live = l.by_id.get(&track.id)?;
    if live.root_id != Some(root_id) {
        return None;
    }
    let point_root = normalize_path_key(l.point_roots.get(&root_id)?);
    if !l.root_keys.get(&root_id)?.contains(&point_root) {
        return None;
    }
    let rel = relative_under(Path::new(&track.key), Path::new(&point_root))?;
    let moved = rebase(Path::new(l.live_roots.get(&root_id)?), &rel);
    (normalize_path_key(&moved.to_string_lossy()) == live.key).then_some(live.id)
}

/// The same id, where the point's place below its root, followed through recorded folder moves, lands
/// on the live track's key under the live track's root. The point's root path must be the root's path
/// now or one it held before, as for a moved root. A point does not say which moves came after it, so
/// the walk may start at any move that takes the track's folder. Covers a folder located inside a
/// root or into another one.
fn moved_folder(l: &Lookups, track: &PointTrack) -> Option<i64> {
    let root_id = track.root_id?;
    let live = l.by_id.get(&track.id)?;
    let point_root = normalize_path_key(l.point_roots.get(&root_id)?);
    if !l.root_keys.get(&root_id)?.contains(&point_root) {
        return None;
    }
    let rel = relative_under(Path::new(&track.key), Path::new(&point_root))?;
    (0..l.folder_moves.len()).find_map(|start| follow(l, live, root_id, &rel, &l.folder_moves[start..]))
}

/// Walks a place below a root through `moves` in order, the first of which must take it. Some when a
/// step lands on `live`.
fn follow(
    l: &Lookups,
    live: &LiveTrack,
    root_id: i64,
    rel: &Path,
    moves: &[&FolderMove],
) -> Option<i64> {
    let (first, rest) = moves.split_first()?;
    let mut at = step(first, root_id, rel)?;
    if lands(l, live, &at) {
        return Some(live.id);
    }
    for m in rest {
        if let Some(next) = step(m, at.0, &at.1) {
            at = next;
            if lands(l, live, &at) {
                return Some(live.id);
            }
        }
    }
    None
}

// The place `m` takes (root_id, rel) to, or None when its folder is not at or above it.
fn step(m: &FolderMove, root_id: i64, rel: &Path) -> Option<(i64, PathBuf)> {
    if m.from_root_id != root_id {
        return None;
    }
    let below = relative_under(rel, Path::new(&m.from_rel))?;
    Some((m.to_root_id, rebase(Path::new(&m.to_rel), &below)))
}

fn lands(l: &Lookups, live: &LiveTrack, (root_id, rel): &(i64, PathBuf)) -> bool {
    live.root_id == Some(*root_id)
        && l.live_roots.get(root_id).is_some_and(|root| {
            normalize_path_key(&rebase(Path::new(root), rel).to_string_lossy()) == live.key
        })
}

// `rel` re-anchored at `root`; an empty remainder is the root itself.
fn rebase(root: &Path, rel: &Path) -> PathBuf {
    if rel.as_os_str().is_empty() {
        root.to_path_buf()
    } else {
        root.join(rel)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(path: &str) -> String {
        normalize_path_key(path)
    }

    fn joined(root: &str, rel: &str) -> String {
        Path::new(root).join(rel).to_string_lossy().into_owned()
    }

    fn point_track(id: i64, root_id: Option<i64>, path: &str) -> PointTrack {
        PointTrack {
            id,
            root_id,
            display: path.to_string(),
            key: key(path),
        }
    }

    fn live_track(id: i64, root_id: Option<i64>, path: &str) -> LiveTrack {
        LiveTrack {
            id,
            root_id,
            key: key(path),
        }
    }

    fn point_root(id: i64, path: &str) -> PointRoot {
        PointRoot {
            id,
            path: path.to_string(),
        }
    }

    fn live_root(id: i64, path: &str) -> LiveRoot {
        LiveRoot {
            id,
            path: path.to_string(),
        }
    }

    fn moved(root_id: i64, path: &str, earlier: &[&str]) -> RootMove {
        RootMove {
            root_id,
            path: path.to_string(),
            earlier: earlier.iter().map(|p| p.to_string()).collect(),
        }
    }

    #[test]
    fn the_same_path_matches_whatever_the_id() {
        let map = match_tracks(
            &[point_root(1, "/Music")],
            &[point_track(1, Some(1), &joined("/Music", "a.mp3"))],
            &[live_root(9, "/Music")],
            &[live_track(40, Some(9), &joined("/Music", "a.mp3"))],
            &[],
            &[],
        );
        assert_eq!(map.matched, HashMap::from([(1, 40)]));
        assert!(map.unmatched.is_empty());
    }

    #[test]
    fn a_moved_root_matches_by_id_through_its_earlier_path() {
        let point = [point_track(1, Some(1), &joined("/Old", "Album/a.mp3"))];
        let live = [live_track(1, Some(1), &joined("/New", "Album/a.mp3"))];
        let map = match_tracks(
            &[point_root(1, "/Old")],
            &point,
            &[live_root(1, "/New")],
            &live,
            &[moved(1, "/New", &["/Old"])],
            &[],
        );
        assert_eq!(map.matched, HashMap::from([(1, 1)]));

        // No recorded move: the id alone is not enough.
        let map =
            match_tracks(&[point_root(1, "/Old")], &point, &[live_root(1, "/New")], &live, &[], &[]);
        assert_eq!(map.unmatched, BTreeSet::from([1]));
    }

    #[test]
    fn a_moved_root_needs_the_same_root_and_the_same_place_below_it() {
        let moves = [moved(1, "/New", &["/Old"])];
        // Same id, but now under another root.
        let map = match_tracks(
            &[point_root(1, "/Old")],
            &[point_track(1, Some(1), &joined("/Old", "a.mp3"))],
            &[live_root(1, "/New"), live_root(2, "/Else")],
            &[live_track(1, Some(2), &joined("/Else", "a.mp3"))],
            &moves,
            &[],
        );
        assert_eq!(map.unmatched, BTreeSet::from([1]));
        // Same id and root, but the file now sits elsewhere below it.
        let map = match_tracks(
            &[point_root(1, "/Old")],
            &[point_track(1, Some(1), &joined("/Old", "a.mp3"))],
            &[live_root(1, "/New")],
            &[live_track(1, Some(1), &joined("/New", "b.mp3"))],
            &moves,
            &[],
        );
        assert_eq!(map.unmatched, BTreeSet::from([1]));
    }

    #[test]
    fn a_path_match_wins_over_an_id_match() {
        let map = match_tracks(
            &[point_root(1, "/Old")],
            &[point_track(1, Some(1), &joined("/Old", "a.mp3"))],
            &[live_root(1, "/New"), live_root(2, "/Old")],
            &[
                live_track(1, Some(1), &joined("/New", "a.mp3")),
                live_track(7, Some(2), &joined("/Old", "a.mp3")),
            ],
            &[moved(1, "/New", &["/Old"])],
            &[],
        );
        assert_eq!(map.matched, HashMap::from([(1, 7)]));
    }

    #[test]
    fn a_track_without_a_root_matches_by_path_only() {
        let map = match_tracks(
            &[],
            &[
                point_track(1, None, "/loose/a.mp3"),
                point_track(2, None, "/loose/b.mp3"),
            ],
            &[],
            &[live_track(2, None, "/elsewhere/b.mp3"), live_track(5, None, "/loose/a.mp3")],
            &[],
            &[],
        );
        assert_eq!(map.matched, HashMap::from([(1, 5)]));
        assert_eq!(map.unmatched, BTreeSet::from([2]));
    }

    fn located(from_root_id: i64, from_rel: &str, to_root_id: i64, to_rel: &str) -> FolderMove {
        FolderMove {
            from_root_id,
            from_rel: key(from_rel),
            to_root_id,
            to_rel: key(to_rel),
            at: 1,
        }
    }

    #[test]
    fn a_located_folder_matches_by_id_through_the_recorded_move() {
        let point = [point_track(1, Some(1), &joined("/Music", "Old/Disc 1/a.mp3"))];
        let live = [live_track(1, Some(1), &joined("/Music", "New/Disc 1/a.mp3"))];
        let moves = [located(1, "Old", 1, "New")];
        let music = |live: &[LiveTrack], moves: &[FolderMove]| {
            match_tracks(&[point_root(1, "/Music")], &point, &[live_root(1, "/Music")], live, &[], moves)
        };
        assert_eq!(music(&live, &moves).matched, HashMap::from([(1, 1)]));

        // No recorded move, another id, or a point root the live root never was: no match.
        assert_eq!(music(&live, &[]).unmatched, BTreeSet::from([1]));
        let other_id = [live_track(2, Some(1), &joined("/Music", "New/Disc 1/a.mp3"))];
        assert_eq!(music(&other_id, &moves).unmatched, BTreeSet::from([1]));
        let point_elsewhere = [point_track(1, Some(1), &joined("/Elsewhere", "Old/Disc 1/a.mp3"))];
        let map = match_tracks(
            &[point_root(1, "/Elsewhere")],
            &point_elsewhere,
            &[live_root(1, "/Music")],
            &live,
            &[],
            &moves,
        );
        assert_eq!(map.unmatched, BTreeSet::from([1]));
    }

    #[test]
    fn a_folder_located_into_another_root_and_on_again_matches_through_both_moves() {
        let point = [point_track(1, Some(1), &joined("/Music", "Old/a.mp3"))];
        let live = [live_track(1, Some(2), &joined("/Other", "Kept/a.mp3"))];
        // Newest first; the newest move takes the old folder again and leads elsewhere.
        let moves = [
            located(1, "Old", 1, "Else"),
            located(2, "Found", 2, "Kept"),
            located(1, "Old", 2, "Found"),
        ];
        let map = match_tracks(
            &[point_root(1, "/Music")],
            &point,
            &[live_root(1, "/Music"), live_root(2, "/Other")],
            &live,
            &[],
            &moves,
        );
        assert_eq!(map.matched, HashMap::from([(1, 1)]));
    }

    #[test]
    fn a_located_folder_at_a_root_itself_matches() {
        let point = [point_track(1, Some(1), &joined("/Music", "Old/a.mp3"))];
        let live = [live_track(1, Some(2), &joined("/Other", "a.mp3"))];
        let map = match_tracks(
            &[point_root(1, "/Music")],
            &point,
            &[live_root(1, "/Music"), live_root(2, "/Other")],
            &live,
            &[],
            &[located(1, "Old", 2, "")],
        );
        assert_eq!(map.matched, HashMap::from([(1, 1)]));
    }
}
