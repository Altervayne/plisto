/*
 * The install-time disk checks for a manifest's `icon`: the file must resolve inside the plugin
 * folder, be a plain file within the size cap, and be square (a PNG at least 64 px, or an SVG whose
 * viewBox or width/height are equal). The manifest parser stays I/O free; this takes the plugin dir.
 */

// -- Library Imports --
use std::fmt;
use std::fs;
use std::path::Path;

// -- Local Imports --
use super::paths::validate_rel_path;

pub const MAX_ICON_BYTES: u64 = 256 * 1024;
pub const MIN_PNG_SIDE: u32 = 64;

const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IconError {
    BadPath(&'static str),
    Missing,
    NotAFile,
    OutsideDir,
    TooLarge(u64),
    Unreadable,
    BadPng,
    PngTooSmall(u32),
    NotSquare,
    BadSvg,
}

impl fmt::Display for IconError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            IconError::BadPath(reason) => write!(f, "icon path {reason}"),
            IconError::Missing => write!(f, "icon file is missing"),
            IconError::NotAFile => write!(f, "icon is not a plain file"),
            IconError::OutsideDir => write!(f, "icon resolves outside the plugin folder"),
            IconError::TooLarge(n) => {
                write!(f, "icon is {n} bytes, over the {MAX_ICON_BYTES} byte limit")
            }
            IconError::Unreadable => write!(f, "icon file could not be read"),
            IconError::BadPng => write!(f, "icon is not a valid PNG"),
            IconError::PngTooSmall(side) => {
                write!(f, "icon is {side} px, under the {MIN_PNG_SIDE} px minimum")
            }
            IconError::NotSquare => write!(f, "icon is not square"),
            IconError::BadSvg => write!(f, "icon is not a valid SVG"),
        }
    }
}

impl std::error::Error for IconError {}

/// Checks the icon named by `rel` (already accepted by the manifest parser) inside `plugin_dir`.
pub fn check_icon(plugin_dir: &Path, rel: &str) -> Result<(), IconError> {
    validate_rel_path(rel).map_err(IconError::BadPath)?;
    let path = plugin_dir.join(rel);

    // symlink_metadata so a link planted as the icon is refused rather than followed.
    let meta = fs::symlink_metadata(&path).map_err(|_| IconError::Missing)?;
    if !meta.is_file() {
        return Err(IconError::NotAFile);
    }
    // Canonical paths catch a link anywhere in the directory chain that leads out of the folder.
    let root = fs::canonicalize(plugin_dir).map_err(|_| IconError::Unreadable)?;
    let real = fs::canonicalize(&path).map_err(|_| IconError::Missing)?;
    if !real.starts_with(&root) {
        return Err(IconError::OutsideDir);
    }
    if meta.len() > MAX_ICON_BYTES {
        return Err(IconError::TooLarge(meta.len()));
    }
    let bytes = fs::read(&real).map_err(|_| IconError::Unreadable)?;

    if rel.to_ascii_lowercase().ends_with(".png") {
        check_png(&bytes)
    } else {
        check_svg(&bytes)
    }
}

fn check_png(bytes: &[u8]) -> Result<(), IconError> {
    // Signature, then the IHDR chunk: 4-byte length (13), "IHDR", width, height.
    if bytes.len() < 24 || bytes[..8] != PNG_SIGNATURE || &bytes[12..16] != b"IHDR" {
        return Err(IconError::BadPng);
    }
    let side =
        |at: usize| u32::from_be_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]);
    let (w, h) = (side(16), side(20));
    if w != h {
        return Err(IconError::NotSquare);
    }
    if w < MIN_PNG_SIDE {
        return Err(IconError::PngTooSmall(w));
    }
    Ok(())
}

/// Returns the value of `name="..."` (or single-quoted) inside a tag, matching whole attribute names only.
fn attr<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let mut from = 0;
    while let Some(pos) = tag[from..].find(name) {
        let start = from + pos;
        let end = start + name.len();
        from = end;
        let boundary = tag[..start]
            .chars()
            .next_back()
            .map_or(true, char::is_whitespace);
        let rest = tag[end..].trim_start();
        if !boundary || !rest.starts_with('=') {
            continue;
        }
        let rest = rest[1..].trim_start();
        let quote = rest.chars().next().filter(|c| *c == '"' || *c == '\'')?;
        let body = &rest[1..];
        return body.find(quote).map(|close| &body[..close]);
    }
    None
}

fn number(s: &str) -> Option<f64> {
    let n: f64 = s.trim().trim_end_matches("px").trim().parse().ok()?;
    (n.is_finite() && n > 0.0).then_some(n)
}

fn check_svg(bytes: &[u8]) -> Result<(), IconError> {
    let text = std::str::from_utf8(bytes).map_err(|_| IconError::BadSvg)?;
    let open = text.find("<svg").ok_or(IconError::BadSvg)?;
    let after = &text[open + 4..];
    // The tag name must end here: `<svgfoo` is not the root element.
    if !after.starts_with(|c: char| c.is_whitespace() || c == '>' || c == '/') {
        return Err(IconError::BadSvg);
    }
    let tag = &after[..after.find('>').ok_or(IconError::BadSvg)?];

    if let Some(view_box) = attr(tag, "viewBox") {
        let nums: Vec<&str> = view_box
            .split(|c: char| c.is_whitespace() || c == ',')
            .filter(|p| !p.is_empty())
            .collect();
        if nums.len() != 4 {
            return Err(IconError::BadSvg);
        }
        let (w, h) = (
            number(nums[2]).ok_or(IconError::BadSvg)?,
            number(nums[3]).ok_or(IconError::BadSvg)?,
        );
        return if w == h {
            Ok(())
        } else {
            Err(IconError::NotSquare)
        };
    }
    match (
        attr(tag, "width").and_then(number),
        attr(tag, "height").and_then(number),
    ) {
        (Some(w), Some(h)) if w == h => Ok(()),
        (Some(_), Some(_)) => Err(IconError::NotSquare),
        _ => Err(IconError::BadSvg),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Dir(PathBuf);

    impl Dir {
        fn new() -> Dir {
            static N: AtomicUsize = AtomicUsize::new(0);
            let p = std::env::temp_dir().join(format!(
                "plisto-icon-test-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&p).unwrap();
            Dir(p)
        }

        fn write(&self, rel: &str, bytes: &[u8]) {
            let p = self.0.join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, bytes).unwrap();
        }
    }

    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn png(w: u32, h: u32) -> Vec<u8> {
        let mut b = PNG_SIGNATURE.to_vec();
        b.extend_from_slice(&13u32.to_be_bytes());
        b.extend_from_slice(b"IHDR");
        b.extend_from_slice(&w.to_be_bytes());
        b.extend_from_slice(&h.to_be_bytes());
        b.extend_from_slice(&[8, 6, 0, 0, 0]);
        b
    }

    #[test]
    fn valid_png_passes() {
        let d = Dir::new();
        d.write("icon.png", &png(64, 64));
        d.write("a/b.png", &png(256, 256));
        assert_eq!(check_icon(&d.0, "icon.png"), Ok(()));
        assert_eq!(check_icon(&d.0, "a/b.png"), Ok(()));
    }

    #[test]
    fn png_rules() {
        let d = Dir::new();
        d.write("small.png", &png(63, 63));
        d.write("wide.png", &png(128, 64));
        d.write("junk.png", b"not a png at all, just text bytes here");
        d.write("short.png", &PNG_SIGNATURE);
        assert_eq!(
            check_icon(&d.0, "small.png"),
            Err(IconError::PngTooSmall(63))
        );
        assert_eq!(check_icon(&d.0, "wide.png"), Err(IconError::NotSquare));
        assert_eq!(check_icon(&d.0, "junk.png"), Err(IconError::BadPng));
        assert_eq!(check_icon(&d.0, "short.png"), Err(IconError::BadPng));
    }

    #[test]
    fn svg_rules() {
        let d = Dir::new();
        d.write("vb.svg", br#"<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"></svg>"#);
        d.write("wh.svg", br#"<svg width="32px" height='32'></svg>"#);
        d.write("vbwide.svg", br#"<svg viewBox="0 0 48 24"></svg>"#);
        d.write("whwide.svg", br#"<svg width="10" height="20"></svg>"#);
        d.write("nosize.svg", br#"<svg></svg>"#);
        d.write("notsvg.svg", b"<html></html>");
        d.write("lookalike.svg", br#"<svgfoo viewBox="0 0 1 1">"#);
        d.write(
            "prefixed.svg",
            br#"<svg data-width="5" data-height="9" width="8" height="8"></svg>"#,
        );
        d.write("badvb.svg", br#"<svg viewBox="0 0 24"></svg>"#);
        d.write("binary.svg", &[0xff, 0xfe, 0x00]);
        assert_eq!(check_icon(&d.0, "vb.svg"), Ok(()));
        assert_eq!(check_icon(&d.0, "wh.svg"), Ok(()));
        assert_eq!(check_icon(&d.0, "prefixed.svg"), Ok(()));
        assert_eq!(check_icon(&d.0, "vbwide.svg"), Err(IconError::NotSquare));
        assert_eq!(check_icon(&d.0, "whwide.svg"), Err(IconError::NotSquare));
        assert_eq!(check_icon(&d.0, "nosize.svg"), Err(IconError::BadSvg));
        assert_eq!(check_icon(&d.0, "notsvg.svg"), Err(IconError::BadSvg));
        assert_eq!(check_icon(&d.0, "lookalike.svg"), Err(IconError::BadSvg));
        assert_eq!(check_icon(&d.0, "badvb.svg"), Err(IconError::BadSvg));
        assert_eq!(check_icon(&d.0, "binary.svg"), Err(IconError::BadSvg));
    }

    #[test]
    fn size_cap() {
        let d = Dir::new();
        let mut big = png(64, 64);
        big.resize(MAX_ICON_BYTES as usize + 1, 0);
        d.write("big.png", &big);
        big.truncate(MAX_ICON_BYTES as usize);
        d.write("edge.png", &big);
        assert_eq!(
            check_icon(&d.0, "big.png"),
            Err(IconError::TooLarge(MAX_ICON_BYTES + 1))
        );
        assert_eq!(check_icon(&d.0, "edge.png"), Ok(()));
    }

    #[test]
    fn missing_and_directory_icons_reject() {
        let d = Dir::new();
        fs::create_dir_all(d.0.join("dir.png")).unwrap();
        assert_eq!(check_icon(&d.0, "nope.png"), Err(IconError::Missing));
        assert_eq!(check_icon(&d.0, "dir.png"), Err(IconError::NotAFile));
    }

    #[test]
    fn unsafe_paths_reject_before_touching_disk() {
        let d = Dir::new();
        for p in [
            "../icon.png",
            "/icon.png",
            "C:/icon.png",
            "a\\b.png",
            "nul.png",
        ] {
            assert!(
                matches!(check_icon(&d.0, p), Err(IconError::BadPath(_))),
                "{p}"
            );
        }
    }

    #[test]
    fn escaping_the_folder_rejects() {
        let d = Dir::new();
        let outside = Dir::new();
        outside.write("secret.png", &png(64, 64));
        let plugin = d.0.join("plugin");
        fs::create_dir_all(&plugin).unwrap();
        // A directory link needs privileges on Windows; skip where it cannot be created.
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&outside.0, plugin.join("link")).is_ok();
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_dir(&outside.0, plugin.join("link")).is_ok();
        if linked {
            assert_eq!(
                check_icon(&plugin, "link/secret.png"),
                Err(IconError::OutsideDir)
            );
        }
    }
}
