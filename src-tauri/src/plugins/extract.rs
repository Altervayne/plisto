/*
 * Unpacks a `.plistoplugin` archive into a staging folder. Each member is written by the shared stager,
 * never by the zip crate's own extract helpers, so names, links and sizes are judged by Plisto's rules
 * alone. The archive may hold `plugin.json` at its root or inside exactly one top-level folder, which
 * is stripped.
 */

// -- Library Imports --
use std::fs;
use std::path::Path;

use zip::read::ZipReadOptions;
use zip::{CompressionMethod, ZipArchive};

// -- Local Imports --
use super::install_error::{ErrorCode, InstallError};
use super::revalidate::MANIFEST_FILE;
use super::stage::{check_rel, Limits, Stager, Totals};

const S_IFMT: u32 = 0o170000;
const S_IFREG: u32 = 0o100000;
const S_IFDIR: u32 = 0o040000;
const S_IFLNK: u32 = 0o120000;

fn bad_archive(detail: impl Into<String>) -> InstallError {
    InstallError::new(ErrorCode::BadArchive, detail)
}

/// The prefix every member name starts with: empty for a root layout, `<folder>/` for a wrapped one.
fn layout_prefix(names: &[String]) -> Result<String, InstallError> {
    if names.iter().any(|n| n == MANIFEST_FILE) {
        return Ok(String::new());
    }
    let top = names
        .first()
        .and_then(|n| n.split('/').next())
        .ok_or_else(|| bad_archive("the archive is empty"))?;
    let prefix = format!("{top}/");
    let wrapped = names.iter().all(|n| n.starts_with(&prefix))
        && names
            .iter()
            .any(|n| *n == format!("{prefix}{MANIFEST_FILE}"));
    if !wrapped {
        return Err(bad_archive(
            "plugin.json must be at the root or inside a single top-level folder",
        ));
    }
    Ok(prefix)
}

/// Extracts `archive` into `dest`, which must exist and be empty. On error `dest` may hold a partial
/// tree; the caller removes it.
pub fn extract(archive: &Path, dest: &Path, limits: Limits) -> Result<Totals, InstallError> {
    let file = fs::File::open(archive).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => {
            InstallError::new(ErrorCode::NotFound, "the file is missing")
        }
        _ => InstallError::io("cannot open the archive", e),
    })?;
    let meta = file
        .metadata()
        .map_err(|e| InstallError::io("cannot read the archive", e))?;
    if !meta.is_file() {
        return Err(InstallError::new(ErrorCode::NotFound, "not a file"));
    }
    if meta.len() > limits.archive_bytes {
        return Err(InstallError::new(
            ErrorCode::TooLarge,
            format!("the archive is over {} bytes", limits.archive_bytes),
        ));
    }
    let mut zip = ZipArchive::new(file).map_err(|e| bad_archive(format!("not a zip: {e}")))?;
    if zip.len() > limits.entries {
        return Err(InstallError::new(
            ErrorCode::TooManyFiles,
            format!(
                "{} entries, over the limit of {}",
                zip.len(),
                limits.entries
            ),
        ));
    }
    // Two members with one name would let either shadow the other.
    if zip.has_duplicate_names() {
        return Err(InstallError::new(
            ErrorCode::NameCollision,
            "the archive names a member twice",
        ));
    }
    // A local header the central directory does not list, or one that disagrees with it, means two
    // tools would see two different archives.
    zip.validate_header_consistency()
        .map_err(|e| bad_archive(format!("inconsistent headers: {e}")))?;

    let mut names = Vec::with_capacity(zip.len());
    for i in 0..zip.len() {
        let entry = zip
            .by_index_data(i)
            .map_err(|e| bad_archive(format!("unreadable member: {e}")))?;
        let name = entry
            .name()
            .map_err(|e| bad_archive(format!("unreadable member name: {e}")))?
            .into_owned();
        check_rel(name.strip_suffix('/').unwrap_or(&name))?;
        if entry.is_symlink() || entry.unix_mode().is_some_and(|m| m & S_IFMT == S_IFLNK) {
            return Err(InstallError::new(
                ErrorCode::LinkNotAllowed,
                format!("'{name}' is a link"),
            ));
        }
        if entry
            .unix_mode()
            .is_some_and(|m| !matches!(m & S_IFMT, 0 | S_IFREG | S_IFDIR))
        {
            return Err(bad_archive(format!("'{name}' is not a file or a folder")));
        }
        if entry.encrypted() {
            return Err(bad_archive(format!("'{name}' is encrypted")));
        }
        if !matches!(
            entry.compression(),
            CompressionMethod::Stored | CompressionMethod::Deflated
        ) {
            return Err(bad_archive(format!(
                "'{name}' uses an unsupported compression method"
            )));
        }
        names.push(name);
    }
    let prefix = layout_prefix(&names)?;

    // A failed read comes from the archive or its decompressor; a failed write is the disk's.
    let mut stager = Stager::new(dest, limits, ErrorCode::BadArchive);
    for (i, name) in names.iter().enumerate() {
        let rel = &name[prefix.len()..];
        if rel.is_empty() {
            continue;
        }
        if let Some(dir) = rel.strip_suffix('/') {
            stager.add_dir(dir)?;
            continue;
        }
        let options = ZipReadOptions::new().enforce_header_consistency(true);
        let mut member = zip
            .by_index_with_options(i, options)
            .map_err(|e| bad_archive(format!("unreadable member '{name}': {e}")))?;
        stager.add_file(rel, &mut member)?;
    }
    Ok(stager.totals())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::stage::Temp;
    use std::io::{Cursor, Write};
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    fn options() -> SimpleFileOptions {
        SimpleFileOptions::default().compression_method(CompressionMethod::Deflated)
    }

    /// Builds an archive in memory from (name, body) pairs; a name ending in '/' is a folder.
    fn build(members: &[(&str, &[u8])]) -> Vec<u8> {
        let mut w = ZipWriter::new(Cursor::new(Vec::new()));
        for (name, body) in members {
            if let Some(dir) = name.strip_suffix('/') {
                w.add_directory(dir, options()).unwrap();
            } else {
                w.start_file(*name, options()).unwrap();
                w.write_all(body).unwrap();
            }
        }
        w.finish().unwrap().into_inner()
    }

    fn run(t: &Temp, bytes: &[u8], limits: Limits) -> Result<Totals, InstallError> {
        let archive = t.0.join("in.plistoplugin");
        fs::write(&archive, bytes).unwrap();
        let dest = t.0.join("out");
        let _ = fs::remove_dir_all(&dest);
        fs::create_dir_all(&dest).unwrap();
        extract(&archive, &dest, limits)
    }

    fn code(members: &[(&str, &[u8])]) -> ErrorCode {
        let t = Temp::new("extract");
        run(&t, &build(members), Limits::DEFAULT).unwrap_err().code
    }

    const MANIFEST: (&str, &[u8]) = ("plugin.json", b"{}");

    fn find(bytes: &[u8], sig: &[u8; 4]) -> Vec<usize> {
        bytes
            .windows(4)
            .enumerate()
            .filter(|(_, w)| w == sig)
            .map(|(i, _)| i)
            .collect()
    }

    /// Overwrites a field at the given offset of every local header and every central header; None
    /// leaves that header kind alone.
    fn patch(bytes: &mut [u8], local: Option<usize>, central: Option<usize>, value: &[u8]) {
        for (sig, offset) in [(b"PK\x03\x04", local), (b"PK\x01\x02", central)] {
            let Some(offset) = offset else { continue };
            for at in find(bytes, sig) {
                bytes[at + offset..at + offset + value.len()].copy_from_slice(value);
            }
        }
    }

    /// Replaces every occurrence of `from` with `to` (same length) in the local headers, the central
    /// directory, or both.
    fn rename(bytes: &mut [u8], from: &[u8], to: &[u8], local: bool, central: bool) {
        let hits: Vec<usize> = bytes
            .windows(from.len())
            .enumerate()
            .filter(|(_, w)| *w == from)
            .map(|(i, _)| i)
            .collect();
        let central_start = find(bytes, b"PK\x01\x02")[0];
        for at in hits {
            if (at < central_start && local) || (at > central_start && central) {
                bytes[at..at + to.len()].copy_from_slice(to);
            }
        }
    }

    #[test]
    fn a_root_layout_extracts_as_is() {
        let t = Temp::new("extract");
        let bytes = build(&[MANIFEST, ("ui/", b""), ("ui/index.html", b"<p>")]);
        let totals = run(&t, &bytes, Limits::DEFAULT).unwrap();
        assert_eq!((totals.files, totals.bytes), (2, 5));
        assert_eq!(totals.longest, "ui/index.html".len());
        assert_eq!(fs::read(t.0.join("out/ui/index.html")).unwrap(), b"<p>");
    }

    #[test]
    fn a_wrapped_folder_is_stripped() {
        let t = Temp::new("extract");
        let bytes = build(&[
            ("demo/", b""),
            ("demo/plugin.json", b"{}"),
            ("demo/index.html", b"x"),
        ]);
        run(&t, &bytes, Limits::DEFAULT).unwrap();
        assert!(t.0.join("out/plugin.json").is_file());
        assert!(t.0.join("out/index.html").is_file());
        assert!(!t.0.join("out/demo").exists());
    }

    #[test]
    fn two_top_level_folders_or_no_manifest_are_refused() {
        assert_eq!(
            code(&[("a/plugin.json", b"{}"), ("b/x.txt", b"")]),
            ErrorCode::BadArchive
        );
        assert_eq!(code(&[("a/b/plugin.json", b"{}")]), ErrorCode::BadArchive);
        assert_eq!(code(&[("x.txt", b"")]), ErrorCode::BadArchive);
        assert_eq!(code(&[]), ErrorCode::BadArchive);
    }

    #[test]
    fn each_hostile_name_is_refused() {
        for name in [
            "../evil.txt",
            "a/../../evil.txt",
            "/abs.txt",
            "C:/evil.txt",
            "a\\evil.txt",
            "evil.txt:stream",
            "con.txt",
            "ui/NUL",
            "evil.",
            "evil ",
            "PROGRA~1.txt",
        ] {
            assert_eq!(
                code(&[MANIFEST, (name, b"x")]),
                ErrorCode::UnsafePath,
                "{name:?}"
            );
        }
    }

    #[test]
    fn case_collisions_are_refused() {
        assert_eq!(
            code(&[MANIFEST, ("Readme.txt", b"a"), ("README.TXT", b"b")]),
            ErrorCode::NameCollision
        );
        // A file and a folder with the same name, in either order.
        assert_eq!(
            code(&[MANIFEST, ("assets", b"a"), ("Assets/x.png", b"b")]),
            ErrorCode::NameCollision
        );
        assert_eq!(
            code(&[MANIFEST, ("ui/x.html", b"a"), ("UI/", b"")]),
            ErrorCode::NameCollision
        );
        assert_eq!(
            code(&[MANIFEST, ("assets/", b""), ("assets", b"a")]),
            ErrorCode::NameCollision
        );
    }

    #[test]
    fn a_name_listed_twice_is_refused() {
        let mut bytes = build(&[MANIFEST, ("a.txt", b"1"), ("b.txt", b"2")]);
        rename(&mut bytes, b"b.txt", b"a.txt", true, true);
        let t = Temp::new("extract");
        let err = run(&t, &bytes, Limits::DEFAULT).unwrap_err();
        assert_eq!(err.code, ErrorCode::NameCollision, "{err}");
        assert!(err.detail.contains("twice"), "{err}");
    }

    #[test]
    fn headers_that_disagree_are_refused_up_front() {
        let mut bytes = build(&[MANIFEST, ("a.txt", b"1"), ("b.txt", b"2")]);
        rename(&mut bytes, b"b.txt", b"c.txt", true, false);
        let t = Temp::new("extract");
        let err = run(&t, &bytes, Limits::DEFAULT).unwrap_err();
        assert_eq!(err.code, ErrorCode::BadArchive);
        assert!(err.detail.contains("inconsistent headers"), "{err}");
        assert_eq!(fs::read_dir(t.0.join("out")).unwrap().count(), 0);
    }

    #[test]
    fn a_special_file_member_is_refused() {
        let opts = options().unix_permissions(0o644);
        let mut w = ZipWriter::new(Cursor::new(Vec::new()));
        w.start_file("plugin.json", opts).unwrap();
        w.write_all(b"{}").unwrap();
        let mut bytes = w.finish().unwrap().into_inner();
        // Made by Unix, and external attributes whose high half says FIFO.
        let fifo: u32 = 0o010644u32 << 16;
        patch(&mut bytes, None, Some(5), &[3]);
        patch(&mut bytes, None, Some(38), &fifo.to_le_bytes());
        let t = Temp::new("extract");
        let err = run(&t, &bytes, Limits::DEFAULT).unwrap_err();
        assert_eq!(err.code, ErrorCode::BadArchive);
        assert!(err.detail.contains("not a file or a folder"), "{err}");
    }

    #[test]
    fn a_symlink_member_is_refused() {
        let mut w = ZipWriter::new(Cursor::new(Vec::new()));
        w.start_file("plugin.json", options()).unwrap();
        w.write_all(b"{}").unwrap();
        w.add_symlink("link", "C:/Windows", options()).unwrap();
        let bytes = w.finish().unwrap().into_inner();
        let t = Temp::new("extract");
        assert_eq!(
            run(&t, &bytes, Limits::DEFAULT).unwrap_err().code,
            ErrorCode::LinkNotAllowed
        );
    }

    #[test]
    fn too_many_entries_are_refused_before_anything_is_written() {
        let t = Temp::new("extract");
        let bytes = build(&[MANIFEST, ("a.txt", b""), ("b.txt", b"")]);
        let limits = Limits {
            entries: 2,
            ..Limits::DEFAULT
        };
        assert_eq!(
            run(&t, &bytes, limits).unwrap_err().code,
            ErrorCode::TooManyFiles
        );
        assert_eq!(fs::read_dir(t.0.join("out")).unwrap().count(), 0);
    }

    #[test]
    fn an_archive_over_the_file_cap_is_refused() {
        let t = Temp::new("extract");
        let bytes = build(&[MANIFEST]);
        let limits = Limits {
            archive_bytes: bytes.len() as u64 - 1,
            ..Limits::DEFAULT
        };
        assert_eq!(
            run(&t, &bytes, limits).unwrap_err().code,
            ErrorCode::TooLarge
        );
    }

    #[test]
    fn encrypted_and_unsupported_members_are_refused() {
        let mut bytes = build(&[MANIFEST]);
        // General purpose flag bit 0: encrypted.
        patch(&mut bytes, Some(6), Some(8), &[1, 0]);
        let t = Temp::new("extract");
        let err = run(&t, &bytes, Limits::DEFAULT).unwrap_err();
        assert_eq!(err.code, ErrorCode::BadArchive);
        assert!(err.detail.contains("encrypted"), "{err}");

        let mut bytes = build(&[MANIFEST]);
        // Compression method 12: bzip2.
        patch(&mut bytes, Some(8), Some(10), &[12, 0]);
        let err = run(&t, &bytes, Limits::DEFAULT).unwrap_err();
        assert_eq!(err.code, ErrorCode::BadArchive);
        assert!(err.detail.contains("compression"), "{err}");
    }

    #[test]
    fn the_byte_cap_is_counted_on_what_is_written() {
        let t = Temp::new("extract");
        let zeros = vec![0u8; 64 * 1024];
        let bytes = build(&[MANIFEST, ("big.bin", &zeros)]);
        let limits = Limits {
            total_bytes: 32 * 1024,
            ..Limits::DEFAULT
        };
        assert_eq!(
            run(&t, &bytes, limits).unwrap_err().code,
            ErrorCode::TooLarge
        );
        let big = fs::metadata(t.0.join("out/big.bin")).unwrap().len();
        assert!(big <= 32 * 1024, "{big}");
    }

    #[test]
    fn a_member_that_understates_its_size_stops_and_fails() {
        let t = Temp::new("extract");
        let zeros = vec![0u8; 256 * 1024];
        let mut bytes = build(&[("big.bin", &zeros), MANIFEST]);
        // Declare 1 KiB uncompressed for every member, in both headers so they still agree.
        patch(&mut bytes, Some(22), Some(24), &1024u32.to_le_bytes());
        let limits = Limits {
            total_bytes: 64 * 1024,
            ..Limits::DEFAULT
        };
        // The zip reader fails once a member passes its declared size, before the byte cap is
        // reached; `the_byte_cap_is_counted_on_what_is_written` covers the cap on its own.
        let err = run(&t, &bytes, limits).unwrap_err();
        assert_eq!(err.code, ErrorCode::BadArchive, "{err}");
        assert!(err.detail.contains("declared"), "{err}");
        let written = fs::metadata(t.0.join("out/big.bin")).map_or(0, |m| m.len());
        assert!(written <= 1024, "{written}");
    }

    #[test]
    fn a_disk_error_while_writing_is_io_not_bad_archive() {
        let t = Temp::new("extract");
        let archive = t.0.join("in.plistoplugin");
        fs::write(&archive, build(&[MANIFEST])).unwrap();
        // A file where the destination folder belongs: creating the member fails on the disk side.
        let dest = t.0.join("out");
        fs::write(&dest, b"").unwrap();
        let err = extract(&archive, &dest, Limits::DEFAULT).unwrap_err();
        assert_eq!(err.code, ErrorCode::Io, "{err}");
    }
}
