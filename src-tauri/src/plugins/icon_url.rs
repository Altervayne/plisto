/*
 * A plugin's icon as a `data:` URL for the settings list and the review sheet. The file goes through the
 * same disk checks as at install (`check_icon`: inside the folder, a plain file, size cap, square), so a
 * file edited since then is refused rather than shown. Every failure is `None`: an icon is decoration
 * and never an error.
 */

// -- Library Imports --
use std::fs;
use std::io::Read;
use std::path::Path;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;

// -- Local Imports --
use super::icon::{check_icon, MAX_ICON_BYTES};
use super::paths::{plugin_dir, validate_id};
use super::state::PluginsState;
use super::summary::read_manifest;

/// The icon the manifest in `dir` names, as a `data:image/png` or `data:image/svg+xml` base64 URL.
pub fn icon_data_url(dir: &Path) -> Option<String> {
    let rel = read_manifest(dir)?.icon?;
    check_icon(dir, &rel).ok()?;
    let mut bytes = Vec::new();
    fs::File::open(dir.join(&rel))
        .ok()?
        .take(MAX_ICON_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    // The file can change between the check and the read; the cap holds either way.
    if bytes.len() as u64 > MAX_ICON_BYTES {
        return None;
    }
    let mime = if rel.to_ascii_lowercase().ends_with(".png") {
        "image/png"
    } else {
        "image/svg+xml"
    };
    Some(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

/// The icon of an installed plugin. An id that is not valid is `None`, so it never becomes a path.
pub fn installed_icon(app_data: &Path, id: &str) -> Option<String> {
    validate_id(id).ok()?;
    icon_data_url(&plugin_dir(app_data, id))
}

/// The icon of a staged plugin. Only looks the token up: it is neither claimed nor consumed, so an
/// install or discard of the same token is unaffected.
pub fn staged_icon(plugins: &PluginsState, token: &str) -> Option<String> {
    icon_data_url(&plugins.staged(token)?.dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::install::{discard, install};
    use crate::plugins::test_kit::{ui, Kit, ID};
    use serde_json::json;

    const SVG: &[u8] = br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"></svg>"#;

    fn png(side: u32) -> Vec<u8> {
        let mut b = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        b.extend_from_slice(&13u32.to_be_bytes());
        b.extend_from_slice(b"IHDR");
        b.extend_from_slice(&side.to_be_bytes());
        b.extend_from_slice(&side.to_be_bytes());
        b.extend_from_slice(&[8, 6, 0, 0, 0]);
        b
    }

    fn with_icon(name: &str) -> serde_json::Value {
        let mut manifest = ui("1.0.0", &[]);
        manifest["icon"] = json!(name);
        manifest
    }

    fn decode(url: &str, prefix: &str) -> Vec<u8> {
        let body = url.strip_prefix(prefix).expect(url);
        STANDARD.decode(body).unwrap()
    }

    #[test]
    fn a_png_icon_is_a_png_data_url() {
        let k = Kit::new();
        let bytes = png(64);
        let src = k.source(&with_icon("icon.png"), &[("icon.png", &bytes)]);
        let token = k.inspect_path(&src).token;
        let staged = k.plugins.staged(&token).unwrap();
        let url = icon_data_url(&staged.dir).unwrap();
        assert_eq!(decode(&url, "data:image/png;base64,"), bytes);
    }

    #[test]
    fn an_svg_icon_is_an_svg_data_url() {
        let k = Kit::new();
        let src = k.source(&with_icon("icon.svg"), &[("icon.svg", SVG)]);
        let token = k.inspect_path(&src).token;
        install(&k.data, &k.plugins, &token, 10).unwrap();
        let url = icon_data_url(&plugin_dir(&k.data, ID)).unwrap();
        assert_eq!(decode(&url, "data:image/svg+xml;base64,"), SVG);
    }

    #[test]
    fn no_icon_declared_is_none() {
        let k = Kit::new();
        k.install(&ui("1.0.0", &[]));
        assert_eq!(icon_data_url(&plugin_dir(&k.data, ID)), None);
    }

    #[test]
    fn a_missing_oversized_or_invalid_file_is_none() {
        let k = Kit::new();
        let src = k.source(&with_icon("icon.png"), &[("icon.png", &png(64))]);
        let token = k.inspect_path(&src).token;
        install(&k.data, &k.plugins, &token, 10).unwrap();
        let dir = plugin_dir(&k.data, ID);
        assert!(icon_data_url(&dir).is_some());

        let file = dir.join("icon.png");
        let mut big = png(64);
        big.resize(MAX_ICON_BYTES as usize + 1, 0);
        fs::write(&file, &big).unwrap();
        assert_eq!(icon_data_url(&dir), None);
        fs::write(&file, b"not a png at all, just text bytes here").unwrap();
        assert_eq!(icon_data_url(&dir), None);
        fs::write(&file, png(32)).unwrap();
        assert_eq!(icon_data_url(&dir), None);
        fs::remove_file(&file).unwrap();
        assert_eq!(icon_data_url(&dir), None);
    }

    #[test]
    fn an_invalid_id_or_unknown_token_is_none() {
        let k = Kit::new();
        let src = k.source(&with_icon("icon.svg"), &[("icon.svg", SVG)]);
        let token = k.inspect_path(&src).token;
        install(&k.data, &k.plugins, &token, 10).unwrap();
        assert!(installed_icon(&k.data, ID).is_some());
        for id in [
            "",
            "..",
            "../plugins/com.example.demo",
            "COM.Example.Demo",
            "nope",
        ] {
            assert_eq!(installed_icon(&k.data, id), None, "{id:?}");
        }
        assert_eq!(installed_icon(&k.data, "com.example.other"), None);
        assert_eq!(staged_icon(&k.plugins, "no-such-token"), None);
        // An installed plugin's token is gone from the staged table.
        assert_eq!(staged_icon(&k.plugins, &token), None);
    }

    #[test]
    fn a_vanished_folder_is_none() {
        let k = Kit::new();
        let src = k.source(&with_icon("icon.svg"), &[("icon.svg", SVG)]);
        let token = k.inspect_path(&src).token;
        let dir = k.plugins.staged(&token).unwrap().dir;
        discard(&k.plugins, &token);
        assert_eq!(icon_data_url(&dir), None);
    }

    #[test]
    fn reading_a_staged_icon_leaves_the_token_installable() {
        let k = Kit::new();
        let src = k.source(&with_icon("icon.svg"), &[("icon.svg", SVG)]);
        let token = k.inspect_path(&src).token;
        for _ in 0..2 {
            assert!(staged_icon(&k.plugins, &token).is_some());
        }
        let row = install(&k.data, &k.plugins, &token, 10).unwrap();
        assert_eq!(row.entry.id, ID);
        assert!(plugin_dir(&k.data, ID).join("icon.svg").is_file());
    }
}
