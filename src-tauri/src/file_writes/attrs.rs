/*
 * The file attributes a write reads or changes: the read-only flag that refuses a file, and the hidden
 * flag the kept original carries beside its source.
 */

// -- Library Imports --
use std::fs;
use std::io;
use std::path::Path;

#[cfg(windows)]
use std::os::windows::fs::MetadataExt;

#[cfg(windows)]
use windows::core::PCWSTR;
#[cfg(windows)]
use windows::Win32::Storage::FileSystem::{
    SetFileAttributesW, FILE_ATTRIBUTE_ARCHIVE, FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_NORMAL,
    FILE_ATTRIBUTE_NOT_CONTENT_INDEXED, FILE_ATTRIBUTE_OFFLINE, FILE_ATTRIBUTE_PINNED,
    FILE_ATTRIBUTE_READONLY, FILE_ATTRIBUTE_SYSTEM, FILE_ATTRIBUTE_TEMPORARY,
    FILE_ATTRIBUTE_UNPINNED, FILE_FLAGS_AND_ATTRIBUTES,
};

// -- Local Imports --
#[cfg(windows)]
use super::replace::{os_error, verbatim};

// The attributes a write carries through SetFileAttributesW, which replaces the whole set. PINNED and
// UNPINNED hold a cloud file's "Always keep on this device" choice, so they must survive a hide. The
// file system keeps the others a file reports on its own.
#[cfg(windows)]
const SETTABLE: u32 = FILE_ATTRIBUTE_ARCHIVE.0
    | FILE_ATTRIBUTE_HIDDEN.0
    | FILE_ATTRIBUTE_NOT_CONTENT_INDEXED.0
    | FILE_ATTRIBUTE_OFFLINE.0
    | FILE_ATTRIBUTE_PINNED.0
    | FILE_ATTRIBUTE_READONLY.0
    | FILE_ATTRIBUTE_SYSTEM.0
    | FILE_ATTRIBUTE_TEMPORARY.0
    | FILE_ATTRIBUTE_UNPINNED.0;

/// Whether the file carries the read-only attribute. A write refuses such a file rather than clear
/// the flag.
// Unused until a command writes a music file in place.
#[allow(dead_code)]
pub fn is_read_only(path: &Path) -> io::Result<bool> {
    Ok(fs::metadata(path)?.permissions().readonly())
}

#[cfg(windows)]
// Unused until a command writes a music file in place.
#[allow(dead_code)]
pub fn is_hidden(path: &Path) -> io::Result<bool> {
    Ok(fs::metadata(path)?.file_attributes() & FILE_ATTRIBUTE_HIDDEN.0 != 0)
}

#[cfg(windows)]
pub fn set_hidden(path: &Path) -> io::Result<()> {
    change_hidden(path, true)
}

#[cfg(windows)]
pub fn clear_hidden(path: &Path) -> io::Result<()> {
    change_hidden(path, false)
}

/// Sets or clears the hidden flag and leaves every other attribute as it was.
#[cfg(windows)]
fn change_hidden(path: &Path, hidden: bool) -> io::Result<()> {
    let current = fs::metadata(path)?.file_attributes() & SETTABLE;
    let next = if hidden {
        current | FILE_ATTRIBUTE_HIDDEN.0
    } else {
        current & !FILE_ATTRIBUTE_HIDDEN.0
    };
    if next == current {
        return Ok(());
    }
    // NORMAL stands for no attribute at all, and is valid only alone.
    let next = if next == 0 {
        FILE_ATTRIBUTE_NORMAL.0
    } else {
        next
    };
    let wide = verbatim(path)?;
    // SAFETY: `wide` is NUL-terminated and outlives the call.
    unsafe { SetFileAttributesW(PCWSTR(wide.as_ptr()), FILE_FLAGS_AND_ATTRIBUTES(next)) }
        .map_err(os_error)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new(tag: &str) -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let path =
                std::env::temp_dir().join(format!("plisto_attrs_{tag}_{}_{n}", std::process::id()));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            Self { path }
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn hidden_is_set_and_cleared_without_touching_other_flags() {
        let dir = TempDir::new("hidden");
        let file = dir.path.join(".plisto-tmp-bak-0123456789abcdef-a.opus");
        fs::write(&file, b"x").unwrap();
        let before = fs::metadata(&file).unwrap().file_attributes();

        set_hidden(&file).unwrap();
        assert!(is_hidden(&file).unwrap());
        set_hidden(&file).unwrap();
        assert!(is_hidden(&file).unwrap());

        clear_hidden(&file).unwrap();
        assert!(!is_hidden(&file).unwrap());
        assert_eq!(fs::metadata(&file).unwrap().file_attributes(), before);
    }

    fn set_exactly(path: &Path, attrs: FILE_FLAGS_AND_ATTRIBUTES) {
        let wide = verbatim(path).unwrap();
        // SAFETY: `wide` is NUL-terminated and outlives the call.
        unsafe { SetFileAttributesW(PCWSTR(wide.as_ptr()), attrs) }.unwrap();
    }

    #[test]
    fn a_pin_survives_a_hide_and_an_unhide() {
        let dir = TempDir::new("pinned");
        let file = dir.path.join("a.opus");
        fs::write(&file, b"x").unwrap();
        let wide = verbatim(&file).unwrap();
        // SAFETY: `wide` is NUL-terminated and outlives the call.
        let set = unsafe { SetFileAttributesW(PCWSTR(wide.as_ptr()), FILE_ATTRIBUTE_PINNED) };
        let pinned =
            || fs::metadata(&file).unwrap().file_attributes() & FILE_ATTRIBUTE_PINNED.0 != 0;
        if set.is_err() || !pinned() {
            eprintln!("skipped: the volume does not keep the pinned attribute");
            return;
        }

        set_hidden(&file).unwrap();
        assert!(is_hidden(&file).unwrap() && pinned());
        clear_hidden(&file).unwrap();
        assert!(!is_hidden(&file).unwrap() && pinned());
    }

    #[test]
    fn the_last_flag_cleared_leaves_a_normal_file() {
        let dir = TempDir::new("normal");
        let file = dir.path.join("a.opus");
        fs::write(&file, b"x").unwrap();
        set_exactly(&file, FILE_ATTRIBUTE_HIDDEN);

        clear_hidden(&file).unwrap();
        let attrs = fs::metadata(&file).unwrap().file_attributes();
        assert_eq!(attrs & SETTABLE, 0, "{attrs:#x}");
    }

    #[test]
    fn a_read_only_file_is_reported() {
        let dir = TempDir::new("readonly");
        let file = dir.path.join("a.flac");
        fs::write(&file, b"x").unwrap();
        assert!(!is_read_only(&file).unwrap());

        set_exactly(&file, FILE_ATTRIBUTE_READONLY);
        assert!(is_read_only(&file).unwrap());

        // Cleared so the temp dir can be removed.
        set_exactly(&file, FILE_ATTRIBUTE_NORMAL);
        assert!(is_read_only(&dir.path.join("gone.flac")).is_err());
    }
}
