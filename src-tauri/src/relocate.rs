/*
 * The checks that run before a root is pointed at a new folder: where a picked folder stands against
 * the library's roots, which of a root's tracks to look for there, and whether enough of them are
 * found. The stat sample is capped by a deadline and never walks the new folder. Everything here is
 * pure or touches only the filesystem; the database work lives in commands/relocate.rs.
 */

// -- Library Imports --
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

// -- Local Imports --
use crate::db::RootTrackPath;
use crate::dto::{RelinkCandidate, Root};
use crate::normalize::normalize_path_key;
use crate::paths::{paths_overlap, relative_under};
use crate::scan::dir_key;

/// How many tracks a verify looks for in the new folder.
pub const SAMPLE_TARGET: usize = 48;

/// How long a verify may spend on the filesystem before it reports what it has.
pub const VERIFY_DEADLINE: std::time::Duration = std::time::Duration::from_millis(3500);

// A timed-out check below this many tracks says nothing either way.
const MIN_CHECKED_ON_TIMEOUT: u32 = 10;

// A verify needs at least this many matches, or all of a smaller sample.
const MIN_MATCHES: u32 = 5;

/// One track to look for in the new folder: its path below the root and the size it was indexed at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SampleRow {
    pub rel: PathBuf,
    pub size_bytes: i64,
}

/// What a sample check found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SampleResult {
    pub sampled: u32,
    pub matched: u32,
    pub timed_out: bool,
}

/// How a sample reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// Nearly everything was found.
    Accept,
    /// Enough was found, but a share of the tracks is not there.
    Partial,
    /// The folder does not look like the root.
    NoMatch,
    /// The deadline cut the check short before it could say.
    Inconclusive,
}

/// Where a picked folder stands against the root being moved and the other roots.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    /// The root already points at exactly this text.
    Same,
    /// The same folder under different casing.
    CaseOnly,
    /// Another root already sits exactly here.
    Merge {
        other_id: i64,
    },
    /// The folder nests inside, or contains, another root or the moving root itself.
    Overlap {
        other: String,
    },
    Fresh,
}

/// Classifies `new_path` for the root `root` (its id and current path) against `others`. A row of
/// `others` with the root's own id is ignored.
pub fn classify_target(root: (i64, &str), others: &[(i64, String)], new_path: &str) -> Target {
    let (root_id, old_path) = root;
    let new_key = dir_key(Path::new(new_path));
    if new_key == dir_key(Path::new(old_path)) {
        return if Path::new(new_path)
            .components()
            .eq(Path::new(old_path).components())
        {
            Target::Same
        } else {
            Target::CaseOnly
        };
    }
    let others = || others.iter().filter(|(id, _)| *id != root_id);
    if let Some((other_id, _)) = others().find(|(_, path)| dir_key(Path::new(path)) == new_key) {
        return Target::Merge {
            other_id: *other_id,
        };
    }
    let new = Path::new(new_path);
    if let Some((_, other)) = others().find(|(_, path)| paths_overlap(new, Path::new(path))) {
        return Target::Overlap {
            other: other.clone(),
        };
    }
    if paths_overlap(new, Path::new(old_path)) {
        return Target::Overlap {
            other: old_path.to_string(),
        };
    }
    Target::Fresh
}

/// Picks up to `SAMPLE_TARGET` tracks of the root at `root` to look for, spread over its folders.
/// Tracks flagged gone are left out unless every track is. The pick is deterministic: folders in key
/// order, one track from each at a fixed stride when there are more folders than the target, else
/// round by round until the target is met.
pub fn pick_sample(rows: &[RootTrackPath], root: &Path) -> Vec<SampleRow> {
    let present: Vec<&RootTrackPath> = rows.iter().filter(|r| !r.missing).collect();
    let chosen: Vec<&RootTrackPath> = if present.is_empty() {
        rows.iter().collect()
    } else {
        present
    };

    // Folder key -> (file key, row), so the order never depends on the database's row order.
    let mut folders: BTreeMap<String, Vec<(String, SampleRow)>> = BTreeMap::new();
    for row in chosen {
        let shown = row.display_path.as_deref().unwrap_or(&row.source_path);
        let Some(rel) = relative_under(Path::new(shown), root) else {
            continue;
        };
        if rel.as_os_str().is_empty() {
            continue;
        }
        let folder = rel
            .parent()
            .map(|p| normalize_path_key(&p.to_string_lossy()))
            .unwrap_or_default();
        let file = normalize_path_key(&rel.to_string_lossy());
        folders.entry(folder).or_default().push((
            file,
            SampleRow {
                rel,
                size_bytes: row.size_bytes,
            },
        ));
    }
    let mut folders: Vec<Vec<(String, SampleRow)>> = folders.into_values().collect();
    for files in &mut folders {
        files.sort_by(|a, b| a.0.cmp(&b.0));
    }

    let count = folders.len();
    if count >= SAMPLE_TARGET {
        return (0..SAMPLE_TARGET)
            .map(|i| folders[i * count / SAMPLE_TARGET][0].1.clone())
            .collect();
    }
    let mut out = Vec::new();
    let mut round = 0;
    loop {
        let before = out.len();
        for files in &folders {
            if let Some((_, row)) = files.get(round) {
                out.push(row.clone());
                if out.len() == SAMPLE_TARGET {
                    return out;
                }
            }
        }
        if out.len() == before {
            return out;
        }
        round += 1;
    }
}

/// Looks for each sampled track below `new_root`. A track matches when a file is there with the
/// indexed size; the modified time is ignored, since a copy may not keep it. Stops at `deadline`.
pub fn check_sample(sample: &[SampleRow], new_root: &Path, deadline: Instant) -> SampleResult {
    let mut result = SampleResult {
        sampled: 0,
        matched: 0,
        timed_out: false,
    };
    for row in sample {
        if Instant::now() >= deadline {
            result.timed_out = true;
            break;
        }
        result.sampled += 1;
        let found = std::fs::metadata(new_root.join(&row.rel)).is_ok_and(|m| {
            m.is_file() && i64::try_from(m.len()).is_ok_and(|n| n == row.size_bytes)
        });
        if found {
            result.matched += 1;
        }
    }
    result
}

/// Reads a sample: 90% found or more accepts, from half up to that is partial, anything lower, fewer
/// than five matches (or all of a smaller sample) or an empty sample is no match. A check cut short
/// with fewer than ten tracks looked at is inconclusive.
pub fn verdict(sampled: u32, matched: u32, timed_out: bool) -> Verdict {
    if timed_out && sampled < MIN_CHECKED_ON_TIMEOUT {
        return Verdict::Inconclusive;
    }
    if sampled == 0 || matched < sampled.min(MIN_MATCHES) {
        return Verdict::NoMatch;
    }
    let (found, checked) = (u64::from(matched), u64::from(sampled));
    if found * 10 >= checked * 9 {
        Verdict::Accept
    } else if found * 2 >= checked {
        Verdict::Partial
    } else {
        Verdict::NoMatch
    }
}

/// Ranks the roots in `candidates` (each with its tracks) by how much of it sits in `new_root`, best
/// fraction first, ties by root id. A root only counts when `new_root` stands apart from every root in
/// `all` and its sample reads as accepted or partial. One `deadline` serves every candidate.
pub fn rank_candidates(
    new_root: &Path,
    candidates: Vec<(Root, Vec<RootTrackPath>)>,
    all: &[(i64, String)],
    deadline: Instant,
) -> Vec<RelinkCandidate> {
    let new_path = new_root.to_string_lossy();
    let mut found = Vec::new();
    for (root, rows) in candidates {
        if classify_target((root.id, &root.path), all, &new_path) != Target::Fresh {
            continue;
        }
        let sample = pick_sample(&rows, Path::new(&root.path));
        let checked = check_sample(&sample, new_root, deadline);
        let partial = match verdict(checked.sampled, checked.matched, checked.timed_out) {
            Verdict::Accept => false,
            Verdict::Partial => true,
            Verdict::NoMatch | Verdict::Inconclusive => continue,
        };
        found.push(RelinkCandidate {
            root_id: root.id,
            path: root.path,
            total: root.track_count,
            sampled: checked.sampled,
            matched: checked.matched,
            partial,
        });
    }
    found.sort_by(|a, b| {
        let (a_found, b_found) = (u64::from(a.matched), u64::from(b.matched));
        let (a_of, b_of) = (u64::from(a.sampled), u64::from(b.sampled));
        (b_found * a_of)
            .cmp(&(a_found * b_of))
            .then(a.root_id.cmp(&b.root_id))
    });
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::Duration;

    fn base() -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(r"C:\")
        } else {
            PathBuf::from("/")
        }
    }

    fn at(rel: &str) -> String {
        base().join(rel).to_string_lossy().into_owned()
    }

    fn others() -> Vec<(i64, String)> {
        vec![(2, at("lib/b")), (3, at("lib/c"))]
    }

    #[test]
    fn classify_same_text_is_same() {
        let old = at("lib/a");
        assert_eq!(classify_target((1, &old), &others(), &old), Target::Same);
    }

    #[cfg(windows)]
    #[test]
    fn classify_same_key_in_other_case_is_case_only() {
        let old = at("lib/a");
        let upper = at("LIB/A");
        assert_eq!(
            classify_target((1, &old), &others(), &upper),
            Target::CaseOnly
        );
    }

    #[test]
    fn classify_an_exact_other_root_is_a_merge() {
        let old = at("lib/a");
        assert_eq!(
            classify_target((1, &old), &others(), &at("lib/b")),
            Target::Merge { other_id: 2 }
        );
    }

    #[test]
    fn classify_nested_in_another_root_overlaps_it() {
        let old = at("lib/a");
        assert_eq!(
            classify_target((1, &old), &others(), &at("lib/b/sub")),
            Target::Overlap { other: at("lib/b") }
        );
    }

    #[test]
    fn classify_containing_another_root_overlaps_it() {
        let old = at("lib/a");
        assert_eq!(
            classify_target((1, &old), &others(), &at("lib")),
            Target::Overlap { other: at("lib/b") }
        );
    }

    #[test]
    fn classify_nested_in_the_old_root_overlaps_it() {
        let old = at("lib/a");
        assert_eq!(
            classify_target((1, &old), &others(), &at("lib/a/deeper")),
            Target::Overlap { other: old.clone() }
        );
    }

    #[test]
    fn classify_a_sibling_prefix_is_fresh() {
        let old = at("lib/a");
        assert_eq!(
            classify_target((1, &old), &others(), &at("lib/bX")),
            Target::Fresh
        );
    }

    #[test]
    fn classify_ignores_the_moving_root_among_the_others() {
        let old = at("lib/a");
        let all = vec![(1, old.clone()), (2, at("lib/b"))];
        assert_eq!(
            classify_target((1, &old), &all, &at("elsewhere")),
            Target::Fresh
        );
    }

    fn row(id: i64, rel: &str, size: i64, missing: bool) -> RootTrackPath {
        let shown = at(&format!("music/{rel}"));
        RootTrackPath {
            id,
            source_path: normalize_path_key(&shown),
            display_path: Some(shown),
            size_bytes: size,
            missing,
        }
    }

    fn root() -> PathBuf {
        PathBuf::from(at("music"))
    }

    fn folder_rows(folders: usize, per_folder: usize) -> Vec<RootTrackPath> {
        let mut rows = Vec::new();
        for f in 0..folders {
            for t in 0..per_folder {
                let id = (f * per_folder + t) as i64;
                rows.push(row(id, &format!("f{f:03}/t{t:02}.mp3"), 10, false));
            }
        }
        rows
    }

    #[test]
    fn pick_sample_is_deterministic_and_ignores_row_order() {
        let rows = folder_rows(12, 6);
        let mut reversed = rows.clone();
        reversed.reverse();
        assert_eq!(pick_sample(&rows, &root()), pick_sample(&rows, &root()));
        assert_eq!(pick_sample(&rows, &root()), pick_sample(&reversed, &root()));
    }

    #[test]
    fn pick_sample_spreads_across_folders() {
        let rows = folder_rows(100, 2);
        let sample = pick_sample(&rows, &root());
        assert_eq!(sample.len(), SAMPLE_TARGET);
        let folders: std::collections::HashSet<_> = sample
            .iter()
            .map(|s| s.rel.parent().unwrap().to_owned())
            .collect();
        assert_eq!(folders.len(), SAMPLE_TARGET, "one track per folder");
        assert!(
            sample
                .iter()
                .any(|s| s.rel.to_string_lossy().starts_with("f09")),
            "the stride reaches the end of the folder list"
        );
    }

    #[test]
    fn pick_sample_prefers_present_rows() {
        let mut rows = folder_rows(3, 3);
        for r in rows.iter_mut().take(8) {
            r.missing = true;
        }
        let sample = pick_sample(&rows, &root());
        assert_eq!(sample.len(), 1, "only the one present row is looked for");
        assert!(sample[0].rel.starts_with("f002"));
    }

    #[test]
    fn pick_sample_falls_back_to_all_rows_when_none_is_present() {
        let mut rows = folder_rows(2, 2);
        for r in &mut rows {
            r.missing = true;
        }
        assert_eq!(pick_sample(&rows, &root()).len(), 4);
    }

    #[test]
    fn pick_sample_fills_past_the_folder_count() {
        let rows = folder_rows(5, 20);
        let sample = pick_sample(&rows, &root());
        assert_eq!(sample.len(), SAMPLE_TARGET);
        let distinct: std::collections::HashSet<_> = sample.iter().map(|s| s.rel.clone()).collect();
        assert_eq!(distinct.len(), SAMPLE_TARGET, "no track is picked twice");
    }

    #[test]
    fn pick_sample_skips_rows_outside_the_root() {
        let mut rows = folder_rows(1, 2);
        rows.push(RootTrackPath {
            id: 99,
            source_path: normalize_path_key(&at("other/x.mp3")),
            display_path: Some(at("other/x.mp3")),
            size_bytes: 1,
            missing: false,
        });
        assert_eq!(pick_sample(&rows, &root()).len(), 2);
    }

    #[test]
    fn verdict_thresholds() {
        assert_eq!(verdict(20, 19, false), Verdict::Accept);
        assert_eq!(verdict(20, 14, false), Verdict::Partial);
        assert_eq!(verdict(20, 8, false), Verdict::NoMatch);
        assert_eq!(verdict(4, 4, false), Verdict::Accept);
        assert_eq!(verdict(20, 18, false), Verdict::Accept, "exactly 90%");
        assert_eq!(verdict(20, 10, false), Verdict::Partial, "exactly half");
    }

    #[test]
    fn verdict_needs_a_few_matches() {
        assert_eq!(verdict(48, 4, false), Verdict::NoMatch);
        assert_eq!(verdict(4, 3, false), Verdict::NoMatch);
        assert_eq!(verdict(0, 0, false), Verdict::NoMatch);
    }

    #[test]
    fn verdict_on_a_timeout() {
        assert_eq!(verdict(9, 9, true), Verdict::Inconclusive);
        assert_eq!(verdict(10, 10, true), Verdict::Accept);
        assert_eq!(verdict(10, 0, true), Verdict::NoMatch);
    }

    // A unique throwaway directory under the system temp dir, removed on drop.
    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new(tag: &str) -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "plisto_{tag}_{}_{n}_{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&path).unwrap();
            Self { path }
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn sample_row(rel: &str, size: i64) -> SampleRow {
        SampleRow {
            rel: PathBuf::from(rel),
            size_bytes: size,
        }
    }

    #[test]
    fn check_sample_matches_on_size_and_misses_on_a_mismatch() {
        let dir = TempDir::new("relocate_check");
        fs::write(dir.path.join("same.mp3"), b"12345").unwrap();
        fs::write(dir.path.join("grown.mp3"), b"123456789").unwrap();
        let sample = [
            sample_row("same.mp3", 5),
            sample_row("grown.mp3", 5),
            sample_row("absent.mp3", 5),
        ];
        let result = check_sample(&sample, &dir.path, Instant::now() + Duration::from_secs(30));
        assert_eq!(
            result,
            SampleResult {
                sampled: 3,
                matched: 1,
                timed_out: false
            }
        );
    }

    #[test]
    fn check_sample_stops_at_the_deadline() {
        let dir = TempDir::new("relocate_deadline");
        let sample = [sample_row("a.mp3", 1)];
        let result = check_sample(&sample, &dir.path, Instant::now());
        assert_eq!(
            result,
            SampleResult {
                sampled: 0,
                matched: 0,
                timed_out: true
            }
        );
    }

    fn candidate(id: i64, rows: usize) -> (Root, Vec<RootTrackPath>) {
        let root = Root {
            id,
            path: at(&format!("gone{id}")),
            track_count: rows as i64,
            missing_count: 0,
        };
        let tracks = (0..rows)
            .map(|i| {
                let shown = at(&format!("gone{id}/Album/t{i:02}.mp3"));
                RootTrackPath {
                    id: i as i64,
                    source_path: normalize_path_key(&shown),
                    display_path: Some(shown),
                    size_bytes: 3,
                    missing: false,
                }
            })
            .collect();
        (root, tracks)
    }

    fn fill(dir: &Path, files: usize) {
        fs::create_dir_all(dir.join("Album")).unwrap();
        for i in 0..files {
            fs::write(dir.join("Album").join(format!("t{i:02}.mp3")), b"abc").unwrap();
        }
    }

    fn far() -> Instant {
        Instant::now() + Duration::from_secs(30)
    }

    #[test]
    fn rank_candidates_orders_best_fraction_first_and_drops_misses() {
        let dir = TempDir::new("relocate_rank");
        fill(&dir.path, 20);
        // Root 1 holds 40 tracks and 20 are there (half); root 2 holds the 20 that are (all); root 3
        // holds tracks that are not there.
        let half = candidate(1, 40);
        let all = vec![(1, half.0.path.clone()), (2, at("gone2")), (3, at("gone3"))];
        let mut none = candidate(3, 12);
        for row in &mut none.1 {
            row.size_bytes = 99;
        }
        let ranked = rank_candidates(&dir.path, vec![half, candidate(2, 20), none], &all, far());
        let order: Vec<(i64, bool)> = ranked.iter().map(|c| (c.root_id, c.partial)).collect();
        assert_eq!(order, vec![(2, false), (1, true)]);
        assert_eq!(ranked[0].total, 20);
    }

    #[test]
    fn rank_candidates_skips_a_folder_that_overlaps_another_root() {
        let dir = TempDir::new("relocate_rank_overlap");
        fill(&dir.path, 10);
        let all = vec![
            (1, at("gone1")),
            (2, dir.path.join("Album").to_string_lossy().into_owned()),
        ];
        assert!(rank_candidates(&dir.path, vec![candidate(1, 10)], &all, far()).is_empty());
    }

    #[test]
    fn rank_candidates_breaks_ties_by_root_id() {
        let dir = TempDir::new("relocate_rank_tie");
        fill(&dir.path, 10);
        let all = vec![(1, at("gone1")), (2, at("gone2"))];
        let ranked = rank_candidates(
            &dir.path,
            vec![candidate(2, 10), candidate(1, 10)],
            &all,
            far(),
        );
        let ids: Vec<i64> = ranked.iter().map(|c| c.root_id).collect();
        assert_eq!(ids, vec![1, 2]);
    }
}
