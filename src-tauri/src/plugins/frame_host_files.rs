/*
 * The files the frame host serves itself under `/_plisto/`: the app's token sheet and a base sheet
 * for plugin pages, and on the visualizer host only, the visualizer runtime and the page that runs
 * a shader kind. All are compiled into the binary. The match is exact on the raw request path, so
 * no encoding of it reaches a file, and a plugin folder can never supply one: `resolve` refuses the
 * segment for plugin files.
 */

pub struct HostFile {
    pub mime: &'static str,
    pub body: &'static [u8],
}

const CSS: &str = "text/css; charset=utf-8";
const JS: &str = "text/javascript; charset=utf-8";
const HTML: &str = "text/html; charset=utf-8";
const TOKENS: &str = include_str!("../../../src/styles/tokens.css");
const PLUGIN_BASE: &str = include_str!("../../../src/styles/plugin-base.css");

// TODO: both are placeholders; each becomes an `include_str!` of its file in
// `plugin-kit/visualizers/runtime/` once the runtime bundle is built.
pub const VIS_RUNTIME: &str = "\"use strict\";\n";
pub const VIS_SHADER_PAGE: &str =
    "<!doctype html>\n<meta charset=\"utf-8\">\n<script src=\"plisto-vis.js\"></script>\n";

/// The host file at `raw_path`, still percent-encoded; None for any other path.
pub fn host_file(raw_path: &str) -> Option<HostFile> {
    let body = match raw_path {
        "/_plisto/tokens.css" => TOKENS,
        "/_plisto/plugin-base.css" => PLUGIN_BASE,
        _ => return None,
    };
    Some(HostFile {
        mime: CSS,
        body: body.as_bytes(),
    })
}

/// The visualizer host's own file at `raw_path`: the runtime, the shader page, or any page host
/// file. None for any other path.
pub fn vis_host_file(raw_path: &str) -> Option<HostFile> {
    let (mime, body) = match raw_path {
        "/_plisto/vis/1/plisto-vis.js" => (JS, VIS_RUNTIME),
        "/_plisto/vis/1/shader.html" => (HTML, VIS_SHADER_PAGE),
        _ => return host_file(raw_path),
    };
    Some(HostFile {
        mime,
        body: body.as_bytes(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::frame_host::{frame_url, respond, ResourceKind, FRAME_CSP};
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tauri::http::{header, Response, StatusCode};

    const ID: &str = "com.example.demo";

    /// A throwaway app data dir with one installed plugin that ships its own `_plisto` folder.
    struct AppData(PathBuf);

    impl AppData {
        fn new() -> AppData {
            static N: AtomicUsize = AtomicUsize::new(0);
            let d = AppData(std::env::temp_dir().join(format!(
                "plisto-frame-host-files-test-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            )));
            let shadow = d.0.join("plugins").join(ID).join("_plisto");
            fs::create_dir_all(&shadow).unwrap();
            fs::write(shadow.join("tokens.css"), "shadow").unwrap();
            fs::write(shadow.join("other.css"), "shadow").unwrap();
            d
        }

        fn get(&self, path: &str, enabled: bool) -> Response<Vec<u8>> {
            let uri = format!("{}{path}", frame_url(ID).trim_end_matches('/'));
            let serves = move |id: &str| enabled && id == ID;
            respond(
                &self.0,
                "GET",
                &uri,
                None,
                None,
                ResourceKind::Subresource,
                &serves,
            )
        }
    }

    impl Drop for AppData {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn both_sheets_are_served_with_the_frame_headers() {
        let d = AppData::new();
        for (path, body) in [
            ("/_plisto/tokens.css", TOKENS),
            ("/_plisto/plugin-base.css", PLUGIN_BASE),
        ] {
            let res = d.get(path, true);
            assert_eq!(res.status(), StatusCode::OK, "{path}");
            assert_eq!(res.body().as_slice(), body.as_bytes(), "{path}");
            let h = res.headers();
            assert_eq!(h[header::CONTENT_TYPE], "text/css; charset=utf-8");
            assert_eq!(h[header::CONTENT_SECURITY_POLICY], FRAME_CSP);
            assert_eq!(h[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
            assert_eq!(h[header::CACHE_CONTROL], "no-store");
            assert_eq!(h[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
        }
    }

    #[test]
    fn the_tokens_body_is_the_apps_token_sheet() {
        let file = host_file("/_plisto/tokens.css").unwrap();
        assert_eq!(
            file.body,
            include_str!("../../../src/styles/tokens.css").as_bytes()
        );
        assert!(!file.body.is_empty());
    }

    #[test]
    fn any_other_host_path_is_not_found() {
        let d = AppData::new();
        for path in [
            "/_plisto/other.css",
            "/_plisto/",
            "/_plisto",
            "/_plisto/Tokens.css",
            "/_plisto/tokens.css/",
            "/_plisto/%74okens.css",
            "/_plisto//tokens.css",
            "/ui/../_plisto/tokens.css",
        ] {
            assert!(host_file(path).is_none(), "{path}");
            assert_eq!(d.get(path, true).status(), StatusCode::NOT_FOUND, "{path}");
        }
    }

    #[test]
    fn a_host_file_for_a_disabled_plugin_is_not_found() {
        let d = AppData::new();
        for path in ["/_plisto/tokens.css", "/_plisto/plugin-base.css"] {
            let res = d.get(path, false);
            assert_eq!(res.status(), StatusCode::NOT_FOUND, "{path}");
            assert!(res.body().is_empty());
            assert_eq!(res.headers()[header::CONTENT_SECURITY_POLICY], FRAME_CSP);
        }
    }

    #[test]
    fn the_sheets_load_nothing_the_frame_csp_blocks() {
        for (name, body) in [("tokens.css", TOKENS), ("plugin-base.css", PLUGIN_BASE)] {
            assert!(!body.contains("url("), "{name} holds url(");
            assert!(!body.contains("@import"), "{name} holds @import");
        }
        assert!(!PLUGIN_BASE.contains("color-scheme"));
    }
}
