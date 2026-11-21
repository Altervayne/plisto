/*
 * A frame host for development test pages, compiled into debug builds only: fixed
 * `https://probe-<name>.invalid` hosts that serve flat files from `src/dev/probes/fixtures/` with no
 * plugin installed. Each host serves under one header policy derived from the plugin frame host's
 * own, so one page can be loaded under the page and visualizer policies and under stricter variants
 * of them and the results compared. The document and Referer rules are the plugin frame host's own.
 * Fixtures are read, never written.
 */

// -- Library Imports --
use std::collections::VecDeque;
use std::fs;
use std::io::Cursor;
use std::path::Path;
use std::sync::{Mutex, PoisonError};

use image::{ImageFormat, Rgba, RgbaImage};
use tauri::http::{header, Response, StatusCode};

// -- Local Imports --
use super::{
    is_document, is_reparse_point, origin_of, permissions_policy, read_capped, referer_allowed,
    ResourceKind, FRAME_CSP, HOST_SUFFIX, MIME_TYPES, PERMISSIONS_POLICY, SCHEME_PREFIX,
};
use crate::plugins::frame_host::vis_host::VIS_CSP;

/// The request pattern the webview routes to the probe host.
pub const PROBE_FILTER: &str = "https://probe-*.invalid/*";

// Debug builds run from the repository, so the fixtures are read in place.
const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../src/dev/probes/fixtures");

/// The raw path of the generated test image.
pub const PATTERN_PATH: &str = "/gen/pattern.png";
const PATTERN_EDGE: u32 = 16;

/// The test image's quadrants as RGBA: top left, top right, bottom left, bottom right. Opaque, so a
/// decoder reads the exact values back.
pub const PATTERN_COLORS: [[u8; 4]; 4] = [
    [255, 0, 0, 255],
    [0, 255, 0, 255],
    [0, 0, 255, 255],
    [255, 255, 255, 255],
];

const LOG_CAP: usize = 200;
// The longest path or Referer origin a log line keeps, in characters.
const LOG_FIELD_CHARS: usize = 200;

static LOG: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());

/// The header policy a probe host serves under.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Policy {
    /// The page host headers without the UI additions: `connect-src 'none'`, no CORS header and
    /// none of the extended file types.
    Released,
    /// `Released` with `connect-src 'self'`.
    ReleasedSelfConnect,
    /// The page host headers.
    UiAdditions,
    /// The visualizer host headers.
    Visualizer,
}

const HOSTS: &[(&str, Policy)] = &[
    ("probe-ui0", Policy::Released),
    ("probe-ui0s", Policy::ReleasedSelfConnect),
    ("probe-ui1", Policy::UiAdditions),
    ("probe-vis", Policy::Visualizer),
    ("probe-vis2", Policy::Visualizer),
];

// The file types only the extended policies serve.
const EXTENDED_TYPES: &[&str] = &["mjs", "wasm", "bin", "glsl", "frag", "vert", "ktx2", "glb"];

impl Policy {
    /// The policies with CORS and the extended file types.
    fn extended(self) -> bool {
        matches!(self, Policy::UiAdditions | Policy::Visualizer)
    }

    /// The Content-Security-Policy: a frame host policy, or `FRAME_CSP` rewritten so the variant
    /// differs only where named.
    pub fn csp(self) -> String {
        match self {
            Policy::Released => FRAME_CSP.replace("connect-src 'self'", "connect-src 'none'"),
            Policy::ReleasedSelfConnect | Policy::UiAdditions => FRAME_CSP.to_string(),
            Policy::Visualizer => VIS_CSP.to_string(),
        }
    }

    fn mime_for(self, ext: &str) -> Option<&'static str> {
        if !self.extended() && EXTENDED_TYPES.contains(&ext) {
            return None;
        }
        MIME_TYPES
            .iter()
            .find(|(known, _)| *known == ext)
            .map(|(_, mime)| *mime)
    }
}

/// Splits a probe host URL into its policy, its label and its raw path (query and fragment
/// dropped). Only the fixed hosts over https match, with no port and no userinfo.
pub fn parse_probe_url(uri: &str) -> Option<(Policy, &str, &str)> {
    let rest = uri.strip_prefix(SCHEME_PREFIX)?;
    let (authority, tail) = rest.split_at(rest.find('/')?);
    let label = authority.strip_suffix(HOST_SUFFIX)?;
    let (_, policy) = HOSTS.iter().find(|(host, _)| *host == label)?;
    let end = tail.find(['?', '#']).unwrap_or(tail.len());
    Some((*policy, label, &tail[..end]))
}

fn with_headers(policy: Policy, status: StatusCode) -> tauri::http::response::Builder {
    let builder = Response::builder()
        .status(status)
        .header(header::CONTENT_SECURITY_POLICY, policy.csp())
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CACHE_CONTROL, "no-store")
        .header(PERMISSIONS_POLICY, permissions_policy());
    if policy.extended() {
        builder.header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
    } else {
        builder
    }
}

fn refusal(policy: Policy, status: StatusCode) -> Response<Vec<u8>> {
    with_headers(policy, status)
        .body(Vec::new())
        .expect("static response parts are valid")
}

fn served(policy: Policy, mime: &'static str, body: Vec<u8>) -> Response<Vec<u8>> {
    with_headers(policy, StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .body(body)
        .expect("static response parts are valid")
}

/// Answers one probe host request from the fixtures folder and records it in the request log.
/// `referer`, `dest` and `origin` are the request's `Referer`, `Sec-Fetch-Dest` and `Origin` headers.
pub fn respond(
    method: &str,
    uri: &str,
    referer: Option<&str>,
    dest: Option<&str>,
    kind: ResourceKind,
    origin: Option<&str>,
) -> Response<Vec<u8>> {
    let response = respond_in(Path::new(FIXTURES), method, uri, referer, dest, kind);
    let line = log_line(method, uri, referer, origin, kind, response.status());
    push_line(
        &mut LOG.lock().unwrap_or_else(PoisonError::into_inner),
        line,
    );
    response
}

/// Answers a probe host request from the fixtures in `root`.
fn respond_in(
    root: &Path,
    method: &str,
    uri: &str,
    referer: Option<&str>,
    dest: Option<&str>,
    kind: ResourceKind,
) -> Response<Vec<u8>> {
    let Some((policy, label, path)) = parse_probe_url(uri) else {
        return super::refusal(StatusCode::NOT_FOUND);
    };
    if method != "GET" {
        return refusal(policy, StatusCode::METHOD_NOT_ALLOWED);
    }
    let Some(document) = is_document(kind, dest) else {
        return refusal(policy, StatusCode::FORBIDDEN);
    };
    if !referer_allowed(label, referer, document) {
        return refusal(policy, StatusCode::FORBIDDEN);
    }
    if path == PATTERN_PATH {
        return served(policy, "image/png", pattern_png());
    }
    fixture(root, policy, path)
        .map(|(mime, body)| served(policy, mime, body))
        .unwrap_or_else(|| refusal(policy, StatusCode::NOT_FOUND))
}

// Names that open a Windows device rather than a file, whatever the extension.
fn is_device_name(stem: &str) -> bool {
    matches!(stem, "con" | "prn" | "aux" | "nul")
        || (stem.len() == 4
            && (stem.starts_with("com") || stem.starts_with("lpt"))
            && stem.as_bytes()[3].is_ascii_digit())
}

/// A fixture file for a raw request path: one flat `name.ext` in lowercase letters, digits and
/// hyphens, an extension the policy serves, and a plain file within the size cap, in a root that is a
/// plain directory. The path is never decoded, so an escape cannot satisfy the name rule.
fn fixture(root: &Path, policy: Policy, raw_path: &str) -> Option<(&'static str, Vec<u8>)> {
    let name = raw_path.strip_prefix('/')?;
    let (stem, ext) = name.split_once('.')?;
    let stem_ok = !stem.is_empty()
        && stem
            .bytes()
            .all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'-'));
    let ext_ok = !ext.is_empty() && ext.bytes().all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9'));
    if !stem_ok || !ext_ok || is_device_name(stem) {
        return None;
    }
    let mime = policy.mime_for(ext)?;
    let root_meta = fs::symlink_metadata(root).ok()?;
    if !root_meta.is_dir() || is_reparse_point(&root_meta) {
        return None;
    }
    let file = root.join(name);
    let meta = fs::symlink_metadata(&file).ok()?;
    if !meta.is_file() || is_reparse_point(&meta) {
        return None;
    }
    read_capped(&file).map(|body| (mime, body))
}

/// The generated test image: four flat quadrants of `PATTERN_COLORS`.
fn pattern_png() -> Vec<u8> {
    let half = PATTERN_EDGE / 2;
    let image = RgbaImage::from_fn(PATTERN_EDGE, PATTERN_EDGE, |x, y| {
        Rgba(PATTERN_COLORS[usize::from(y >= half) * 2 + usize::from(x >= half)])
    });
    let mut png = Cursor::new(Vec::new());
    image
        .write_to(&mut png, ImageFormat::Png)
        .expect("an in-memory PNG encode does not fail");
    png.into_inner()
}

/// The class of an `Origin` header, never its value.
fn origin_class(origin: Option<&str>) -> &'static str {
    match origin {
        None => "absent",
        Some("null") => "null",
        Some(_) => "other",
    }
}

fn clip(field: &str) -> String {
    field.chars().take(LOG_FIELD_CHARS).collect()
}

/// One request log line. Header values never appear: only the Referer's origin and the class of
/// the Origin header. The path and the Referer origin are clipped, so the log stays bounded.
fn log_line(
    method: &str,
    uri: &str,
    referer: Option<&str>,
    origin: Option<&str>,
    kind: ResourceKind,
    status: StatusCode,
) -> String {
    let (host, path) = parse_probe_url(uri).map_or(("?", "?"), |(_, label, path)| (label, path));
    let referer = match referer {
        None => "absent",
        Some(r) => origin_of(r).unwrap_or("unparsable"),
    };
    let (path, referer) = (clip(path), clip(referer));
    format!(
        "{method} {host} {path} context={kind:?} referer={referer} origin={} -> {}",
        origin_class(origin),
        status.as_u16()
    )
}

fn push_line(log: &mut VecDeque<String>, line: String) {
    if log.len() == LOG_CAP {
        log.pop_front();
    }
    log.push_back(line);
}

/// The request log, oldest line first.
pub fn log_lines() -> Vec<String> {
    LOG.lock()
        .unwrap_or_else(PoisonError::into_inner)
        .iter()
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests;
