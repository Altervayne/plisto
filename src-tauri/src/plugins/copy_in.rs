/*
 * Copies a plugin folder into a staging folder through the shared stager. Nothing that could reach
 * outside the tree is followed: any junction, symlink or other reparse point refuses the folder. Files
 * are copied by reading their default stream into a new file, so no alternate stream travels along,
 * and a file or folder carrying a named stream other than `Zone.Identifier` refuses the folder.
 * Windows adds that one to every file unpacked from a downloaded archive, so refusing it would refuse
 * most real installs. A volume that has no named streams at all (FAT32, exFAT) skips the check.
 */

// -- Library Imports --
use std::fs;
use std::io;
use std::path::Path;

// -- Local Imports --
use super::frame_host::is_reparse_point;
use super::install_error::{ErrorCode, InstallError};
use super::revalidate::MANIFEST_FILE;
use super::stage::{Limits, Stager, Totals};

// The volume flag saying named streams exist there.
const FILE_NAMED_STREAMS: u32 = 0x0004_0000;

fn link(rel: &str) -> InstallError {
    InstallError::new(ErrorCode::LinkNotAllowed, format!("'{rel}' is a link"))
}

fn read_error(what: &str, e: io::Error) -> InstallError {
    match e.kind() {
        io::ErrorKind::NotFound => InstallError::new(ErrorCode::NotFound, format!("{what}: {e}")),
        _ => InstallError::io(what, e),
    }
}

/// Whether streams must be checked on a volume with these flags. A volume that cannot be queried is
/// checked, so a failure there fails closed.
fn must_check_streams(volume_flags: Option<u32>) -> bool {
    match volume_flags {
        Some(flags) => flags & FILE_NAMED_STREAMS != 0,
        None => true,
    }
}

/// Copies the folder at `source` into `dest`, which must exist and be empty. On error `dest` may hold
/// a partial tree; the caller removes it.
pub fn copy_in(source: &Path, dest: &Path, limits: Limits) -> Result<Totals, InstallError> {
    let meta = fs::symlink_metadata(source).map_err(|e| read_error("cannot read the folder", e))?;
    if is_reparse_point(&meta) {
        return Err(link("."));
    }
    if !meta.is_dir() {
        return Err(InstallError::new(ErrorCode::NotFound, "not a folder"));
    }
    if !fs::symlink_metadata(source.join(MANIFEST_FILE)).is_ok_and(|m| m.is_file()) {
        return Err(InstallError::new(
            ErrorCode::MissingFile,
            "plugin.json is not at the root of the folder",
        ));
    }
    // The verbatim form a canonical path takes on Windows lifts the MAX_PATH limit of the stream API.
    let source =
        fs::canonicalize(source).map_err(|e| InstallError::io("cannot resolve the folder", e))?;
    let streams = must_check_streams(volume_flags(&source));
    if streams {
        check_streams(&source, ".")?;
    }
    let mut stager = Stager::new(dest, limits, ErrorCode::Io);
    walk(&source, "", &mut stager, streams)?;
    Ok(stager.totals())
}

fn walk(dir: &Path, rel: &str, stager: &mut Stager, streams: bool) -> Result<(), InstallError> {
    let read = fs::read_dir(dir).map_err(|e| InstallError::io("cannot list a folder", e))?;
    for item in read {
        let item = item.map_err(|e| InstallError::io("cannot list a folder", e))?;
        let name = item
            .file_name()
            .into_string()
            .map_err(|_| InstallError::new(ErrorCode::UnsafePath, "a name is not valid Unicode"))?;
        let child_rel = if rel.is_empty() {
            name
        } else {
            format!("{rel}/{name}")
        };
        let path = item.path();
        let meta = fs::symlink_metadata(&path)
            .map_err(|e| InstallError::io(&format!("cannot read '{child_rel}'"), e))?;
        if is_reparse_point(&meta) {
            return Err(link(&child_rel));
        }
        if !meta.is_dir() && !meta.is_file() {
            return Err(link(&child_rel));
        }
        if streams {
            check_streams(&path, &child_rel)?;
        }
        if meta.is_dir() {
            stager.add_dir(&child_rel)?;
            walk(&path, &child_rel, stager, streams)?;
        } else {
            let mut file = open_plain(&path)
                .map_err(|e| InstallError::io(&format!("cannot read '{child_rel}'"), e))?;
            stager.add_file(&child_rel, &mut file)?;
        }
    }
    Ok(())
}

/// Opens a file without following a reparse point, and refuses what the handle shows to be a link or
/// a folder, whatever the listing said a moment before.
#[cfg(windows)]
fn open_plain(path: &Path) -> io::Result<fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    };
    // Backup semantics lets a folder or a folder link open too, so the checks below see it.
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0 | FILE_FLAG_BACKUP_SEMANTICS.0)
        .open(path)?;
    let meta = file.metadata()?;
    if is_reparse_point(&meta) {
        return Err(io::Error::other("the file is a link"));
    }
    if !meta.is_file() {
        return Err(io::Error::other("not a plain file"));
    }
    Ok(file)
}

#[cfg(not(windows))]
fn open_plain(path: &Path) -> io::Result<fs::File> {
    fs::File::open(path)
}

/// Refuses a file or folder that carries a named stream other than `Zone.Identifier`.
#[cfg(windows)]
fn check_streams(path: &Path, rel: &str) -> Result<(), InstallError> {
    let names = streams::list(path)
        .map_err(|e| InstallError::io(&format!("cannot list the streams of '{rel}'"), e))?;
    match names.iter().find(|n| !streams::is_allowed(n)) {
        Some(found) => Err(InstallError::new(
            ErrorCode::StreamNotAllowed,
            format!("'{rel}' has a hidden stream '{found}'"),
        )),
        None => Ok(()),
    }
}

#[cfg(not(windows))]
fn check_streams(_path: &Path, _rel: &str) -> Result<(), InstallError> {
    Ok(())
}

#[cfg(windows)]
fn volume_flags(path: &Path) -> Option<u32> {
    streams::volume_flags(path)
}

#[cfg(not(windows))]
fn volume_flags(_path: &Path) -> Option<u32> {
    Some(0)
}

#[cfg(windows)]
pub(super) mod streams {
    use std::io;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    use windows::core::PCWSTR;
    use windows::Win32::Foundation::ERROR_HANDLE_EOF;
    use windows::Win32::Storage::FileSystem::{
        FindClose, FindFirstStreamW, FindNextStreamW, FindStreamInfoStandard,
        GetVolumeInformationW, GetVolumePathNameW, WIN32_FIND_STREAM_DATA,
    };

    const DEFAULT: &str = "::$DATA";
    const ZONE: &str = ":Zone.Identifier:$DATA";
    const VOLUME_PATH_MAX: usize = 32 * 1024;

    pub fn is_allowed(name: &str) -> bool {
        name == DEFAULT || name.eq_ignore_ascii_case(ZONE)
    }

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(Some(0)).collect()
    }

    fn stream_name(data: &WIN32_FIND_STREAM_DATA) -> String {
        let len = data
            .cStreamName
            .iter()
            .position(|&c| c == 0)
            .unwrap_or(data.cStreamName.len());
        String::from_utf16_lossy(&data.cStreamName[..len])
    }

    /// The file system flags of the volume holding `path`, or None when they cannot be read.
    pub fn volume_flags(path: &Path) -> Option<u32> {
        let name = wide(path);
        let mut root = vec![0u16; VOLUME_PATH_MAX];
        // SAFETY: `name` is NUL-terminated and `root` is a writable buffer the call is told the size of.
        unsafe { GetVolumePathNameW(PCWSTR(name.as_ptr()), &mut root) }.ok()?;
        let mut flags = 0u32;
        // SAFETY: `root` now holds a NUL-terminated volume path; `flags` outlives the call.
        unsafe {
            GetVolumeInformationW(
                PCWSTR(root.as_ptr()),
                None,
                None,
                None,
                Some(&mut flags),
                None,
            )
        }
        .ok()?;
        Some(flags)
    }

    /// Every data stream of a file or folder, by its full name (`::$DATA` for the unnamed one).
    pub fn list(path: &Path) -> io::Result<Vec<String>> {
        let wide = wide(path);
        let mut data = WIN32_FIND_STREAM_DATA::default();
        // SAFETY: `wide` is NUL-terminated and outlives the call; `data` is the struct this info
        // level writes.
        let first = unsafe {
            FindFirstStreamW(
                PCWSTR(wide.as_ptr()),
                FindStreamInfoStandard,
                &mut data as *mut _ as *mut _,
                0,
            )
        };
        let handle = match first {
            Ok(handle) => handle,
            // A folder with no stream at all reports end of list straight away.
            Err(e) if e.code() == ERROR_HANDLE_EOF.to_hresult() => return Ok(Vec::new()),
            Err(e) => return Err(io::Error::other(e)),
        };
        let mut names = vec![stream_name(&data)];
        loop {
            // SAFETY: `handle` came from FindFirstStreamW and is closed once below.
            match unsafe { FindNextStreamW(handle, &mut data as *mut _ as *mut _) } {
                Ok(()) => names.push(stream_name(&data)),
                Err(e) => {
                    // SAFETY: closed exactly once.
                    let _ = unsafe { FindClose(handle) };
                    if e.code() == ERROR_HANDLE_EOF.to_hresult() {
                        return Ok(names);
                    }
                    return Err(io::Error::other(e));
                }
            }
        }
    }
}

#[cfg(test)]
mod decision_tests {
    use super::*;

    #[test]
    fn streams_are_checked_unless_the_volume_has_none() {
        assert!(must_check_streams(Some(FILE_NAMED_STREAMS | 0x3)));
        assert!(!must_check_streams(Some(0x3)));
        assert!(!must_check_streams(Some(0)));
        assert!(must_check_streams(None));
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use crate::plugins::stage::Temp;
    use std::process::Command;

    fn source(t: &Temp) -> std::path::PathBuf {
        let src = t.0.join("src");
        fs::create_dir_all(src.join("ui")).unwrap();
        fs::write(src.join("plugin.json"), b"{}").unwrap();
        fs::write(src.join("ui/index.html"), b"<p>").unwrap();
        src
    }

    fn run_with(t: &Temp, src: &Path, limits: Limits) -> Result<Totals, InstallError> {
        let dest = t.0.join("out");
        let _ = fs::remove_dir_all(&dest);
        fs::create_dir_all(&dest).unwrap();
        copy_in(src, &dest, limits)
    }

    fn run(t: &Temp, src: &Path) -> Result<Totals, InstallError> {
        run_with(t, src, Limits::DEFAULT)
    }

    fn junction(link: &Path, target: &Path) {
        let status = Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .unwrap()
            .status;
        assert!(status.success());
    }

    #[test]
    fn a_plain_folder_is_copied() {
        let t = Temp::new("copy-in");
        let src = source(&t);
        let totals = run(&t, &src).unwrap();
        assert_eq!((totals.files, totals.bytes), (2, 5));
        assert_eq!(fs::read(t.0.join("out/ui/index.html")).unwrap(), b"<p>");
    }

    #[test]
    fn the_source_volume_reports_named_streams() {
        let t = Temp::new("copy-in");
        let flags = streams::volume_flags(&fs::canonicalize(&t.0).unwrap()).unwrap();
        assert!(must_check_streams(Some(flags)));
    }

    #[test]
    fn a_folder_without_a_root_manifest_is_refused() {
        let t = Temp::new("copy-in");
        let src = source(&t);
        fs::remove_file(src.join("plugin.json")).unwrap();
        assert_eq!(run(&t, &src).unwrap_err().code, ErrorCode::MissingFile);
        assert_eq!(
            run(&t, &t.0.join("nowhere")).unwrap_err().code,
            ErrorCode::NotFound
        );
    }

    #[test]
    fn a_junction_inside_the_tree_is_refused() {
        let t = Temp::new("copy-in");
        let src = source(&t);
        let outside = t.0.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), b"s").unwrap();
        junction(&src.join("ui").join("escape"), &outside);
        assert_eq!(run(&t, &src).unwrap_err().code, ErrorCode::LinkNotAllowed);
        // Removing the junction leaves its target alone.
        fs::remove_dir(src.join("ui").join("escape")).unwrap();
        assert!(outside.join("secret.txt").is_file());
    }

    #[test]
    fn a_junction_as_the_source_is_refused() {
        let t = Temp::new("copy-in");
        let src = source(&t);
        let link = t.0.join("link");
        junction(&link, &src);
        assert_eq!(run(&t, &link).unwrap_err().code, ErrorCode::LinkNotAllowed);
        fs::remove_dir(&link).unwrap();
    }

    #[test]
    fn opening_a_link_is_refused_after_the_open() {
        let t = Temp::new("copy-in");
        let src = source(&t);
        let link = t.0.join("link");
        junction(&link, &src);
        // The open itself succeeds on the link; only the re-check refuses it.
        let err = open_plain(&link).unwrap_err();
        assert!(err.to_string().contains("link"), "{err}");
        assert!(open_plain(&src.join("plugin.json")).is_ok());
        assert!(open_plain(&src.join("ui")).is_err());
        fs::remove_dir(&link).unwrap();
    }

    #[test]
    fn a_named_stream_on_a_file_is_refused() {
        let t = Temp::new("copy-in");
        let src = source(&t);
        fs::write(src.join("ui/index.html:payload"), b"hidden").unwrap();
        assert_eq!(run(&t, &src).unwrap_err().code, ErrorCode::StreamNotAllowed);
    }

    #[test]
    fn a_named_stream_on_a_folder_or_the_root_is_refused() {
        let t = Temp::new("copy-in");
        let src = source(&t);
        let mut stream = src.join("ui").into_os_string();
        stream.push(":payload");
        fs::write(&stream, b"hidden").unwrap();
        let err = run(&t, &src).unwrap_err();
        assert_eq!(err.code, ErrorCode::StreamNotAllowed);
        assert!(err.detail.contains("'ui'"), "{err}");

        let t = Temp::new("copy-in");
        let src = source(&t);
        let mut stream = src.clone().into_os_string();
        stream.push(":payload");
        fs::write(&stream, b"hidden").unwrap();
        let err = run(&t, &src).unwrap_err();
        assert_eq!(err.code, ErrorCode::StreamNotAllowed);
        assert!(err.detail.contains("'.'"), "{err}");
    }

    #[test]
    fn zone_identifier_is_accepted_and_never_copied() {
        let t = Temp::new("copy-in");
        let src = source(&t);
        let index = src.join("ui/index.html");
        fs::write(
            src.join("ui/index.html:Zone.Identifier"),
            b"[ZoneTransfer]\r\nZoneId=3",
        )
        .unwrap();
        assert_eq!(streams::list(&index).unwrap().len(), 2);
        run(&t, &src).unwrap();
        for file in ["out/ui/index.html", "out/plugin.json"] {
            assert_eq!(
                streams::list(&t.0.join(file)).unwrap(),
                ["::$DATA"],
                "{file}"
            );
        }
    }

    #[test]
    fn hostile_names_on_disk_are_refused() {
        let t = Temp::new("copy-in");
        let src = source(&t);
        fs::write(src.join("FILE~1.txt"), b"x").unwrap();
        assert_eq!(run(&t, &src).unwrap_err().code, ErrorCode::UnsafePath);
    }

    #[test]
    fn a_folder_over_the_entry_cap_is_refused() {
        let t = Temp::new("copy-in");
        let src = source(&t);
        let limits = Limits {
            entries: 2,
            ..Limits::DEFAULT
        };
        assert_eq!(
            run_with(&t, &src, limits).unwrap_err().code,
            ErrorCode::TooManyFiles
        );
    }

    #[test]
    fn a_folder_over_the_byte_cap_is_refused() {
        let t = Temp::new("copy-in");
        let src = source(&t);
        fs::write(src.join("big.bin"), vec![0u8; 4096]).unwrap();
        let limits = Limits {
            total_bytes: 1024,
            ..Limits::DEFAULT
        };
        assert_eq!(
            run_with(&t, &src, limits).unwrap_err().code,
            ErrorCode::TooLarge
        );
    }

    #[test]
    fn a_file_that_cannot_be_read_fails_the_copy() {
        use std::os::windows::fs::OpenOptionsExt;
        let t = Temp::new("copy-in");
        let src = source(&t);
        // Held open with no sharing, so every other open fails.
        let held = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(src.join("ui/index.html"))
            .unwrap();
        assert_eq!(run(&t, &src).unwrap_err().code, ErrorCode::Io);
        drop(held);
        assert!(run(&t, &src).is_ok());
    }
}
