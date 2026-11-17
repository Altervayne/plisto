/*
 * The probe host against a throwaway fixtures folder: URL shape, the header policies, the document
 * and Referer rules, the name rule, the generated image and the request log. Also pins the plugin
 * frame host's own literals, so the probe host cannot drift them.
 */

// -- Library Imports --
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

// -- Local Imports --
use super::*;
use crate::plugins::frame_host::{frame_url, parse_frame_url, FILTER, MAX_SERVED_BYTES};

const APP_REFERER: &str = "http://tauri.localhost/index.html";

/// A throwaway fixtures folder holding one file of each kind the tests ask for.
struct Fixtures(PathBuf);

impl Fixtures {
    fn new() -> Fixtures {
        static N: AtomicUsize = AtomicUsize::new(0);
        let d = Fixtures(std::env::temp_dir().join(format!(
            "plisto-probe-host-test-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        )));
        fs::create_dir_all(d.0.join("dir.js")).unwrap();
        fs::create_dir_all(d.0.join("sub")).unwrap();
        for (name, body) in [
            ("page.html", "<p>hi</p>"),
            ("app.js", "1"),
            ("mod.mjs", "export {}"),
            ("code.wasm", "\0asm"),
            ("app.exe", "MZ"),
            ("upper.JS", "1"),
            ("sub/inner.js", "1"),
        ] {
            fs::write(d.0.join(name), body).unwrap();
        }
        d
    }

    fn request(
        &self,
        host: &str,
        path: &str,
        referer: Option<&str>,
        kind: ResourceKind,
    ) -> Response<Vec<u8>> {
        let uri = url(host, path);
        respond_in(&self.0, "GET", &uri, referer, None, kind)
    }

    fn get(&self, host: &str, path: &str) -> Response<Vec<u8>> {
        self.request(host, path, None, ResourceKind::Subresource)
    }
}

impl Drop for Fixtures {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn url(host: &str, path: &str) -> String {
    format!("https://{host}.invalid{path}")
}

fn hosts() -> impl Iterator<Item = (&'static str, Policy)> {
    HOSTS.iter().copied()
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

fn directives(csp: &str) -> Vec<String> {
    csp.split(';').map(|d| d.trim().to_string()).collect()
}

// ---- Release literals ----

#[test]
fn the_plugin_frame_host_literals_are_unchanged() {
    assert_eq!(FILTER, "https://pp-*.invalid/*");
    assert_eq!(
        FRAME_CSP,
        "sandbox allow-scripts; default-src 'none'; script-src 'self'; style-src 'self' \
         'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'none'"
    );
    let extensions: Vec<&str> = MIME_TYPES.iter().map(|(ext, _)| *ext).collect();
    assert_eq!(
        extensions,
        [
            "html", "js", "css", "json", "txt", "png", "jpg", "jpeg", "gif", "webp", "svg", "ico",
            "woff", "woff2", "ttf", "otf"
        ]
    );
}

// ---- URL shape ----

#[test]
fn the_two_hosts_never_claim_the_same_url() {
    let plugin = format!("{}index.html", frame_url("com.example.demo"));
    assert!(parse_frame_url(&plugin).is_some());
    assert!(parse_probe_url(&plugin).is_none());
    assert!(wildcard(FILTER, &plugin));
    assert!(!wildcard(PROBE_FILTER, &plugin));
    for (host, _) in hosts() {
        let probe = url(host, "/page.html");
        assert!(parse_probe_url(&probe).is_some(), "{probe}");
        assert!(parse_frame_url(&probe).is_none(), "{probe}");
        assert!(wildcard(PROBE_FILTER, &probe), "{probe}");
        assert!(!wildcard(FILTER, &probe), "{probe}");
    }
}

#[test]
fn only_the_fixed_hosts_parse() {
    assert_eq!(
        parse_probe_url("https://probe-vis.invalid/a.js?x=1#y"),
        Some((Policy::Visualizer, "probe-vis", "/a.js"))
    );
    assert_eq!(
        parse_probe_url("https://probe-ui0s.invalid/"),
        Some((Policy::ReleasedSelfConnect, "probe-ui0s", "/"))
    );
    for uri in [
        "http://probe-vis.invalid/a.js",
        "https://probe-vis.invalid:443/a.js",
        "https://user@probe-vis.invalid/a.js",
        "https://probe-vis3.invalid/a.js",
        "https://probe-.invalid/a.js",
        "https://PROBE-VIS.invalid/a.js",
        "https://probe-vis.invalid",
        "https://probe-vis.example/a.js",
        "https://x.probe-vis.invalid/a.js",
    ] {
        assert!(parse_probe_url(uri).is_none(), "{uri}");
    }
}

// ---- Policies ----

#[test]
fn the_released_host_carries_the_frame_csp_byte_for_byte() {
    assert_eq!(Policy::Released.csp(), FRAME_CSP);
    let f = Fixtures::new();
    let res = f.get("probe-ui0", "/app.js");
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers()[header::CONTENT_SECURITY_POLICY], FRAME_CSP);
}

#[test]
fn the_self_connect_host_differs_from_released_in_connect_src_only() {
    let released = directives(&Policy::Released.csp());
    let next = directives(&Policy::ReleasedSelfConnect.csp());
    assert_eq!(released.len(), next.len());
    let changed: Vec<(&String, &String)> =
        released.iter().zip(&next).filter(|(a, b)| a != b).collect();
    assert_eq!(
        changed,
        [(
            &"connect-src 'none'".to_string(),
            &"connect-src 'self'".to_string()
        )]
    );
    assert_eq!(Policy::UiAdditions.csp(), Policy::ReleasedSelfConnect.csp());
}

#[test]
fn the_visualizer_host_adds_wasm_and_blob_workers() {
    let vis = directives(&Policy::Visualizer.csp());
    assert!(vis.contains(&"script-src 'self' 'wasm-unsafe-eval'".to_string()));
    assert!(vis.contains(&"worker-src blob:".to_string()));
    assert!(vis.contains(&"connect-src 'self'".to_string()));
    assert!(vis.contains(&"sandbox allow-scripts".to_string()));
    assert_eq!(vis.len(), directives(FRAME_CSP).len() + 1);
}

#[test]
fn every_response_carries_its_policy_headers() {
    let f = Fixtures::new();
    for (host, policy) in hosts() {
        let cases = [
            f.get(host, "/app.js"),
            f.get(host, "/missing.js"),
            f.request(host, "/page.html", None, ResourceKind::Document),
            respond_in(
                &f.0,
                "POST",
                &url(host, "/app.js"),
                None,
                None,
                ResourceKind::Subresource,
            ),
        ];
        for res in cases {
            let h = res.headers();
            assert_eq!(
                h[header::CONTENT_SECURITY_POLICY],
                policy.csp().as_str(),
                "{host}"
            );
            assert_eq!(h[header::X_CONTENT_TYPE_OPTIONS], "nosniff", "{host}");
            assert_eq!(h[header::CACHE_CONTROL], "no-store", "{host}");
            assert_eq!(
                h[PERMISSIONS_POLICY],
                permissions_policy().as_str(),
                "{host}"
            );
            match policy {
                Policy::Released | Policy::ReleasedSelfConnect => {
                    assert!(
                        !h.contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN),
                        "{host}"
                    )
                }
                Policy::UiAdditions | Policy::Visualizer => {
                    assert_eq!(h[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*", "{host}")
                }
            }
        }
    }
}

#[test]
fn the_extended_types_are_served_only_by_the_extended_hosts() {
    let f = Fixtures::new();
    for host in ["probe-ui0", "probe-ui0s"] {
        assert_eq!(
            f.get(host, "/code.wasm").status(),
            StatusCode::NOT_FOUND,
            "{host}"
        );
        assert_eq!(
            f.get(host, "/mod.mjs").status(),
            StatusCode::NOT_FOUND,
            "{host}"
        );
    }
    for host in ["probe-ui1", "probe-vis", "probe-vis2"] {
        let res = f.get(host, "/code.wasm");
        assert_eq!(res.status(), StatusCode::OK, "{host}");
        assert_eq!(
            res.headers()[header::CONTENT_TYPE],
            "application/wasm",
            "{host}"
        );
        let res = f.get(host, "/mod.mjs");
        assert_eq!(
            res.headers()[header::CONTENT_TYPE],
            "text/javascript; charset=utf-8",
            "{host}"
        );
    }
    for (ext, _) in EXTENDED_MIME_TYPES {
        assert!(Policy::Released.mime_for(ext).is_none(), "{ext}");
        assert!(Policy::ReleasedSelfConnect.mime_for(ext).is_none(), "{ext}");
        assert!(Policy::UiAdditions.mime_for(ext).is_some(), "{ext}");
        assert!(Policy::Visualizer.mime_for(ext).is_some(), "{ext}");
    }
}

// ---- Document and Referer rules ----

#[test]
fn a_document_needs_the_app_referer() {
    let f = Fixtures::new();
    for (host, _) in hosts() {
        let doc = |referer| f.request(host, "/page.html", referer, ResourceKind::Document);
        assert_eq!(doc(None).status(), StatusCode::FORBIDDEN, "{host}");
        assert_eq!(
            doc(Some("https://example.com/")).status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            doc(Some("https://probe-ui0.invalid/x.html")).status(),
            StatusCode::FORBIDDEN
        );
        let res = doc(Some(APP_REFERER));
        assert_eq!(res.status(), StatusCode::OK, "{host}");
        assert_eq!(
            res.headers()[header::CONTENT_TYPE],
            "text/html; charset=utf-8"
        );
        assert_eq!(res.body().as_slice(), b"<p>hi</p>");
    }
}

#[test]
fn a_subresource_refuses_a_foreign_referer() {
    let f = Fixtures::new();
    let sub = |host, referer| f.request(host, "/app.js", referer, ResourceKind::Subresource);
    assert_eq!(sub("probe-vis", None).status(), StatusCode::OK);
    assert_eq!(
        sub("probe-vis", Some("https://probe-vis.invalid/page.html")).status(),
        StatusCode::OK
    );
    for referer in [
        "https://probe-vis2.invalid/page.html",
        "https://example.com/",
        APP_REFERER,
        "not a url",
    ] {
        assert_eq!(
            sub("probe-vis", Some(referer)).status(),
            StatusCode::FORBIDDEN,
            "{referer}"
        );
    }
}

#[test]
fn a_disagreeing_fetch_dest_is_refused() {
    let f = Fixtures::new();
    let uri = url("probe-vis", "/page.html");
    let res = respond_in(
        &f.0,
        "GET",
        &uri,
        Some(APP_REFERER),
        Some("script"),
        ResourceKind::Document,
    );
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
}

#[test]
fn only_get_is_served() {
    let f = Fixtures::new();
    for method in ["POST", "PUT", "HEAD", "get"] {
        let res = respond_in(
            &f.0,
            method,
            &url("probe-vis", "/app.js"),
            None,
            None,
            ResourceKind::Subresource,
        );
        assert_eq!(res.status(), StatusCode::METHOD_NOT_ALLOWED, "{method}");
    }
}

// ---- Name rule ----

#[test]
fn anything_but_a_flat_lowercase_fixture_is_not_found() {
    let f = Fixtures::new();
    assert_eq!(f.get("probe-vis", "/app.js").status(), StatusCode::OK);
    for path in [
        "/",
        "/app",
        "/.js",
        "/app.",
        "/../app.js",
        "/sub/../app.js",
        "/sub/inner.js",
        "/..\\app.js",
        "/sub\\inner.js",
        "/%2e%2e/app.js",
        "/app%2ejs",
        "/%61pp.js",
        "/app.exe",
        "/app.js.txt",
        "/upper.JS",
        "/App.js",
        "/_plisto/tokens.css",
        "/app_1.js",
        "/dir.js",
        "/missing.js",
        "/gen/other.png",
    ] {
        assert_eq!(
            f.get("probe-vis", path).status(),
            StatusCode::NOT_FOUND,
            "{path}"
        );
    }
}

#[test]
fn device_names_are_recognized() {
    for stem in ["con", "prn", "aux", "nul", "com0", "com9", "lpt1", "lpt9"] {
        assert!(is_device_name(stem), "{stem}");
    }
    for stem in ["cone", "conx", "nul1", "com", "com10", "lpt", "comx", "app"] {
        assert!(!is_device_name(stem), "{stem}");
    }
}

// Windows reserves these names even with an extension, so such a file is created only on other
// systems; on Windows the direct test above stands alone.
#[cfg(not(windows))]
#[test]
fn a_real_file_with_a_device_name_is_not_served() {
    let f = Fixtures::new();
    for name in ["con.js", "com1.js", "cone.js"] {
        fs::write(f.0.join(name), "1").unwrap();
    }
    assert_eq!(f.get("probe-vis", "/cone.js").status(), StatusCode::OK);
    for path in ["/con.js", "/com1.js"] {
        assert_eq!(
            f.get("probe-vis", path).status(),
            StatusCode::NOT_FOUND,
            "{path}"
        );
    }
}

#[test]
fn a_root_that_is_not_a_plain_directory_serves_nothing() {
    let f = Fixtures::new();
    let file_root = f.0.join("app.js");
    let res = respond_in(
        &file_root,
        "GET",
        &url("probe-vis", "/app.js"),
        None,
        None,
        ResourceKind::Subresource,
    );
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

#[test]
fn a_file_over_the_cap_is_not_found() {
    let f = Fixtures::new();
    let big = vec![b'a'; usize::try_from(MAX_SERVED_BYTES).unwrap() + 1];
    fs::write(f.0.join("big.js"), &big).unwrap();
    fs::write(f.0.join("edge.js"), &big[1..]).unwrap();
    assert_eq!(
        f.get("probe-vis", "/big.js").status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(f.get("probe-vis", "/edge.js").status(), StatusCode::OK);
}

// ---- Generated image ----

#[test]
fn the_generated_pattern_decodes_to_its_colors() {
    let f = Fixtures::new();
    for (host, _) in hosts() {
        let res = f.get(host, PATTERN_PATH);
        assert_eq!(res.status(), StatusCode::OK, "{host}");
        assert_eq!(res.headers()[header::CONTENT_TYPE], "image/png");
        let image = image::load_from_memory(res.body()).unwrap().to_rgba8();
        assert_eq!(image.dimensions(), (PATTERN_EDGE, PATTERN_EDGE));
        let last = PATTERN_EDGE - 1;
        let half = PATTERN_EDGE / 2;
        for (i, (x, y)) in [(0, 0), (last, 0), (0, last), (last, last)]
            .into_iter()
            .enumerate()
        {
            assert_eq!(image.get_pixel(x, y).0, PATTERN_COLORS[i], "corner {i}");
        }
        for (i, (x, y)) in [
            (half - 1, half - 1),
            (half, half - 1),
            (half - 1, half),
            (half, half),
        ]
        .into_iter()
        .enumerate()
        {
            assert_eq!(image.get_pixel(x, y).0, PATTERN_COLORS[i], "center {i}");
        }
    }
}

// ---- Request log ----

#[test]
fn the_log_keeps_the_last_lines_only() {
    let mut log = VecDeque::new();
    for n in 0..LOG_CAP + 50 {
        push_line(&mut log, n.to_string());
    }
    assert_eq!(log.len(), LOG_CAP);
    assert_eq!(log.front().map(String::as_str), Some("50"));
    assert_eq!(
        log.back().map(String::as_str),
        Some((LOG_CAP + 49).to_string().as_str())
    );
}

#[test]
fn a_log_line_holds_no_header_value_but_the_origin_class() {
    let uri = url("probe-ui1", "/data.json?token=secret-query");
    let referer = "http://localhost:1420/private/path?q=secret-referer";
    let line = log_line(
        "GET",
        &uri,
        Some(referer),
        Some("https://secret-origin.example"),
        ResourceKind::Subresource,
        StatusCode::FORBIDDEN,
    );
    assert_eq!(
        line,
        "GET probe-ui1 /data.json context=Subresource referer=http://localhost:1420 \
         origin=other -> 403"
    );
    for secret in ["secret", "private"] {
        assert!(!line.contains(secret), "{line}");
    }
    assert_eq!(origin_class(None), "absent");
    assert_eq!(origin_class(Some("null")), "null");
    assert_eq!(origin_class(Some("http://tauri.localhost")), "other");
}

#[test]
fn a_log_line_clips_a_long_path_and_referer() {
    let long = "a".repeat(LOG_FIELD_CHARS * 3);
    let uri = url("probe-vis", &format!("/{long}"));
    let referer = format!("https://{long}.example/x");
    let line = log_line(
        "GET",
        &uri,
        Some(&referer),
        None,
        ResourceKind::Subresource,
        StatusCode::NOT_FOUND,
    );
    let fields: Vec<&str> = line.split(' ').collect();
    assert_eq!(fields[2].chars().count(), LOG_FIELD_CHARS);
    assert_eq!(
        fields[4].trim_start_matches("referer=").chars().count(),
        LOG_FIELD_CHARS
    );
    assert!(line.len() < LOG_FIELD_CHARS * 3);
}

#[test]
fn respond_records_each_request() {
    let uri = url("probe-ui0", "/log-marker-request.js");
    let res = respond("POST", &uri, None, None, ResourceKind::Subresource, None);
    assert_eq!(res.status(), StatusCode::METHOD_NOT_ALLOWED);
    let want = "POST probe-ui0 /log-marker-request.js context=Subresource referer=absent \
                origin=absent -> 405";
    assert!(log_lines().iter().any(|line| line == want));
}
