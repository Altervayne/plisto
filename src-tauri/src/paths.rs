/*
 * Shared path-overlap checks. Two folders overlap when one contains the other; the comparison is
 * component-wise on folded keys, not raw string prefixes, so `/musicX` never matches `/music`. It
 * resolves `..`, symlinks and casing through canonicalization where the path exists, falling back
 * to a lexical normalize where it does not. The roots guard and export both lean on this, so the
 * disjoint-roots invariant and the export-destination refusal use one definition of overlap.
 */

// -- Library Imports --
use std::path::{Component, Path, PathBuf};

// -- Local Imports --
use crate::normalize::normalize_path_key;

/// Whether two paths overlap in either direction: one contains the other. Compared component-wise
/// on folded keys, not by raw string prefix, so `/musicX` never matches `/music`. Resolves symlinks
/// and `..` through canonicalization where the path exists, falling back to a lexical normalize.
pub fn paths_overlap(a: &Path, b: &Path) -> bool {
    let ka = path_keys(a);
    let kb = path_keys(b);
    ka.starts_with(&kb) || kb.starts_with(&ka)
}

/// Whether `candidate` overlaps any path in `existing`. The disjoint-roots guard: a new root may
/// not nest inside or contain a folder already in the library.
pub fn any_overlap(existing: &[String], candidate: &Path) -> bool {
    existing
        .iter()
        .any(|p| paths_overlap(candidate, Path::new(p)))
}

/// The folded component keys of a path, canonicalized where it exists so `..`, symlinks and casing
/// resolve, else lexically normalized so a not-yet-created destination still compares.
fn path_keys(path: &Path) -> Vec<String> {
    let resolved = dunce::canonicalize(path).unwrap_or_else(|_| lexical_normalize(path));
    let folded = normalize_path_key(&resolved.to_string_lossy());
    folded
        .split(['/', '\\'])
        .filter(|c| !c.is_empty())
        .map(str::to_string)
        .collect()
}

/// Lexically resolves `.` and `..` without touching disk, so a path that does not yet exist can
/// still be compared.
fn lexical_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nested_paths_overlap_both_directions() {
        let root = Path::new("/music/library");
        let inside = Path::new("/music/library/export");
        assert!(
            paths_overlap(inside, root),
            "a dest inside the root overlaps"
        );
        assert!(paths_overlap(root, inside), "and the check is symmetric");
    }

    #[test]
    fn identical_paths_overlap() {
        assert!(paths_overlap(Path::new("/music"), Path::new("/music")));
    }

    #[test]
    fn sibling_prefixes_do_not_overlap() {
        // A raw string prefix would falsely match; the component-wise check does not.
        assert!(!paths_overlap(Path::new("/musicX"), Path::new("/music")));
        assert!(!paths_overlap(Path::new("/music"), Path::new("/musicX")));
    }

    #[test]
    fn unrelated_paths_do_not_overlap() {
        assert!(!paths_overlap(Path::new("/music"), Path::new("/pictures")));
    }

    #[test]
    fn parent_dot_dot_resolves_before_comparing() {
        // /music/library/../export normalizes to /music/export, a sibling of the library root.
        assert!(!paths_overlap(
            Path::new("/music/library/../export"),
            Path::new("/music/library"),
        ));
    }

    #[test]
    fn any_overlap_rejects_nested_both_directions_and_accepts_siblings() {
        let existing = vec!["/music/library".to_string()];
        // A nested child and a containing parent both overlap and are rejected.
        assert!(any_overlap(&existing, Path::new("/music/library/sub")));
        assert!(any_overlap(&existing, Path::new("/music")));
        // A sibling that only shares a string prefix does not overlap.
        assert!(!any_overlap(&existing, Path::new("/music/libraryX")));
        assert!(!any_overlap(&existing, Path::new("/pictures")));
    }
}
