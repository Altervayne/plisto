/*
 * The set of folders waiting for a background pass. A changed file dirties its parent folder alone; a
 * created, removed or renamed folder dirties its whole subtree. Units collapse as they arrive (an
 * ancestor absorbs its descendants), and a root that piles up too many, or reports an overflow, is
 * escalated to a full pass of that root. Each unit keeps the time of its last event so a pass only
 * takes what has been quiet for the settle window. Pure: the clock is passed in.
 */

// -- Library Imports --
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

// -- Local Imports --
use crate::normalize::is_audio;
use crate::scan::{dir_key, under_dir, ScanUnit};

/// How long a unit must stay quiet before a pass takes it.
pub const SETTLE: Duration = Duration::from_secs(2);

/// Past this many units, a root is cheaper to walk whole.
const MAX_UNITS: usize = 256;

/// Whether a changed path is a file or a folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathKind {
    File,
    Dir,
}

/// One dirty folder. `last` is the time of its latest event; None means it is ready now.
#[derive(Debug, Clone)]
struct Unit {
    key: String,
    dir: PathBuf,
    recursive: bool,
    last: Option<Instant>,
}

impl Unit {
    /// Whether this unit already covers everything `other` would walk.
    fn covers(&self, other: &Unit) -> bool {
        if self.recursive {
            under_dir(&other.key, &self.key)
        } else {
            !other.recursive && self.key == other.key
        }
    }
}

/// A root's pending work: the whole root, or a set of disjoint units.
#[derive(Debug, Clone)]
enum Pending {
    Full { last: Option<Instant> },
    Units(Vec<Unit>),
}

/// What a pass takes for one root: None for the whole root, else its settled units.
pub type RootWork = (i64, Option<Vec<ScanUnit>>);

#[derive(Debug, Default)]
pub struct DirtySet {
    /// Every known root as (id, canonical key).
    roots: Vec<(i64, String)>,
    pending: BTreeMap<i64, Pending>,
}

impl DirtySet {
    /// Replaces the known roots. A root no longer present loses its pending work.
    pub fn set_roots(&mut self, roots: &[(i64, PathBuf)]) {
        self.roots = roots
            .iter()
            .map(|(id, path)| (*id, dir_key(path)))
            .collect();
        let known: Vec<i64> = self.roots.iter().map(|(id, _)| *id).collect();
        self.pending.retain(|id, _| known.contains(id));
    }

    /// The root `path` lies in, if any.
    pub fn root_for(&self, path: &Path) -> Option<i64> {
        let key = dir_key(path);
        self.roots
            .iter()
            .find(|(_, root)| under_dir(&key, root))
            .map(|(id, _)| *id)
    }

    /// Records a change at `path`. Plisto's own staging and probe files, non-audio files and paths
    /// outside every root are dropped.
    pub fn note(&mut self, path: &Path, kind: PathKind, now: Instant) {
        if is_own_file(path) {
            return;
        }
        if kind == PathKind::File && !has_audio_ext(path) {
            return;
        }
        let Some(root) = self.root_for(path) else {
            return;
        };
        let (dir, recursive) = match kind {
            PathKind::Dir => (path.to_path_buf(), true),
            PathKind::File => match path.parent() {
                Some(parent) => (parent.to_path_buf(), false),
                None => return,
            },
        };
        let key = dir_key(&dir);
        if recursive && self.root_key(root).is_some_and(|root_key| root_key == key) {
            self.escalate(root, Some(now));
            return;
        }
        self.insert(
            root,
            Unit {
                key,
                dir,
                recursive,
                last: Some(now),
            },
        );
    }

    /// An overflow at `path` loses events, so its root is walked whole. None overflows every root.
    pub fn overflow(&mut self, path: Option<&Path>, now: Instant) {
        let ids: Vec<i64> = match path.and_then(|p| self.root_for(p)) {
            Some(id) => vec![id],
            None if path.is_none() => self.roots.iter().map(|(id, _)| *id).collect(),
            None => Vec::new(),
        };
        for id in ids {
            self.escalate(id, Some(now));
        }
    }

    /// Marks a whole root dirty. `last` None makes it ready at once, else it settles from `last`.
    pub fn escalate(&mut self, root: i64, last: Option<Instant>) {
        if self.root_key(root).is_none() {
            return;
        }
        let prior = match self.pending.get(&root) {
            Some(Pending::Full { last }) => *last,
            Some(Pending::Units(units)) => units.iter().map(|u| u.last).max().flatten(),
            None => None,
        };
        self.pending.insert(
            root,
            Pending::Full {
                last: prior.max(last),
            },
        );
    }

    /// Puts work back, ready at once: a cancelled pass, or a deferred file's folder.
    pub fn requeue(&mut self, root: i64, units: Option<Vec<ScanUnit>>) {
        match units {
            None => self.escalate(root, None),
            Some(units) => {
                if self.root_key(root).is_none() {
                    return;
                }
                for unit in units {
                    self.insert(
                        root,
                        Unit {
                            key: dir_key(&unit.dir),
                            dir: unit.dir,
                            recursive: unit.recursive,
                            last: None,
                        },
                    );
                }
            }
        }
    }

    /// Removes and returns every piece of work quiet for at least the settle window at `now`.
    pub fn take_settled(&mut self, now: Instant) -> Vec<RootWork> {
        let settled =
            |last: Option<Instant>| last.is_none_or(|t| now.saturating_duration_since(t) >= SETTLE);
        let mut out = Vec::new();
        let ids: Vec<i64> = self.pending.keys().copied().collect();
        for id in ids {
            match self.pending.get_mut(&id) {
                Some(Pending::Full { last }) if settled(*last) => {
                    self.pending.remove(&id);
                    out.push((id, None));
                }
                Some(Pending::Units(units)) => {
                    let (ready, waiting): (Vec<Unit>, Vec<Unit>) =
                        units.drain(..).partition(|u| settled(u.last));
                    *units = waiting;
                    if units.is_empty() {
                        self.pending.remove(&id);
                    }
                    if !ready.is_empty() {
                        let units = ready
                            .into_iter()
                            .map(|u| ScanUnit {
                                dir: u.dir,
                                recursive: u.recursive,
                            })
                            .collect();
                        out.push((id, Some(units)));
                    }
                }
                _ => {}
            }
        }
        out
    }

    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }

    pub fn clear(&mut self) {
        self.pending.clear();
    }

    fn root_key(&self, root: i64) -> Option<&str> {
        self.roots
            .iter()
            .find(|(id, _)| *id == root)
            .map(|(_, key)| key.as_str())
    }

    /// Adds a unit to a root, collapsing it against the units already there.
    fn insert(&mut self, root: i64, unit: Unit) {
        let entry = self
            .pending
            .entry(root)
            .or_insert_with(|| Pending::Units(Vec::new()));
        let units = match entry {
            Pending::Full { last } => {
                *last = (*last).max(unit.last);
                return;
            }
            Pending::Units(units) => units,
        };
        if let Some(cover) = units.iter_mut().find(|u| u.covers(&unit)) {
            cover.last = cover.last.max(unit.last);
            return;
        }
        let mut last = unit.last;
        units.retain(|u| {
            let absorbed = unit.covers(u);
            if absorbed {
                last = last.max(u.last);
            }
            !absorbed
        });
        units.push(Unit { last, ..unit });
        if units.len() > MAX_UNITS {
            let last = units.iter().map(|u| u.last).max().flatten();
            *entry = Pending::Full { last };
        }
    }
}

/// Plisto's own transient files: export and splice staging (`.plisto-tmp-*`, anywhere on the path)
/// and the destination write probe.
fn is_own_file(path: &Path) -> bool {
    path.components()
        .any(|c| c.as_os_str().to_string_lossy().starts_with(".plisto-tmp-"))
        || path
            .file_name()
            .is_some_and(|name| name == ".plisto-write-probe")
}

/// Whether `path` carries one of the indexed audio extensions.
pub fn has_audio_ext(path: &Path) -> bool {
    path.extension()
        .is_some_and(|ext| is_audio(&ext.to_string_lossy()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(r"C:\Music")
        } else {
            PathBuf::from("/music")
        }
    }

    fn set() -> DirtySet {
        let mut set = DirtySet::default();
        set.set_roots(&[(1, root())]);
        set
    }

    fn unit(dir: PathBuf, recursive: bool) -> ScanUnit {
        ScanUnit { dir, recursive }
    }

    fn later(t: Instant) -> Instant {
        t + SETTLE
    }

    #[test]
    fn a_file_event_dirties_its_parent_folder_only() {
        let t = Instant::now();
        let mut set = set();
        let album = root().join("Album");
        set.note(&album.join("01.flac"), PathKind::File, t);
        assert_eq!(
            set.take_settled(later(t)),
            vec![(1, Some(vec![unit(album, false)]))]
        );
    }

    #[test]
    fn a_folder_event_dirties_its_subtree() {
        let t = Instant::now();
        let mut set = set();
        let album = root().join("Album");
        set.note(&album, PathKind::Dir, t);
        assert_eq!(
            set.take_settled(later(t)),
            vec![(1, Some(vec![unit(album, true)]))]
        );
    }

    #[test]
    fn an_ancestor_absorbs_its_descendants() {
        let t = Instant::now();
        let mut set = set();
        let artist = root().join("Artist");
        set.note(&artist.join("A").join("01.mp3"), PathKind::File, t);
        set.note(&artist.join("B"), PathKind::Dir, t);
        set.note(&artist, PathKind::Dir, t);
        // Covered by the recursive ancestor already queued.
        set.note(&artist.join("C").join("02.mp3"), PathKind::File, t);
        // A sibling whose name extends the ancestor's is not under it.
        let sibling = root().join("Artist2");
        set.note(&sibling.join("03.mp3"), PathKind::File, t);
        assert_eq!(
            set.take_settled(later(t)),
            vec![(1, Some(vec![unit(artist, true), unit(sibling, false)]))]
        );
    }

    #[test]
    fn repeated_file_events_in_one_folder_collapse() {
        let t = Instant::now();
        let mut set = set();
        let album = root().join("Album");
        set.note(&album.join("01.mp3"), PathKind::File, t);
        set.note(&album.join("02.mp3"), PathKind::File, t);
        assert_eq!(
            set.take_settled(later(t)),
            vec![(1, Some(vec![unit(album, false)]))]
        );
    }

    #[test]
    fn too_many_units_escalate_to_the_whole_root() {
        let t = Instant::now();
        let mut set = set();
        for n in 0..=MAX_UNITS {
            set.note(
                &root().join(format!("f{n}")).join("x.mp3"),
                PathKind::File,
                t,
            );
        }
        assert_eq!(set.take_settled(later(t)), vec![(1, None)]);
    }

    #[test]
    fn an_overflow_escalates_its_root() {
        let t = Instant::now();
        let mut set = set();
        set.note(&root().join("A").join("x.mp3"), PathKind::File, t);
        set.overflow(Some(&root().join("A")), t);
        assert_eq!(set.take_settled(later(t)), vec![(1, None)]);

        set.overflow(None, t);
        assert_eq!(set.take_settled(later(t)), vec![(1, None)]);
    }

    #[test]
    fn an_event_on_the_root_itself_escalates() {
        let t = Instant::now();
        let mut set = set();
        set.note(&root(), PathKind::Dir, t);
        assert_eq!(set.take_settled(later(t)), vec![(1, None)]);
    }

    #[test]
    fn filters_drop_what_is_never_indexed() {
        let t = Instant::now();
        let mut set = set();
        set.note(
            &root().join("A").join(".plisto-tmp-01.mp3"),
            PathKind::File,
            t,
        );
        set.note(
            &root().join(".plisto-tmp-stage").join("01.mp3"),
            PathKind::File,
            t,
        );
        set.note(&root().join(".plisto-tmp-stage"), PathKind::Dir, t);
        set.note(
            &root().join("A").join(".plisto-write-probe"),
            PathKind::File,
            t,
        );
        set.note(&root().join("A").join("cover.jpg"), PathKind::File, t);
        let elsewhere = if cfg!(windows) { r"D:\Other" } else { "/other" };
        set.note(&Path::new(elsewhere).join("x.mp3"), PathKind::File, t);
        assert!(set.is_empty());

        // A folder is kept whatever its name looks like.
        let folder = root().join("Vol. 2");
        set.note(&folder, PathKind::Dir, t);
        assert_eq!(
            set.take_settled(later(t)),
            vec![(1, Some(vec![unit(folder, true)]))]
        );
    }

    #[test]
    fn removing_a_root_drops_its_units() {
        let t = Instant::now();
        let mut set = set();
        set.note(&root().join("A").join("x.mp3"), PathKind::File, t);
        set.set_roots(&[]);
        assert!(set.is_empty());
        set.note(&root().join("A").join("x.mp3"), PathKind::File, t);
        assert!(set.is_empty(), "an unknown root takes nothing");
    }

    #[test]
    fn units_wait_for_the_settle_window() {
        let t = Instant::now();
        let mut set = set();
        let a = root().join("A");
        let b = root().join("B");
        set.note(&a.join("x.mp3"), PathKind::File, t);
        set.note(&b.join("y.mp3"), PathKind::File, t + Duration::from_secs(1));
        assert!(set
            .take_settled(t + Duration::from_millis(1_999))
            .is_empty());

        // A fresh event on a queued unit restarts its window.
        set.note(
            &a.join("z.mp3"),
            PathKind::File,
            t + Duration::from_millis(1_500),
        );
        assert!(set.take_settled(t + SETTLE).is_empty());
        assert_eq!(
            set.take_settled(t + Duration::from_secs(3)),
            vec![(1, Some(vec![unit(b, false)]))]
        );
        assert_eq!(
            set.take_settled(t + Duration::from_millis(3_500)),
            vec![(1, Some(vec![unit(a, false)]))]
        );
        assert!(set.is_empty());
    }

    #[test]
    fn requeued_work_is_ready_at_once() {
        let t = Instant::now();
        let mut set = set();
        let a = root().join("A");
        set.requeue(1, Some(vec![unit(a.clone(), false)]));
        assert_eq!(set.take_settled(t), vec![(1, Some(vec![unit(a, false)]))]);
        set.requeue(1, None);
        assert_eq!(set.take_settled(t), vec![(1, None)]);
    }
}
