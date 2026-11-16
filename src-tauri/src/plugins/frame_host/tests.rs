// The frame resolver and its responses against a throwaway app data folder: URL shape, path escapes,
// links, the size cap and the headers.

// -- Library Imports --
use std::sync::atomic::{AtomicUsize, Ordering};

// -- Local Imports --
use super::*;

const ID: &str = "com.example.demo";

/// A throwaway app data dir holding one installed plugin and a few files outside it that a
/// broken resolver would reach.
struct AppData(PathBuf);

impl AppData {
    fn new() -> AppData {
        static N: AtomicUsize = AtomicUsize::new(0);
        let p = std::env::temp_dir().join(format!(
            "plisto-frame-host-test-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let d = AppData(p);
        d.write("plisto.sqlite", b"db");
        d.write("secret.js", b"outside");
        d.write("plugins/secret.js", b"outside");
        d.write(&format!("plugins/{ID}/index.html"), b"<p>hi</p>");
        d.write(&format!("plugins/{ID}/ui/app.js"), b"1");
        d
    }

    fn write(&self, rel: &str, bytes: &[u8]) {
        let p = self.0.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, bytes).unwrap();
    }

    fn plugin(&self) -> PathBuf {
        self.0.join("plugins").join(ID)
    }

    fn resolves(&self, request_path: &str) -> bool {
        resolve(&self.0, ID, request_path).is_some()
    }

    fn resolves_for(&self, id: &str, request_path: &str) -> bool {
        resolve(&self.0, id, request_path).is_some()
    }
}

impl Drop for AppData {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// A directory junction on Windows (no privilege needed), a symlink elsewhere. False when the OS
/// refuses, so the caller can skip.
fn link_dir(link: &Path, target: &Path) -> bool {
    #[cfg(windows)]
    {
        std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .is_ok_and(|o| o.status.success())
            && link.exists()
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link).is_ok()
    }
}

fn url(id: &str, path: &str) -> String {
    format!("{}{path}", frame_url(id).trim_end_matches('/'))
}

fn origin(id: &str) -> String {
    frame_url(id).trim_end_matches('/').to_string()
}

// ---- Host form ----

#[test]
fn host_labels_are_hashed_lowercase_hex() {
    for id in [ID, "a.b", "a.b-c", "a-b.c", "io.plisto.demo-1"] {
        let label = host_for_id(id);
        assert!(is_label(&label), "{label}");
        assert_eq!(label.len(), LABEL_PREFIX.len() + HASH_HEX_LEN);
        assert_eq!(label, label.to_ascii_lowercase());
        assert!(!label.ends_with(".localhost"));
        for reserved in ["ipc.", "asset.", "tauri.", "plistoplugin."] {
            assert!(!label.starts_with(reserved), "{label}");
        }
        assert_eq!(frame_url(id), format!("https://{label}.invalid/"));
    }
    assert_ne!(host_for_id("a.b-c"), host_for_id("a-b.c"));
    assert_eq!(host_for_id(ID), host_for_id(ID));
}

#[test]
fn frame_urls_parse_back_to_their_label() {
    let label = host_for_id(ID);
    let base = frame_url(ID);
    assert_eq!(parse_frame_url(&base), Some((label.as_str(), "/")));
    assert_eq!(
        parse_frame_url(&format!("{base}ui/app.js?x=1#y")),
        Some((label.as_str(), "/ui/app.js"))
    );
    assert_eq!(
        parse_frame_url(&format!("{base}a%2Fb#frag")),
        Some((label.as_str(), "/a%2Fb"))
    );
}

#[test]
fn foreign_and_malformed_urls_do_not_parse() {
    let label = host_for_id(ID);
    let short = &label[..label.len() - 1];
    let upper = label.to_ascii_uppercase().replacen("PP-", "pp-", 1);
    for uri in [
        format!("http://{label}.invalid/index.html"),
        format!("https://{label}.invalid:443/index.html"),
        format!("https://{label}.invalid:8080/index.html"),
        format!("https://user@{label}.invalid/index.html"),
        format!("https://user:pw@{label}.invalid/index.html"),
        format!("https://{upper}.invalid/index.html"),
        format!("https://{short}.invalid/index.html"),
        format!("https://{label}0.invalid/index.html"),
        format!("https://{label}.invalid./index.html"),
        format!("https://{label}.INVALID/index.html"),
        format!("https://{label}.localhost/index.html"),
        format!("http://{label}.localhost/index.html"),
        format!(
            "https://{}.invalid/index.html",
            label.replacen("pp-", "pq-", 1)
        ),
        format!("https://x{label}.invalid/index.html"),
        format!("https://a.{label}.invalid/index.html"),
        format!(
            "https://{}.invalid/index.html",
            label.replacen("pp-", "", 1)
        ),
        format!("https://{label}.invalid"),
        format!("https://{label}.invalid?x=/a"),
        format!("https://{label}.invalid\\index.html"),
        format!("https://{label}.invalid@evil.example/index.html"),
        "https://pp-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz.invalid/index.html".to_string(),
        "http://plistoplugin.localhost/com.example.demo/index.html".to_string(),
        "http://ipc.localhost/app_info".to_string(),
        "http://tauri.localhost/index.html".to_string(),
        String::new(),
    ] {
        assert_eq!(parse_frame_url(&uri), None, "{uri:?}");
    }
}

#[test]
fn labels_map_only_to_valid_installed_folders() {
    let d = AppData::new();
    assert_eq!(id_for_label(&d.0, &host_for_id(ID)).as_deref(), Some(ID));
    assert_eq!(
        id_for_label(&d.0, &host_for_id("com.example.missing")),
        None
    );
    // Folders an id could never name are skipped even when their hash matches.
    for name in ["Com.Example.Demo", "inbox", ".staging", "com_example.x"] {
        d.write(&format!("plugins/{name}/index.html"), b"x");
        assert_eq!(id_for_label(&d.0, &host_for_id(name)), None, "{name}");
    }
    assert_eq!(id_for_label(&d.0.join("nowhere"), &host_for_id(ID)), None);
}

#[test]
fn frame_urls_are_handed_out_only_for_installed_plugins() {
    let d = AppData::new();
    assert_eq!(installed_frame_url(&d.0, ID, &all), Some(frame_url(ID)));
    assert_eq!(installed_frame_url(&d.0, "com.example.missing", &all), None);
    d.write("plugins/Com.Example.Demo/index.html", b"x");
    assert_eq!(installed_frame_url(&d.0, "Com.Example.Demo", &all), None);
    d.write("plugins/com.example.file", b"x");
    assert_eq!(installed_frame_url(&d.0, "com.example.file", &all), None);
    let linked = d.0.join("plugins").join("com.example.linked");
    if link_dir(&linked, &d.plugin()) {
        assert_eq!(installed_frame_url(&d.0, "com.example.linked", &all), None);
    }
}

// ---- Resolver ----

#[test]
fn serves_plain_files_with_their_type() {
    let d = AppData::new();
    let page = resolve(&d.0, ID, "/index.html").unwrap();
    assert_eq!(page.mime, "text/html; charset=utf-8");
    assert_eq!(fs::read(&page.file).unwrap(), b"<p>hi</p>");
    let script = resolve(&d.0, ID, "/ui/app.js").unwrap();
    assert_eq!(script.mime, "text/javascript; charset=utf-8");
    // An escaped ordinary character decodes to the same file.
    assert!(d.resolves("/ui%2Fapp.js"));
    assert!(d.resolves("/index%2ehtml"));
}

#[test]
fn decodes_exactly_once() {
    assert_eq!(percent_decode("/a%2Fb%5c"), Some("/a/b\\".to_string()));
    assert_eq!(percent_decode("%252e"), Some("%2e".to_string()));
    assert_eq!(percent_decode("%2"), None);
    assert_eq!(percent_decode("%zz"), None);
    assert_eq!(percent_decode("%ff"), None);
}

#[test]
fn traversal_variants_refuse() {
    let d = AppData::new();
    for p in [
        "/../plisto.sqlite",
        "/../secret.js",
        "/../../secret.js",
        &format!("/../{ID}/index.html"),
        "/ui/../index.html",
        "/./index.html",
        "//index.html",
        "/ui/",
        "/",
        "index.html",
        "",
    ] {
        assert!(!d.resolves(p), "{p:?}");
    }
}

#[test]
fn encoded_and_double_encoded_traversal_refuses() {
    let d = AppData::new();
    for p in [
        "/..%2F..%2Fplisto.sqlite",
        "/..%2Fsecret.js",
        "/..%2F..%2Fsecret.js",
        "/%2e%2e/secret.js",
        "/%2E%2E%2Fsecret.js",
        "/ui/%2e%2e%2findex.html",
        "/..%5Csecret.js",
        "/ui%5C..%5Cindex.html",
        "/ui\\..\\index.html",
        "/..%252F..%252Fsecret.js",
        "/%252e%252e%252fsecret.js",
        "/ui%252F..%252Findex.html",
    ] {
        assert!(!d.resolves(p), "{p:?}");
    }
}

#[test]
fn absolute_and_drive_paths_refuse() {
    let d = AppData::new();
    let abs = d.0.join("secret.js").to_string_lossy().replace('\\', "/");
    for p in [
        format!("//{abs}"),
        format!("/{abs}"),
        format!("/%2F{abs}"),
        "/C:/Windows/win.ini".to_string(),
        "/C:index.html".to_string(),
        "/C%3A%5Csecret.js".to_string(),
        "/%5C%5Cserver%5Cshare%5Cx.js".to_string(),
        "/%5C%5C%3F%5CC%3A%5Cx.js".to_string(),
    ] {
        assert!(!d.resolves(&p), "{p:?}");
    }
}

#[test]
fn alternate_data_streams_refuse() {
    let d = AppData::new();
    for p in [
        "/index.html:stream",
        "/index.html::$DATA",
        "/index.html%3A%3A%24DATA",
        "/ui:x/app.js",
        "/ui::$INDEX_ALLOCATION/app.js",
    ] {
        assert!(!d.resolves(p), "{p:?}");
    }
}

#[test]
fn reserved_names_and_trailing_dots_refuse() {
    let d = AppData::new();
    for p in [
        "/con.js",
        "/ui/NUL.html",
        "/aux",
        "/com1.css",
        "/Lpt9.png",
        "/index.html.",
        "/index.html%20",
        "/index.html.%20",
        "/ui./app.js",
        "/ui%20/app.js",
    ] {
        assert!(!d.resolves(p), "{p:?}");
    }
}

#[test]
fn the_host_segment_is_reserved() {
    let d = AppData::new();
    d.write(&format!("plugins/{ID}/_plisto/tokens.css"), b"x");
    d.write(&format!("plugins/{ID}/ui/_plisto/tokens.css"), b"x");
    assert!(!d.resolves("/_plisto/tokens.css"));
    assert!(!d.resolves("/%5Fplisto/tokens.css"));
    // Only the first segment is reserved.
    assert!(d.resolves("/ui/_plisto/tokens.css"));
}

#[test]
fn unknown_and_invalid_ids_refuse() {
    let d = AppData::new();
    // Folders an id could never name are planted, so only the id check stops them.
    d.write("plugins/inbox/index.html", b"x");
    d.write("plugins/.staging/index.html", b"x");
    d.write("plugins/Com.Example.Demo/index.html", b"x");
    d.write(&format!("plugins/{ID}.new/index.html"), b"x");
    let staged = format!("{ID}.new");
    for id in [
        "com.example.missing",
        "inbox",
        ".staging",
        "Com.Example.Demo",
        staged.as_str(),
        "com_example.demo",
    ] {
        assert!(!d.resolves_for(id, "/index.html"), "{id:?}");
    }
}

#[test]
fn mime_allow_list() {
    let d = AppData::new();
    for (ext, _) in MIME_TYPES {
        d.write(&format!("plugins/{ID}/f.{ext}"), b"x");
        assert!(d.resolves(&format!("/f.{ext}")), "{ext}");
    }
    d.write(&format!("plugins/{ID}/Upper.HTML"), b"x");
    assert_eq!(
        resolve(&d.0, ID, "/Upper.HTML").unwrap().mime,
        "text/html; charset=utf-8"
    );
    for name in [
        "tool.exe",
        "lib.dll",
        "data.sqlite",
        "mod.mjs",
        "code.wasm",
        "page.htm",
        "page.xhtml",
        "LICENSE",
        "run.bat",
        "x.",
    ] {
        d.write(&format!("plugins/{ID}/{name}"), b"x");
        assert!(!d.resolves(&format!("/{name}")), "{name}");
    }
}

#[test]
fn directories_are_not_files() {
    let d = AppData::new();
    fs::create_dir_all(d.plugin().join("dir.html")).unwrap();
    assert!(!d.resolves("/dir.html"));
    assert!(!d.resolves("/ui"));
}

#[test]
fn links_anywhere_on_the_path_refuse() {
    let d = AppData::new();
    let outside = d.0.join("outside");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("secret.js"), b"outside").unwrap();
    fs::create_dir_all(outside.join("plugin")).unwrap();
    fs::write(outside.join("plugin").join("index.html"), b"x").unwrap();

    let escapes = d.plugin().join("escape");
    let inner = d.plugin().join("inner");
    let whole = d.0.join("plugins").join("com.example.linked");
    if !link_dir(&escapes, &outside) {
        eprintln!("skipped: the OS refused to create a directory link");
        return;
    }
    // A link that stays inside the plugin is still refused: the check is per component, not
    // only a containment test.
    assert!(link_dir(&inner, &d.plugin().join("ui")));
    assert!(link_dir(&whole, &outside.join("plugin")));

    assert!(!d.resolves("/escape/secret.js"));
    assert!(!d.resolves("/inner/app.js"));
    assert!(!d.resolves_for("com.example.linked", "/index.html"));
    // The real file behind the inner link still serves by its own path.
    assert!(d.resolves("/ui/app.js"));
}

#[test]
fn a_linked_plugins_folder_refuses() {
    let real = AppData::new();
    let d = AppData::new();
    fs::remove_dir_all(d.0.join("plugins")).unwrap();
    if !link_dir(&d.0.join("plugins"), &real.0.join("plugins")) {
        eprintln!("skipped: the OS refused to create a directory link");
        return;
    }
    assert!(real.resolves("/index.html"));
    assert!(!d.resolves("/index.html"));
}

#[test]
fn size_cap() {
    let d = AppData::new();
    let edge = d.plugin().join("edge.js");
    let over = d.plugin().join("over.js");
    fs::write(&edge, vec![b' '; MAX_SERVED_BYTES as usize]).unwrap();
    fs::write(&over, vec![b' '; MAX_SERVED_BYTES as usize + 1]).unwrap();
    assert_eq!(
        read_capped(&edge).map(|b| b.len() as u64),
        Some(MAX_SERVED_BYTES)
    );
    assert_eq!(read_capped(&over), None);
    assert_eq!(read_capped(&d.plugin()), None);
}

// ---- Responses ----

const APP_REFERER: &str = "http://tauri.localhost/";

const DOC: ResourceKind = ResourceKind::Document;
const SUB: ResourceKind = ResourceKind::Subresource;

/// A registry that serves every id, for the tests that are not about the registry.
fn all(_: &str) -> bool {
    true
}

fn get(
    d: &AppData,
    uri: &str,
    referer: Option<&str>,
    dest: Option<&str>,
    kind: ResourceKind,
) -> StatusCode {
    respond(&d.0, "GET", uri, referer, dest, kind, &all).status()
}

#[test]
fn serves_a_document_and_its_subresources() {
    let d = AppData::new();
    let own = format!("{}/index.html?origin=x", origin(ID));
    let page = respond(
        &d.0,
        "GET",
        &url(ID, "/index.html?origin=x"),
        Some(APP_REFERER),
        Some("iframe"),
        DOC,
        &all,
    );
    assert_eq!(page.status(), StatusCode::OK);
    assert_eq!(page.body(), b"<p>hi</p>");
    assert_eq!(
        page.headers()[header::CONTENT_TYPE],
        "text/html; charset=utf-8"
    );
    for dest in [Some("script"), Some("image"), None] {
        assert_eq!(
            get(&d, &url(ID, "/ui/app.js"), Some(&own), dest, SUB),
            StatusCode::OK
        );
    }
    // The origin-only Referer a cross-origin policy sends is enough.
    let bare = format!("{}/", origin(ID));
    assert_eq!(
        get(&d, &url(ID, "/ui/app.js"), Some(&bare), Some("script"), SUB),
        StatusCode::OK
    );
}

#[test]
fn the_resource_context_decides_and_the_header_must_agree() {
    let d = AppData::new();
    let own = format!("{}/index.html", origin(ID));
    let page = url(ID, "/index.html");
    let forbidden = StatusCode::FORBIDDEN;

    // Without the header the context alone decides.
    assert_eq!(get(&d, &page, Some(APP_REFERER), None, DOC), StatusCode::OK);
    assert_eq!(get(&d, &page, Some(&own), None, SUB), StatusCode::OK);
    assert_eq!(get(&d, &page, Some(APP_REFERER), None, SUB), forbidden);
    assert_eq!(get(&d, &page, Some(&own), None, DOC), forbidden);

    // A header that agrees changes nothing.
    for dest in ["iframe", "document"] {
        assert_eq!(
            get(&d, &page, Some(APP_REFERER), Some(dest), DOC),
            StatusCode::OK
        );
    }
    // A header that disagrees is refused, whichever Referer would have passed.
    for (dest, kind, referer) in [
        ("script", DOC, APP_REFERER),
        ("empty", DOC, APP_REFERER),
        ("", DOC, APP_REFERER),
        ("iframe", SUB, own.as_str()),
        ("document", SUB, own.as_str()),
        ("iframe", SUB, APP_REFERER),
    ] {
        assert_eq!(
            get(&d, &page, Some(referer), Some(dest), kind),
            forbidden,
            "{dest:?} {kind:?}"
        );
    }
}

#[test]
fn referer_matrix() {
    let d = AppData::new();
    let other = "com.example.other";
    d.write(&format!("plugins/{other}/index.html"), b"x");
    let own = format!("{}/index.html", origin(ID));
    let foreign = format!("{}/index.html", origin(other));
    let page = url(ID, "/index.html");
    let script = url(ID, "/ui/app.js");
    let forbidden = StatusCode::FORBIDDEN;

    // Each rule holds whether or not the webview exposes Sec-Fetch-Dest.
    for doc_dest in [Some("iframe"), None] {
        // Documents: only the app may mount one.
        for referer in [APP_REFERER, "http://tauri.localhost"] {
            assert_eq!(get(&d, &page, Some(referer), doc_dest, DOC), StatusCode::OK);
        }
        for referer in [
            own.as_str(),
            foreign.as_str(),
            "https://tauri.localhost/",
            "http://tauri.localhost:8080/",
            "http://tauri.localhost.evil.example/",
            "http://evil.example/",
            "null",
            "",
        ] {
            assert_eq!(
                get(&d, &page, Some(referer), doc_dest, DOC),
                forbidden,
                "{referer:?} {doc_dest:?}"
            );
        }
        assert_eq!(get(&d, &page, None, doc_dest, DOC), forbidden);

        // Another plugin navigating its frame to this host is a document without the app
        // Referer.
        let theirs = url(other, "/index.html");
        assert_eq!(get(&d, &theirs, Some(&own), doc_dest, DOC), forbidden);
        assert_eq!(
            get(&d, &theirs, Some(APP_REFERER), doc_dest, DOC),
            StatusCode::OK
        );
    }

    for sub_dest in [Some("script"), None] {
        // Subresources: WebView2 shows no Referer for them, so an absent one is served; a
        // present one must be their own host.
        assert_eq!(get(&d, &script, None, sub_dest, SUB), StatusCode::OK);
        assert_eq!(get(&d, &script, Some(&own), sub_dest, SUB), StatusCode::OK);
        for referer in [
            APP_REFERER,
            foreign.as_str(),
            "http://evil.example/",
            &format!("http://{}.invalid/", host_for_id(ID)),
            &format!("https://{}.invalid:1/", host_for_id(ID)),
            "null",
            "",
        ] {
            assert_eq!(
                get(&d, &script, Some(referer), sub_dest, SUB),
                forbidden,
                "{referer:?} {sub_dest:?}"
            );
        }
    }

    // Another plugin's file requested as a document from a plugin Referer is still refused.
    d.write(&format!("plugins/{other}/ui/app.js"), b"x");
    let their_script = url(other, "/ui/app.js");
    for doc_dest in [Some("iframe"), None] {
        assert_eq!(get(&d, &their_script, Some(&own), doc_dest, DOC), forbidden);
    }
}

// With subresource Referers invisible, the frame CSP is the only barrier between one plugin's
// page and another plugin's files. Widening it reopens that path.
#[test]
fn the_frame_csp_confines_each_plugin_to_its_own_host() {
    let reason = "the frame CSP is the only barrier against one plugin loading another \
                      plugin's files; it must not name a host, a wildcard or a scheme";
    let directives: Vec<(&str, Vec<&str>)> = FRAME_CSP
        .split(';')
        .map(str::trim)
        .filter(|d| !d.is_empty())
        .map(|d| {
            let mut parts = d.split_whitespace();
            (parts.next().unwrap(), parts.collect())
        })
        .collect();
    let sources = |name: &str| {
        directives
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, s)| s.clone())
    };
    assert_eq!(sources("default-src"), Some(vec!["'none'"]), "{reason}");
    assert_eq!(sources("connect-src"), Some(vec!["'none'"]), "{reason}");
    assert_eq!(sources("sandbox"), Some(vec!["allow-scripts"]), "{reason}");
    assert_eq!(
        sources("img-src"),
        Some(vec!["'self'", "data:", "blob:"]),
        "{reason}"
    );
    for (name, values) in &directives {
        if *name == "sandbox" {
            continue;
        }
        for value in values {
            let keyword = value.starts_with('\'') && value.ends_with('\'');
            let inline_image = *name == "img-src" && matches!(*value, "data:" | "blob:");
            assert!(keyword || inline_image, "{name} allows {value:?}: {reason}");
            assert!(!value.contains('*'), "{name} allows {value:?}: {reason}");
        }
    }
}

#[test]
fn only_enabled_plugins_are_served() {
    let d = AppData::new();
    let own = format!("{}/index.html", origin(ID));
    let page = url(ID, "/index.html");
    let script = url(ID, "/ui/app.js");
    let only_demo = |id: &str| id == ID;
    let none = |_: &str| false;

    let doc = |enabled: &dyn Fn(&str) -> bool| {
        respond(
            &d.0,
            "GET",
            &page,
            Some(APP_REFERER),
            Some("iframe"),
            DOC,
            enabled,
        )
    };
    let sub = |enabled: &dyn Fn(&str) -> bool| {
        respond(
            &d.0,
            "GET",
            &script,
            Some(&own),
            Some("script"),
            SUB,
            enabled,
        )
    };
    assert_eq!(doc(&only_demo).status(), StatusCode::OK);
    assert_eq!(sub(&only_demo).status(), StatusCode::OK);

    // Installed on disk but not enabled in the registry.
    let disabled = doc(&none);
    let disabled_sub = sub(&none);
    assert_eq!(disabled.status(), StatusCode::NOT_FOUND);
    assert_eq!(disabled_sub.status(), StatusCode::NOT_FOUND);
    // Another plugin being enabled does not serve this one.
    assert_eq!(
        doc(&|id: &str| id == "com.example.other").status(),
        StatusCode::NOT_FOUND
    );

    // In the registry but with no folder, and in neither: the same answer, byte for byte.
    let unregistered = respond(
        &d.0,
        "GET",
        &url("com.example.missing", "/index.html"),
        Some(APP_REFERER),
        Some("iframe"),
        DOC,
        &none,
    );
    let ghost = respond(
        &d.0,
        "GET",
        &url("com.example.missing", "/index.html"),
        Some(APP_REFERER),
        Some("iframe"),
        DOC,
        &|_: &str| true,
    );
    for other in [&unregistered, &ghost] {
        assert_eq!(disabled.status(), other.status());
        assert_eq!(disabled.headers(), other.headers());
        assert_eq!(disabled.body(), other.body());
    }
    assert_eq!(disabled_sub.headers(), unregistered.headers());
    assert!(disabled.body().is_empty());
    assert_eq!(
        disabled.headers()[header::CONTENT_SECURITY_POLICY],
        FRAME_CSP
    );
}

#[test]
fn refusals_keep_their_status_when_the_plugin_is_disabled() {
    let d = AppData::new();
    let page = url(ID, "/index.html");
    let none = |_: &str| false;
    // The Referer and method rules run before the registry is consulted.
    assert_eq!(
        respond(
            &d.0,
            "POST",
            &page,
            Some(APP_REFERER),
            Some("iframe"),
            DOC,
            &none
        )
        .status(),
        StatusCode::METHOD_NOT_ALLOWED
    );
    assert_eq!(
        respond(&d.0, "GET", &page, None, Some("iframe"), DOC, &none).status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        respond(
            &d.0,
            "GET",
            &page,
            Some(APP_REFERER),
            Some("script"),
            DOC,
            &none
        )
        .status(),
        StatusCode::FORBIDDEN
    );
}

#[test]
fn frame_urls_are_handed_out_only_for_enabled_plugins() {
    let d = AppData::new();
    assert_eq!(
        installed_frame_url(&d.0, ID, &|id: &str| id == ID),
        Some(frame_url(ID))
    );
    assert_eq!(installed_frame_url(&d.0, ID, &|_: &str| false), None);
    // Enabled in the registry but never installed.
    assert_eq!(installed_frame_url(&d.0, "com.example.missing", &all), None);
}

#[test]
fn refusals_by_method_label_and_path() {
    let d = AppData::new();
    let page = url(ID, "/index.html");
    for method in ["POST", "PUT", "HEAD", "OPTIONS", "get", ""] {
        assert_eq!(
            respond(
                &d.0,
                method,
                &page,
                Some(APP_REFERER),
                Some("iframe"),
                DOC,
                &all
            )
            .status(),
            StatusCode::METHOD_NOT_ALLOWED,
            "{method:?}"
        );
    }
    // An uninstalled but well-formed host.
    let missing = "com.example.missing";
    assert_eq!(
        get(
            &d,
            &url(missing, "/index.html"),
            Some(APP_REFERER),
            Some("iframe"),
            DOC
        ),
        StatusCode::NOT_FOUND
    );
    // A URI the host does not own.
    assert_eq!(
        get(
            &d,
            "http://tauri.localhost/index.html",
            Some(APP_REFERER),
            Some("iframe"),
            DOC
        ),
        StatusCode::NOT_FOUND
    );
    let own = format!("{}/index.html", origin(ID));
    for path in [
        "/..%2F..%2Fplisto.sqlite",
        "/..%2Fsecret.js",
        "/index.html::$DATA",
        "/index.html%3A%3A%24DATA",
        "/index.html.",
        "/_plisto/missing.css",
        "/missing.js",
    ] {
        assert_eq!(
            get(&d, &url(ID, path), Some(&own), Some("script"), SUB),
            StatusCode::NOT_FOUND,
            "{path:?}"
        );
    }
}

#[test]
fn a_junctioned_plugin_folder_is_not_served() {
    let d = AppData::new();
    let linked = "com.example.linked";
    if !link_dir(&d.0.join("plugins").join(linked), &d.plugin()) {
        eprintln!("skipped: the OS refused to create a directory link");
        return;
    }
    assert_eq!(
        get(
            &d,
            &url(linked, "/index.html"),
            Some(APP_REFERER),
            Some("iframe"),
            DOC
        ),
        StatusCode::NOT_FOUND
    );
}

#[test]
fn every_response_carries_the_frame_headers() {
    let d = AppData::new();
    let own = format!("{}/index.html", origin(ID));
    let page = url(ID, "/index.html");
    for res in [
        respond(
            &d.0,
            "GET",
            &page,
            Some(APP_REFERER),
            Some("iframe"),
            DOC,
            &all,
        ),
        respond(
            &d.0,
            "POST",
            &page,
            Some(APP_REFERER),
            Some("iframe"),
            DOC,
            &all,
        ),
        respond(&d.0, "GET", &page, None, Some("iframe"), DOC, &all),
        respond(
            &d.0,
            "GET",
            &page,
            Some(APP_REFERER),
            Some("script"),
            DOC,
            &all,
        ),
        respond(
            &d.0,
            "GET",
            &url(ID, "/missing.js"),
            Some(&own),
            None,
            SUB,
            &all,
        ),
        respond(
            &d.0,
            "GET",
            "http://ipc.localhost/x",
            Some(APP_REFERER),
            None,
            SUB,
            &all,
        ),
        refusal(StatusCode::INTERNAL_SERVER_ERROR),
    ] {
        let h = res.headers();
        assert_eq!(h[header::CONTENT_SECURITY_POLICY], FRAME_CSP);
        assert_eq!(h[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert_eq!(h[header::CACHE_CONTROL], "no-store");
        assert_eq!(h[PERMISSIONS_POLICY], permissions_policy().as_str());
        assert!(!h.contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN));
        if res.status() != StatusCode::OK {
            assert!(res.body().is_empty());
        }
    }
    assert!(FRAME_CSP.starts_with("sandbox allow-scripts;"));
}

#[test]
fn header_block_is_exact() {
    let policy = permissions_policy();
    assert_eq!(
        header_block(&served("text/css; charset=utf-8", b"x".to_vec())),
        format!(
            "content-security-policy: {FRAME_CSP}\r\n\
                 x-content-type-options: nosniff\r\n\
                 cache-control: no-store\r\n\
                 permissions-policy: {policy}\r\n\
                 content-type: text/css; charset=utf-8\r\n"
        )
    );
    assert_eq!(
        header_block(&refusal(StatusCode::NOT_FOUND)),
        format!(
            "content-security-policy: {FRAME_CSP}\r\n\
                 x-content-type-options: nosniff\r\n\
                 cache-control: no-store\r\n\
                 permissions-policy: {policy}\r\n"
        )
    );
}

#[test]
fn the_permissions_policy_turns_every_feature_off() {
    let policy = permissions_policy();
    let entries: Vec<&str> = policy.split(", ").collect();
    assert_eq!(entries.len(), DENIED_FEATURES.len());
    for (entry, feature) in entries.iter().zip(DENIED_FEATURES) {
        assert_eq!(*entry, format!("{feature}=()"));
    }
    for feature in [
        "camera",
        "microphone",
        "geolocation",
        "display-capture",
        "picture-in-picture",
        "fullscreen",
        "gamepad",
        "usb",
        "hid",
        "serial",
        "bluetooth",
        "midi",
        "payment",
        "screen-wake-lock",
        "clipboard-read",
        "clipboard-write",
        "autoplay",
        "encrypted-media",
        "speaker-selection",
        "keyboard-map",
        "direct-sockets",
        "smart-card",
        "web-printing",
    ] {
        assert!(
            entries.contains(&format!("{feature}=()").as_str()),
            "{feature}"
        );
    }
    let unique: std::collections::HashSet<_> = DENIED_FEATURES.iter().collect();
    assert_eq!(unique.len(), DENIED_FEATURES.len());
}

#[test]
fn diagnostics_show_presence_not_values() {
    let line = diagnostic(
        "GET",
        &url(ID, "/ui/app.js?token=secret"),
        Some("https://example.test/private/page?q=secret"),
        Some("script"),
        SUB,
        StatusCode::FORBIDDEN,
    );
    assert_eq!(
        line,
        format!(
            "[frame-host] GET {} /ui/app.js context=Subresource \
                 referer=https://example.test sec-fetch-dest=present -> 403",
            host_for_id(ID)
        )
    );
    let bare = diagnostic("POST", "http://x/", None, None, DOC, StatusCode::NOT_FOUND);
    assert_eq!(
        bare,
        "[frame-host] POST ? ? context=Document referer=absent sec-fetch-dest=absent -> 404"
    );
    assert!(!line.contains("secret") && !line.contains("script"));
}

#[test]
fn origins_are_cut_at_the_authority() {
    assert_eq!(
        origin_of("http://tauri.localhost/a?b"),
        Some("http://tauri.localhost")
    );
    assert_eq!(
        origin_of("http://tauri.localhost?b"),
        Some("http://tauri.localhost")
    );
    assert_eq!(
        origin_of("http://tauri.localhost#b"),
        Some("http://tauri.localhost")
    );
    assert_eq!(
        origin_of("http://tauri.localhost"),
        Some("http://tauri.localhost")
    );
    assert_eq!(origin_of("tauri.localhost/"), None);
    assert_eq!(origin_of("null"), None);
}

#[test]
fn probe_fixtures_are_valid_manifests() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/plugins");
    for (folder, id) in [
        ("sandbox-probe", "dev.plisto.probe"),
        ("sandbox-probe2", "dev.plisto.probe2"),
        ("network-probe", "dev.plisto.netprobe"),
        ("network-probe-none", "dev.plisto.netprobe0"),
        ("stream-probe", "dev.plisto.streamprobe"),
    ] {
        let dir = root.join(folder);
        // The fixtures are local-only (the folder is git-ignored), so a fresh clone skips.
        if !dir.is_dir() {
            println!(
                "skipping {folder}: fixture folder {} is absent",
                dir.display()
            );
            continue;
        }
        let manifest = super::super::manifest::parse(&fs::read(dir.join("plugin.json")).unwrap())
            .expect("the probe fixture must parse");
        assert_eq!(manifest.id, id);
        assert_eq!(manifest.tier, super::super::manifest::Tier::Ui);
        assert!(dir.join(&manifest.entry).is_file());
    }

    // The two network probe pages run one script, with and without the capability.
    let with = root.join("network-probe/probe.js");
    let without = root.join("network-probe-none/probe.js");
    if with.is_file() && without.is_file() {
        assert_eq!(
            fs::read(with).unwrap(),
            fs::read(without).unwrap(),
            "the network probe pages must share one probe.js"
        );
    }
}

// `manifest::parse` is the whole content check install runs; it reads no files, so the files
// each manifest points at are checked here. The tap-meter entry is a build product, so only its
// page and sidebar are checked.
#[test]
fn kit_examples_are_valid_manifests() {
    use super::super::manifest::{parse, Tier};
    use super::super::sidebar_decl::ItemType;

    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugin-kit/examples");
    for (folder, tier) in [
        ("hello-ui", Tier::Ui),
        ("hello-background", Tier::Ui),
        ("tap-meter", Tier::Native),
    ] {
        let dir = root.join(folder);
        let bytes = fs::read(dir.join("plugin.json"))
            .unwrap_or_else(|e| panic!("kit example {folder}: plugin.json unreadable: {e}"));
        let manifest =
            parse(&bytes).unwrap_or_else(|e| panic!("kit example {folder}: manifest refused: {e}"));
        assert_eq!(manifest.tier, tier, "kit example {folder}: wrong tier");

        let mut files = Vec::new();
        if tier == Tier::Ui {
            files.push(manifest.entry.clone());
        }
        files.extend(manifest.page.clone());
        files.extend(manifest.icon.clone());
        for file in files {
            assert!(
                dir.join(&file).is_file(),
                "kit example {folder}: declared file {file} is missing"
            );
        }

        if folder == "tap-meter" {
            assert_eq!(manifest.page.as_deref(), Some("page/index.html"));
            let sidebar = manifest
                .sidebar
                .as_ref()
                .expect("tap-meter declares a sidebar");
            assert!(
                sidebar.items.iter().any(|i| i.kind == ItemType::Nav),
                "tap-meter sidebar has no nav item"
            );
        }
    }
}
