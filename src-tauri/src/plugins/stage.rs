/*
 * The writer both install sources go through: every relative path an archive or a folder offers is
 * checked against one set of Windows-strict rules, and every byte is counted as it is written, never
 * taken from what the source declares. Files are created with `create_new`, so nothing is overwritten
 * even if a rule here is wrong.
 */

// -- Library Imports --
use std::collections::HashMap;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

// -- Local Imports --
use super::install_error::{ErrorCode, InstallError};
use super::paths::is_reserved;

pub const MAX_ENTRIES: usize = 4096;
pub const MAX_TOTAL_BYTES: u64 = 256 * 1024 * 1024;
pub const MAX_ARCHIVE_BYTES: u64 = 256 * 1024 * 1024;
pub const MAX_DEPTH: usize = 16;
pub const MAX_PATH_CHARS: usize = 200;
// A full installed or staged path stays this short, under MAX_PATH with room for tools that append.
pub const MAX_FULL_PATH: usize = 240;

const COPY_BUFFER: usize = 64 * 1024;

/// The caps one staging run enforces. Tests shrink them; everything else uses `Limits::DEFAULT`.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub entries: usize,
    pub total_bytes: u64,
    pub archive_bytes: u64,
}

impl Limits {
    pub const DEFAULT: Limits = Limits {
        entries: MAX_ENTRIES,
        total_bytes: MAX_TOTAL_BYTES,
        archive_bytes: MAX_ARCHIVE_BYTES,
    };
}

fn unsafe_path(rel: &str, why: &str) -> InstallError {
    let shown: String = rel.chars().filter(|c| !c.is_control()).take(80).collect();
    InstallError::new(ErrorCode::UnsafePath, format!("'{shown}' {why}"))
}

/// Whether a component reads as a DOS device. Windows also maps superscript digits and a space
/// before the extension onto the plain device name.
fn is_device(component: &str) -> bool {
    let stem = component
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end_matches(' ');
    let folded: String = stem
        .chars()
        .map(|c| match c {
            '\u{b9}' => '1',
            '\u{b2}' => '2',
            '\u{b3}' => '3',
            c => c,
        })
        .collect();
    is_reserved(component) || is_reserved(&folded)
}

/// Checks a `/`-separated relative path from an archive or a folder walk and returns its components.
pub fn check_rel(rel: &str) -> Result<Vec<&str>, InstallError> {
    if rel.is_empty() {
        return Err(unsafe_path(rel, "is empty"));
    }
    if rel.starts_with('/') || rel.starts_with('\\') {
        return Err(unsafe_path(rel, "is absolute"));
    }
    if rel.as_bytes().get(1) == Some(&b':') {
        return Err(unsafe_path(rel, "has a drive letter"));
    }
    if rel.contains('\\') {
        return Err(unsafe_path(rel, "contains a backslash"));
    }
    // ':' also covers alternate data stream names.
    if let Some(c) = rel
        .chars()
        .find(|c| c.is_control() || matches!(c, ':' | '<' | '>' | '"' | '|' | '?' | '*'))
    {
        let shown = if c.is_control() {
            "a control character".to_string()
        } else {
            format!("'{c}'")
        };
        return Err(unsafe_path(rel, &format!("contains {shown}")));
    }
    if rel.chars().count() > MAX_PATH_CHARS {
        return Err(unsafe_path(rel, "is too long"));
    }
    let parts: Vec<&str> = rel.split('/').collect();
    if parts.len() > MAX_DEPTH {
        return Err(unsafe_path(rel, "is nested too deep"));
    }
    for part in &parts {
        if part.is_empty() {
            return Err(unsafe_path(rel, "has an empty segment"));
        }
        if *part == "." || *part == ".." {
            return Err(unsafe_path(rel, "has a '.' or '..' segment"));
        }
        if part.ends_with('.') || part.ends_with(' ') {
            return Err(unsafe_path(rel, "has a segment ending in a dot or a space"));
        }
        if is_device(part) {
            return Err(unsafe_path(rel, "names a reserved Windows device"));
        }
        // An 8.3 short name can alias another long name in the same folder.
        let bytes = part.as_bytes();
        if bytes
            .windows(2)
            .any(|w| w[0] == b'~' && w[1].is_ascii_digit())
        {
            return Err(unsafe_path(rel, "looks like a short 8.3 name"));
        }
    }
    Ok(parts)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    File,
    Dir,
}

/// What a finished staging run wrote.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Totals {
    pub files: usize,
    pub bytes: u64,
    /// The longest relative path written, in characters.
    pub longest: usize,
}

/// Whether every path written under `base` stays within `MAX_FULL_PATH`.
pub fn fits_under(base: &Path, longest: usize) -> bool {
    base.to_string_lossy().chars().count() + 1 + longest <= MAX_FULL_PATH
}

/// Writes checked entries under one fresh staging folder.
pub struct Stager {
    root: PathBuf,
    limits: Limits,
    // What a failed read of the source means: a bad archive, or a disk error on a folder.
    read_error: ErrorCode,
    // Case-folded path -> (path as written, kind), for the collision rule.
    seen: HashMap<String, (String, Kind)>,
    entries: usize,
    totals: Totals,
}

impl Stager {
    /// `root` must already exist and be empty.
    pub fn new(root: &Path, limits: Limits, read_error: ErrorCode) -> Stager {
        Stager {
            root: root.to_path_buf(),
            limits,
            read_error,
            seen: HashMap::new(),
            entries: 0,
            totals: Totals::default(),
        }
    }

    pub fn totals(&self) -> Totals {
        self.totals
    }

    fn count_entry(&mut self) -> Result<(), InstallError> {
        self.entries += 1;
        if self.entries > self.limits.entries {
            return Err(InstallError::new(
                ErrorCode::TooManyFiles,
                format!("more than {} entries", self.limits.entries),
            ));
        }
        Ok(())
    }

    /// Records one path and its parents. The same folder may be named twice; anything else that
    /// matches an earlier path case-insensitively is a collision.
    fn claim(&mut self, parts: &[&str], kind: Kind) -> Result<(), InstallError> {
        for end in 1..=parts.len() {
            let path = parts[..end].join("/");
            let want = if end == parts.len() { kind } else { Kind::Dir };
            match self.seen.get(&path.to_lowercase()) {
                Some((earlier, Kind::Dir)) if want == Kind::Dir && *earlier == path => {}
                Some(_) => {
                    return Err(InstallError::new(
                        ErrorCode::NameCollision,
                        format!("'{path}' collides with an earlier entry"),
                    ))
                }
                None => {
                    self.seen.insert(path.to_lowercase(), (path, want));
                }
            }
        }
        Ok(())
    }

    fn target(&self, parts: &[&str]) -> PathBuf {
        let mut path = self.root.clone();
        path.extend(parts);
        path
    }

    fn note_length(&mut self, rel: &str) {
        self.totals.longest = self.totals.longest.max(rel.chars().count());
    }

    pub fn add_dir(&mut self, rel: &str) -> Result<(), InstallError> {
        let parts = check_rel(rel)?;
        self.count_entry()?;
        self.claim(&parts, Kind::Dir)?;
        self.note_length(rel);
        fs::create_dir_all(self.target(&parts))
            .map_err(|e| InstallError::io("cannot create a folder", e))
    }

    /// Writes one file from `src`, stopping and failing as soon as the total passes the byte cap.
    pub fn add_file(&mut self, rel: &str, src: &mut dyn Read) -> Result<(), InstallError> {
        let parts = check_rel(rel)?;
        self.count_entry()?;
        self.claim(&parts, Kind::File)?;
        self.note_length(rel);
        let path = self.target(&parts);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| InstallError::io("cannot create a folder", e))?;
        }
        let mut out = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| match e.kind() {
                io::ErrorKind::AlreadyExists => InstallError::new(
                    ErrorCode::NameCollision,
                    format!("'{rel}' already exists in staging"),
                ),
                _ => InstallError::io("cannot create a file", e),
            })?;
        let room = self.limits.total_bytes - self.totals.bytes;
        let mut written = 0u64;
        let mut buf = vec![0u8; COPY_BUFFER];
        loop {
            let n = match src.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => {
                    return Err(InstallError::new(
                        self.read_error,
                        format!("cannot read '{rel}': {e}"),
                    ))
                }
            };
            written += n as u64;
            if written > room {
                return Err(InstallError::new(
                    ErrorCode::TooLarge,
                    format!("more than {} bytes in total", self.limits.total_bytes),
                ));
            }
            out.write_all(&buf[..n])
                .map_err(|e| InstallError::io(&format!("cannot write '{rel}'"), e))?;
        }
        self.totals.bytes += written;
        self.totals.files += 1;
        Ok(())
    }
}

/// A throwaway folder under the system temp dir, removed on drop.
#[cfg(test)]
pub struct Temp(pub PathBuf);

#[cfg(test)]
impl Temp {
    pub fn new(tag: &str) -> Temp {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static N: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "plisto-{tag}-test-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Temp(dir)
    }
}

#[cfg(test)]
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_paths_pass() {
        for p in [
            "plugin.json",
            "ui/index.html",
            "a b/c d.txt",
            "deep/er/x.y.z",
            "caf\u{e9}.txt",
            "~notshort",
            "con-tent.txt",
        ] {
            assert!(check_rel(p).is_ok(), "{p}");
        }
    }

    #[test]
    fn hostile_paths_reject() {
        let long = "a".repeat(MAX_PATH_CHARS + 1);
        let deep = vec!["d"; MAX_DEPTH + 1].join("/");
        for p in [
            "",
            "/abs",
            "\\abs",
            "C:/x",
            "c:x",
            "a\\b",
            "a:b",
            "a/b:stream",
            "a\u{1}b",
            "a<b",
            "a>b",
            "a\"b",
            "a|b",
            "a?b",
            "a*b",
            "a//b",
            "a/",
            "./a",
            "a/../b",
            "a.",
            "a /b",
            "con",
            "ui/NUL.txt",
            "Com1.json",
            "lpt\u{b9}.txt",
            "aux .txt",
            "PROGRA~1/x",
            "file~2.txt",
            long.as_str(),
            deep.as_str(),
        ] {
            assert_eq!(
                check_rel(p).map(|_| ()).unwrap_err().code,
                ErrorCode::UnsafePath,
                "{p:?}"
            );
        }
    }

    #[test]
    fn an_existing_file_is_never_overwritten() {
        let t = Temp::new("stage");
        fs::write(t.0.join("plugin.json"), b"kept").unwrap();
        let mut stager = Stager::new(&t.0, Limits::DEFAULT, ErrorCode::Io);
        let err = stager
            .add_file("plugin.json", &mut &b"new"[..])
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::NameCollision);
        assert_eq!(fs::read(t.0.join("plugin.json")).unwrap(), b"kept");
    }

    #[test]
    fn a_folder_then_a_file_of_the_same_name_collide() {
        let t = Temp::new("stage");
        let mut stager = Stager::new(&t.0, Limits::DEFAULT, ErrorCode::Io);
        stager.add_dir("assets").unwrap();
        let err = stager.add_file("Assets", &mut &b"x"[..]).unwrap_err();
        assert_eq!(err.code, ErrorCode::NameCollision);
        // The same folder named twice is fine.
        stager.add_dir("assets").unwrap();
    }

    #[test]
    fn nothing_past_the_byte_cap_reaches_the_disk() {
        let t = Temp::new("stage");
        let limits = Limits {
            total_bytes: 10,
            ..Limits::DEFAULT
        };
        let mut stager = Stager::new(&t.0, limits, ErrorCode::Io);
        stager.add_file("a", &mut &[0u8; 6][..]).unwrap();
        let err = stager.add_file("b", &mut &[0u8; 6][..]).unwrap_err();
        assert_eq!(err.code, ErrorCode::TooLarge);
        assert_eq!(fs::metadata(t.0.join("b")).unwrap().len(), 0);
    }

    #[test]
    fn full_paths_are_measured_against_the_cap() {
        let base = Path::new("C:/a");
        let room = MAX_FULL_PATH - 4 - 1;
        assert!(fits_under(base, room));
        assert!(!fits_under(base, room + 1));
    }
}
