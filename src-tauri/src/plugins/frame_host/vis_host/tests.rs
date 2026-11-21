// The visualizer host against a throwaway app data folder: URL shape, its policy against the frame
// policy, its own files, the shared request rules, and the URL of each declared kind.

// -- Library Imports --
use std::fs;

use tauri::http::{header, Response, StatusCode};

// -- Local Imports --
use super::*;
use crate::plugins::frame_host::{
    frame_url, host_for_id, parse_frame_url, respond, ResourceKind, FILTER, FRAME_CSP,
};
use crate::plugins::frame_host_files::{VIS_RUNTIME, VIS_SHADER_PAGE};
use crate::plugins::stage::Temp;

const ID: &str = "com.example.vis";
const APP_REFERER: &str = "http://tauri.localhost/index.html";
const MANIFEST: &str = r#"{"manifest_version": 1, "id": "com.example.vis", "name": "Vis",
    "version": "1.0.0", "tier": "ui", "capabilities": ["visualizer"], "min_plisto": "1.0.0",
    "author": "A", "visualizers": [
        {"id": "rings", "name": "Rings", "api": 1, "page": "vis/rings.html", "look": "glow"},
        {"id": "level", "name": "Level", "api": 1, "shader": "vis/level.frag", "look": "glow"}
    ]}"#;

/// A throwaway app data dir with one installed visualizer plugin.
fn app_data() -> Temp {
    let d = Temp::new("vis-host");
    let dir = d.0.join("plugins").join(ID);
    fs::create_dir_all(dir.join("vis")).unwrap();
    fs::write(dir.join("plugin.json"), MANIFEST).unwrap();
    fs::write(dir.join("vis/rings.html"), "<p>rings</p>").unwrap();
    fs::write(dir.join("vis/level.frag"), "void main() {}").unwrap();
    fs::write(dir.join("vis/lib.wasm"), "\0asm").unwrap();
    d
}

fn vis(path: &str) -> String {
    format!("{}{path}", vis_url(ID).trim_end_matches('/'))
}

fn only_vis(id: &str) -> bool {
    id == ID
}

fn get(d: &Temp, uri: &str, referer: Option<&str>, kind: ResourceKind) -> Response<Vec<u8>> {
    respond(&d.0, "GET", uri, referer, None, kind, &only_vis)
}

fn sub(d: &Temp, uri: &str) -> Response<Vec<u8>> {
    get(d, uri, None, ResourceKind::Subresource)
}

/// Whether `text` matches a WebView2-style filter pattern, where `*` stands for any run of
/// characters.
fn wildcard(pattern: &str, text: &str) -> bool {
    match pattern.split_once('*') {
        None => pattern == text,
        Some((head, rest)) => text.strip_prefix(head).is_some_and(|tail| {
            (0..=tail.len()).any(|i| tail.is_char_boundary(i) && wildcard(rest, &tail[i..]))
        }),
    }
}

// ---- URL shape ----

#[test]
fn the_label_is_the_page_hash_under_its_own_prefix() {
    let page = host_for_id(ID);
    let uri = vis("/a.js");
    let (label, path) = parse_vis_url(&uri).unwrap();
    assert_eq!(path, "/a.js");
    assert_eq!(label.strip_prefix("pv-"), page.strip_prefix("pp-"));
    assert_ne!(vis_url(ID), frame_url(ID));
}

#[test]
fn the_page_and_visualizer_hosts_never_claim_the_same_url() {
    let page = format!("{}index.html", frame_url(ID));
    let visual = vis("/index.html");
    assert!(parse_vis_url(&page).is_none());
    assert!(parse_frame_url(&visual).is_none());
    assert!(wildcard(VIS_FILTER, &visual) && !wildcard(FILTER, &visual));
    assert!(wildcard(FILTER, &page) && !wildcard(VIS_FILTER, &page));
}

#[test]
fn malformed_visualizer_urls_do_not_parse() {
    let label = vis_url(ID)
        .trim_start_matches("https://")
        .trim_end_matches(".invalid/")
        .to_string();
    for uri in [
        format!("http://{label}.invalid/a.js"),
        format!("https://{label}.invalid:443/a.js"),
        format!("https://user@{label}.invalid/a.js"),
        format!("https://{}.invalid/a.js", label.to_ascii_uppercase()),
        format!("https://{label}0.invalid/a.js"),
        format!("https://a.{label}.invalid/a.js"),
        format!("https://{label}.invalid"),
        "https://pv-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz.invalid/a.js".to_string(),
    ] {
        assert_eq!(parse_vis_url(&uri), None, "{uri:?}");
    }
}

// ---- Policy ----

#[test]
fn the_policy_is_the_frame_policy_plus_wasm_and_blob_workers() {
    let built = format!(
        "{}; worker-src blob:",
        FRAME_CSP.replace("script-src 'self'", "script-src 'self' 'wasm-unsafe-eval'")
    );
    assert_eq!(VIS_CSP, built);
    assert!(VIS_CSP.starts_with("sandbox allow-scripts;"));
}

#[test]
fn every_visualizer_response_carries_the_visualizer_headers() {
    let d = app_data();
    let page = vis("/vis/rings.html");
    for res in [
        get(&d, &page, Some(APP_REFERER), ResourceKind::Document),
        get(&d, &page, None, ResourceKind::Document),
        sub(&d, &vis("/missing.js")),
        respond(
            &d.0,
            "POST",
            &page,
            Some(APP_REFERER),
            None,
            ResourceKind::Document,
            &only_vis,
        ),
    ] {
        let h = res.headers();
        assert_eq!(h[header::CONTENT_SECURITY_POLICY], VIS_CSP);
        assert_eq!(h[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
        assert_eq!(h[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
    }
}

// ---- Files and request rules ----

#[test]
fn the_runtime_and_shader_page_are_served() {
    assert!(VIS_RUNTIME.starts_with("var plistoVis = "));
    assert!(VIS_SHADER_PAGE.contains("<script src=\"plisto-vis.js\"></script>"));
    let d = app_data();
    for (path, mime, body) in [
        (
            "/_plisto/vis/1/plisto-vis.js",
            "text/javascript; charset=utf-8",
            VIS_RUNTIME,
        ),
        (
            "/_plisto/vis/1/shader.html",
            "text/html; charset=utf-8",
            VIS_SHADER_PAGE,
        ),
    ] {
        let res = sub(&d, &vis(path));
        assert_eq!(res.status(), StatusCode::OK, "{path}");
        assert_eq!(res.headers()[header::CONTENT_TYPE], mime, "{path}");
        assert_eq!(res.body().as_slice(), body.as_bytes(), "{path}");
    }
    assert_eq!(
        sub(&d, &vis("/_plisto/tokens.css")).status(),
        StatusCode::OK
    );
    for path in ["/_plisto/vis/1/other.js", "/_plisto/vis/2/plisto-vis.js"] {
        assert_eq!(sub(&d, &vis(path)).status(), StatusCode::NOT_FOUND, "{path}");
    }
}

#[test]
fn plugin_files_follow_the_page_host_rules() {
    let d = app_data();
    let own = vis("/vis/rings.html");
    let page_doc = format!("{}index.html", frame_url(ID));
    let doc = |referer| get(&d, &own, referer, ResourceKind::Document);
    assert_eq!(doc(Some(APP_REFERER)).status(), StatusCode::OK);
    assert_eq!(doc(None).status(), StatusCode::FORBIDDEN);
    assert_eq!(doc(Some(page_doc.as_str())).status(), StatusCode::FORBIDDEN);

    let wasm = vis("/vis/lib.wasm");
    let res = get(&d, &wasm, Some(&own), ResourceKind::Subresource);
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers()[header::CONTENT_TYPE], "application/wasm");
    // The plugin's own page host is another site to its visualizer host.
    let from_page = get(&d, &wasm, Some(&page_doc), ResourceKind::Subresource);
    assert_eq!(from_page.status(), StatusCode::FORBIDDEN);
    for path in ["/plugin.json/x", "/../plugin.json", "/vis/missing.html"] {
        assert_eq!(sub(&d, &vis(path)).status(), StatusCode::NOT_FOUND, "{path}");
    }
}

#[test]
fn a_disabled_plugin_is_not_served_on_its_visualizer_host() {
    let d = app_data();
    for path in ["/vis/rings.html", "/_plisto/vis/1/plisto-vis.js"] {
        let res = respond(
            &d.0,
            "GET",
            &vis(path),
            None,
            None,
            ResourceKind::Subresource,
            &|_: &str| false,
        );
        assert_eq!(res.status(), StatusCode::NOT_FOUND, "{path}");
        assert!(res.body().is_empty());
    }
}

// ---- Kind URLs ----

#[test]
fn each_declared_kind_has_a_served_url() {
    let d = app_data();
    let page = kind_url(&d.0, ID, "rings", &only_vis).unwrap();
    assert_eq!(page, vis("/vis/rings.html"));
    let shader = kind_url(&d.0, ID, "level", &only_vis).unwrap();
    assert_eq!(
        shader,
        vis("/_plisto/vis/1/shader.html?shader=vis/level.frag")
    );
    for url in [&page, &shader] {
        let res = get(&d, url, Some(APP_REFERER), ResourceKind::Document);
        assert_eq!(res.status(), StatusCode::OK, "{url}");
    }
}

#[test]
fn an_unknown_plugin_or_kind_has_no_url() {
    let d = app_data();
    let none = |_: &str| false;
    let all = |_: &str| true;
    assert_eq!(
        kind_url(&d.0, ID, "missing", &only_vis),
        Err(KindUrlError::UnknownKind)
    );
    assert_eq!(
        kind_url(&d.0, ID, "rings", &none),
        Err(KindUrlError::UnknownPlugin)
    );
    for id in ["com.example.missing", "../plugins", "Com.Example.Vis", ""] {
        assert_eq!(
            kind_url(&d.0, id, "rings", &all),
            Err(KindUrlError::UnknownPlugin),
            "{id:?}"
        );
    }
}
