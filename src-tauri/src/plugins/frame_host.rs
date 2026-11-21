/*
 * The plugin frame host: every decision about a request for `https://pp-<hash>.invalid/<path>`, the
 * URL each installed plugin's frames load from. The host label is a hash of the plugin id, so each
 * plugin is its own origin, and a `.invalid` https host is neither a Tauri-local URL nor reachable
 * on the network when nothing intercepts it. Every response, refusals included, carries the frame's
 * own CSP with `sandbox allow-scripts`, so a document served here is opaque-origin even when loaded
 * outside a sandboxed iframe, and nothing in the headers lets another origin read it. A
 * `Permissions-Policy` turns every known device, sensor and clipboard feature off for the page. Everything here
 * is a function of the app data dir and the request, so each rule is testable without a webview.
 */

// -- Library Imports --
use std::fmt::Write as _;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use tauri::http::{header, Response, StatusCode};

// -- Local Imports --
use super::frame_host_files::host_file;
use super::paths::{plugin_dir, plugins_dir, validate_id, validate_rel_path};
use super::summary::read_manifest;

/// The request pattern the webview routes to the frame host.
pub const FILTER: &str = "https://pp-*.invalid/*";

/// Files above this size are refused rather than read into memory.
pub const MAX_SERVED_BYTES: u64 = 8 * 1024 * 1024;

const SCHEME_PREFIX: &str = "https://";
const LABEL_PREFIX: &str = "pp-";
const HOST_SUFFIX: &str = ".invalid";
// 16 bytes of the id hash, as lowercase hex.
const HASH_HEX_LEN: usize = 32;

// The origins the main window's own pages load from. Only they may mount a plugin document.
const APP_ORIGIN: &str = "http://tauri.localhost";
#[cfg(dev)]
const DEV_ORIGIN: &str = "http://localhost:1420";

const PERMISSIONS_POLICY: &str = "permissions-policy";

// The first path segment reserved for files the host itself serves.
const HOST_SEGMENT: &str = "_plisto";

// The policy on every frame response. The sandbox has no `allow-same-origin`, so the page has an opaque
// origin; scripts and files come from its own host only; `connect-src 'none'` leaves the bridge as the
// only way out. Inline styles stay allowed for page styling.
pub const FRAME_CSP: &str = "sandbox allow-scripts; default-src 'none'; script-src 'self'; \
    style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'none'";

// The policy-controlled features Chromium knows, each turned off by `Permissions-Policy`. A plugin
// page draws and talks to the host through its bridge; it never needs a device, a sensor or the
// clipboard. A name the webview does not know is ignored. Features added to the web later are not
// listed; `allow=""` on the frame keeps the app from delegating them. The scheduling features
// (`execution-while-*`, `vertical-scroll`) stay out, so a background frame keeps running.
const DENIED_FEATURES: &[&str] = &[
    "accelerometer",
    "all-screens-capture",
    "ambient-light-sensor",
    "attribution-reporting",
    "autoplay",
    "bluetooth",
    "browsing-topics",
    "camera",
    "captured-surface-control",
    "clipboard-read",
    "clipboard-write",
    "compute-pressure",
    "controlled-frame",
    "cross-origin-isolated",
    "deferred-fetch",
    "digital-credentials-get",
    "direct-sockets",
    "display-capture",
    "document-domain",
    "encrypted-media",
    "fenced-unpartitioned-data",
    "fullscreen",
    "gamepad",
    "geolocation",
    "gyroscope",
    "hid",
    "identity-credentials-get",
    "idle-detection",
    "join-ad-interest-group",
    "keyboard-map",
    "language-detector",
    "language-model",
    "local-fonts",
    "local-network-access",
    "magnetometer",
    "microphone",
    "midi",
    "on-device-speech-recognition",
    "otp-credentials",
    "payment",
    "picture-in-picture",
    "private-aggregation",
    "private-state-token-issuance",
    "private-state-token-redemption",
    "publickey-credentials-create",
    "publickey-credentials-get",
    "rewriter",
    "run-ad-auction",
    "screen-wake-lock",
    "serial",
    "shared-storage",
    "shared-storage-select-url",
    "smart-card",
    "speaker-selection",
    "storage-access",
    "summarizer",
    "sync-xhr",
    "translator",
    "usb",
    "usb-unrestricted",
    "web-printing",
    "web-share",
    "window-management",
    "writer",
    "xr-spatial-tracking",
];

/// The `Permissions-Policy` value every response carries: each of `DENIED_FEATURES` with an empty
/// allowlist.
fn permissions_policy() -> String {
    DENIED_FEATURES
        .iter()
        .map(|f| format!("{f}=()"))
        .collect::<Vec<_>>()
        .join(", ")
}

// Lowercase extension to Content-Type. Anything else is refused, so a plugin folder can never
// serve an executable, a database or a type the frame CSP was not written for.
const MIME_TYPES: &[(&str, &str)] = &[
    ("html", "text/html; charset=utf-8"),
    ("js", "text/javascript; charset=utf-8"),
    ("css", "text/css; charset=utf-8"),
    ("json", "application/json"),
    ("txt", "text/plain; charset=utf-8"),
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("svg", "image/svg+xml"),
    ("ico", "image/x-icon"),
    ("woff", "font/woff"),
    ("woff2", "font/woff2"),
    ("ttf", "font/ttf"),
    ("otf", "font/otf"),
];

/// A request path that resolved to a servable file inside a plugin folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    pub file: PathBuf,
    pub mime: &'static str,
}

/// The host label for a plugin id: `pp-` and the first 16 bytes of its blake3 hash. A hash rather
/// than the id itself, since mapping the id's dots to a label-safe character is not injective.
pub fn host_for_id(id: &str) -> String {
    let hex = blake3::hash(id.as_bytes()).to_hex();
    format!("{LABEL_PREFIX}{}", &hex.as_str()[..HASH_HEX_LEN])
}

/// The base URL a plugin's frames load from, with its trailing slash.
pub fn frame_url(id: &str) -> String {
    format!("{SCHEME_PREFIX}{}{HOST_SUFFIX}/", host_for_id(id))
}

/// The base URL for an enabled plugin: a valid id the registry serves whose folder is a plain
/// directory and whose manifest names an entry page. None otherwise, so a plugin that only adds
/// visualizers never gets a frame of its own.
pub fn installed_frame_url(
    app_data: &Path,
    id: &str,
    enabled: &dyn Fn(&str) -> bool,
) -> Option<String> {
    validate_id(id).ok()?;
    if !enabled(id) {
        return None;
    }
    read_manifest(&plugin_dir(app_data, id))?.entry?;
    Some(frame_url(id))
}

fn is_label(label: &str) -> bool {
    label.strip_prefix(LABEL_PREFIX).is_some_and(|hex| {
        hex.len() == HASH_HEX_LEN && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    })
}

/// Splits a frame host URL into its label and its path (still percent-encoded, query dropped). The
/// host must be exactly `pp-<32 lowercase hex>.invalid` over https, with no port and no userinfo.
pub fn parse_frame_url(uri: &str) -> Option<(&str, &str)> {
    let rest = uri.strip_prefix(SCHEME_PREFIX)?;
    let (authority, tail) = rest.split_at(rest.find('/')?);
    let label = authority.strip_suffix(HOST_SUFFIX)?;
    if !is_label(label) {
        return None;
    }
    let end = tail.find(['?', '#']).unwrap_or(tail.len());
    Some((label, &tail[..end]))
}

/// The installed plugin a host label stands for. Only folders whose name passes `validate_id` are
/// considered, so a label never maps to a folder an id could not name.
pub fn id_for_label(app_data: &Path, label: &str) -> Option<String> {
    fs::read_dir(plugins_dir(app_data))
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| validate_id(name).is_ok())
        .find(|id| host_for_id(id) == label)
}

/// The `scheme://authority` prefix of an absolute URL.
fn origin_of(url: &str) -> Option<&str> {
    let scheme_end = url.find("://")? + 3;
    let end = url[scheme_end..]
        .find(['/', '?', '#'])
        .map_or(url.len(), |i| scheme_end + i);
    Some(&url[..end])
}

fn is_app_origin(origin: &str) -> bool {
    #[cfg(dev)]
    if origin == DEV_ORIGIN {
        return true;
    }
    origin == APP_ORIGIN
}

/// What the webview says a request loads, from its own resource context rather than a header.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResourceKind {
    Document,
    Subresource,
}

/// Whether a request loads a document. The resource context decides; a `Sec-Fetch-Dest` header,
/// when the webview exposes one, must agree with it, and None means they disagree.
fn is_document(kind: ResourceKind, dest: Option<&str>) -> Option<bool> {
    let dest_document = dest.map(|d| matches!(d, "iframe" | "document"));
    match (kind, dest_document) {
        (ResourceKind::Document, None | Some(true)) => Some(true),
        (ResourceKind::Subresource, None | Some(false)) => Some(false),
        _ => None,
    }
}

/// A frame document may only be mounted by the app's own pages, and a document without a Referer
/// is refused: this guards mounting and stops a plugin navigating its frame to another plugin's
/// host. WebView2 does not show the Referer of a frame's subresource requests, so a subresource
/// without one is served, and keeping one plugin's page from pulling another plugin's files rests
/// on the frame CSP every served document carries. A subresource Referer that is present must
/// still be the plugin's own host.
fn referer_allowed(label: &str, referer: Option<&str>, document: bool) -> bool {
    let Some(referer) = referer else {
        return !document;
    };
    let Some(origin) = origin_of(referer) else {
        return false;
    };
    if document {
        return is_app_origin(origin);
    }
    origin
        .strip_prefix(SCHEME_PREFIX)
        .and_then(|host| host.strip_suffix(HOST_SUFFIX))
        == Some(label)
}

/// Decodes `%XX` escapes in one pass, so `%252e` yields the literal `%2e` and never a dot. A
/// malformed escape or a result that is not UTF-8 is refused.
fn percent_decode(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes.get(i + 1..i + 3)?;
            let hex = std::str::from_utf8(hex).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn mime_for(rel: &str) -> Option<&'static str> {
    let ext = rel.rsplit_once('.')?.1.to_ascii_lowercase();
    MIME_TYPES
        .iter()
        .find(|(known, _)| *known == ext)
        .map(|(_, mime)| *mime)
}

#[cfg(windows)]
pub(super) fn is_reparse_point(meta: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
    meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0
}

#[cfg(not(windows))]
pub(super) fn is_reparse_point(meta: &fs::Metadata) -> bool {
    meta.file_type().is_symlink()
}

/// Walks from the plugins folder down to the file without following anything: every step must be a
/// plain directory, the last a plain file, and none a junction, symlink or other reparse point.
fn plain_chain(app_data: &Path, id: &str, rel: &str) -> bool {
    let plain = |path: &Path, want_file: bool| {
        fs::symlink_metadata(path).is_ok_and(|meta| {
            let kind = if want_file {
                meta.is_file()
            } else {
                meta.is_dir()
            };
            kind && !is_reparse_point(&meta)
        })
    };
    let mut path = plugins_dir(app_data);
    if !plain(&path, false) {
        return false;
    }
    path.push(id);
    if !plain(&path, false) {
        return false;
    }
    let mut parts = rel.split('/').peekable();
    while let Some(part) = parts.next() {
        path.push(part);
        if !plain(&path, parts.peek().is_none()) {
            return false;
        }
    }
    true
}

/// Maps a request path (`/<rel>`, still percent-encoded) to a file under `<app_data>/plugins/<id>/`.
/// Returns None for anything that is not a servable plugin file.
pub fn resolve(app_data: &Path, id: &str, request_path: &str) -> Option<Resolved> {
    let decoded = percent_decode(request_path)?;
    let rel = decoded.strip_prefix('/')?;
    if rel.split('/').next() == Some(HOST_SEGMENT) {
        return None;
    }
    validate_id(id).ok()?;
    validate_rel_path(rel).ok()?;
    let mime = mime_for(rel)?;
    if !plain_chain(app_data, id, rel) {
        return None;
    }

    // The chain check already refuses links; the canonical comparison also covers anything the
    // filesystem resolves on its own.
    let root = fs::canonicalize(plugin_dir(app_data, id)).ok()?;
    let file = fs::canonicalize(plugin_dir(app_data, id).join(rel)).ok()?;
    if !file.starts_with(&root) {
        return None;
    }
    Some(Resolved { file, mime })
}

/// Reads a resolved file, refusing anything that is not a plain file or is over the size cap.
fn read_capped(path: &Path) -> Option<Vec<u8>> {
    let file = fs::File::open(path).ok()?;
    let meta = file.metadata().ok()?;
    if !meta.is_file() || meta.len() > MAX_SERVED_BYTES {
        return None;
    }
    let mut body = Vec::with_capacity(meta.len() as usize);
    // The length is re-checked on the bytes read, in case the file grew after the metadata call.
    file.take(MAX_SERVED_BYTES + 1)
        .read_to_end(&mut body)
        .ok()?;
    (body.len() as u64 <= MAX_SERVED_BYTES).then_some(body)
}

fn with_frame_headers(status: StatusCode) -> tauri::http::response::Builder {
    Response::builder()
        .status(status)
        .header(header::CONTENT_SECURITY_POLICY, FRAME_CSP)
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CACHE_CONTROL, "no-store")
        .header(PERMISSIONS_POLICY, permissions_policy())
}

/// An empty response with the frame headers.
pub fn refusal(status: StatusCode) -> Response<Vec<u8>> {
    with_frame_headers(status)
        .body(Vec::new())
        .expect("static response parts are valid")
}

fn served(mime: &'static str, body: Vec<u8>) -> Response<Vec<u8>> {
    with_frame_headers(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .body(body)
        .expect("static response parts are valid")
}

/// Answers one frame host request. `referer` and `dest` are the request's `Referer` and
/// `Sec-Fetch-Dest` headers, `kind` the webview's resource context, `enabled` whether the registry
/// serves an id. Only GET is served, and the Referer check runs before the label is looked up, so a
/// refused caller cannot tell an installed plugin from a missing one. A plugin that is installed but
/// not enabled gets the same 404 as one that is not installed. `/_plisto/` paths are the host's own
/// files, never the plugin's.
pub fn respond(
    app_data: &Path,
    method: &str,
    uri: &str,
    referer: Option<&str>,
    dest: Option<&str>,
    kind: ResourceKind,
    enabled: &dyn Fn(&str) -> bool,
) -> Response<Vec<u8>> {
    if method != "GET" {
        return refusal(StatusCode::METHOD_NOT_ALLOWED);
    }
    let Some((label, path)) = parse_frame_url(uri) else {
        return refusal(StatusCode::NOT_FOUND);
    };
    let Some(document) = is_document(kind, dest) else {
        return refusal(StatusCode::FORBIDDEN);
    };
    if !referer_allowed(label, referer, document) {
        return refusal(StatusCode::FORBIDDEN);
    }
    let Some(id) = id_for_label(app_data, label).filter(|id| enabled(id.as_str())) else {
        return refusal(StatusCode::NOT_FOUND);
    };
    if let Some(file) = host_file(path) {
        return served(file.mime, file.body.to_vec());
    }
    resolve(app_data, &id, path)
        .and_then(|found| read_capped(&found.file).map(|body| served(found.mime, body)))
        .unwrap_or_else(|| refusal(StatusCode::NOT_FOUND))
}

/// The response headers as the CRLF-separated block WebView2 takes.
pub fn header_block(response: &Response<Vec<u8>>) -> String {
    let mut block = String::new();
    for (name, value) in response.headers() {
        if let Ok(value) = value.to_str() {
            let _ = write!(block, "{name}: {value}\r\n");
        }
    }
    block
}

/// One `[frame-host]` line describing a request and its answer. Header values never appear: only
/// the Referer's origin and whether `Sec-Fetch-Dest` was present.
pub fn diagnostic(
    method: &str,
    uri: &str,
    referer: Option<&str>,
    dest: Option<&str>,
    kind: ResourceKind,
    status: StatusCode,
) -> String {
    let (label, path) = parse_frame_url(uri).unwrap_or(("?", "?"));
    let referer = match referer {
        None => "absent",
        Some(r) => origin_of(r).unwrap_or("unparsable"),
    };
    let dest = if dest.is_some() { "present" } else { "absent" };
    format!(
        "[frame-host] {method} {label} {path} context={kind:?} referer={referer} \
         sec-fetch-dest={dest} -> {}",
        status.as_u16()
    )
}

#[cfg(test)]
mod tests;

#[cfg(debug_assertions)]
pub(crate) mod probe;
