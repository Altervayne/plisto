/*
 * The hosts a plugin is served from: the page host `pp-<hash>` and the visualizer host `pv-<hash>`.
 * Every label is a host's prefix and the same id hash, and every host runs the same document,
 * Referer and path rules; only the policy on its responses and the files it serves itself differ.
 */

// -- Library Imports --
use tauri::http::{header, Response, StatusCode};

// -- Local Imports --
use super::vis_host::{parse_vis_url, VIS_HOST};
use super::{
    permissions_policy, FRAME_CSP, HASH_HEX_LEN, HOST_SUFFIX, LABEL_PREFIX, PERMISSIONS_POLICY,
    SCHEME_PREFIX,
};
use crate::plugins::frame_host_files::{host_file, HostFile};

/// One of the hosts a plugin is served from.
pub struct Host {
    pub(super) prefix: &'static str,
    pub(super) csp: &'static str,
    pub(super) files: fn(&str) -> Option<HostFile>,
}

/// The host a plugin's pages and background frame load from.
pub static PAGE_HOST: Host = Host {
    prefix: LABEL_PREFIX,
    csp: FRAME_CSP,
    files: host_file,
};

/// A host's label for a plugin id: its prefix and the first 16 bytes of the id's blake3 hash. A
/// hash rather than the id itself, since mapping the id's dots to a label-safe character is not
/// injective.
pub(super) fn label_on(host: &Host, id: &str) -> String {
    let hex = blake3::hash(id.as_bytes()).to_hex();
    format!("{}{}", host.prefix, &hex.as_str()[..HASH_HEX_LEN])
}

pub(super) fn is_label(host: &Host, label: &str) -> bool {
    label.strip_prefix(host.prefix).is_some_and(|hex| {
        hex.len() == HASH_HEX_LEN && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    })
}

/// The page host label with the same id hash as `label` on `host`, which names the plugin folder.
pub(super) fn page_label(host: &Host, label: &str) -> String {
    format!("{LABEL_PREFIX}{}", &label[host.prefix.len()..])
}

/// Splits a URL on `host` into its label and its path (still percent-encoded, query dropped). The
/// host must be exactly the prefix and 32 lowercase hex, then `.invalid`, over https, with no port
/// and no userinfo.
pub(super) fn parse_on<'a>(host: &Host, uri: &'a str) -> Option<(&'a str, &'a str)> {
    let rest = uri.strip_prefix(SCHEME_PREFIX)?;
    let (authority, tail) = rest.split_at(rest.find('/')?);
    let label = authority.strip_suffix(HOST_SUFFIX)?;
    if !is_label(host, label) {
        return None;
    }
    let end = tail.find(['?', '#']).unwrap_or(tail.len());
    Some((label, &tail[..end]))
}

/// The host a URL names: the visualizer host when it parses as one, the page host otherwise.
pub(super) fn host_of(uri: &str) -> &'static Host {
    if parse_vis_url(uri).is_some() {
        &VIS_HOST
    } else {
        &PAGE_HOST
    }
}

fn with_frame_headers(host: &Host, status: StatusCode) -> tauri::http::response::Builder {
    Response::builder()
        .status(status)
        .header(header::CONTENT_SECURITY_POLICY, host.csp)
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CACHE_CONTROL, "no-store")
        .header(PERMISSIONS_POLICY, permissions_policy())
        // The frame's origin is opaque, so its own images, modules and fetches are cross-origin to
        // it. Another plugin's frame still reaches none of them: its CSP names only its own host.
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
}

pub(super) fn refusal_on(host: &Host, status: StatusCode) -> Response<Vec<u8>> {
    with_frame_headers(host, status)
        .body(Vec::new())
        .expect("static response parts are valid")
}

/// An empty response with the page host's headers.
pub fn refusal(status: StatusCode) -> Response<Vec<u8>> {
    refusal_on(&PAGE_HOST, status)
}

pub(super) fn served(host: &Host, mime: &'static str, body: Vec<u8>) -> Response<Vec<u8>> {
    with_frame_headers(host, StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .body(body)
        .expect("static response parts are valid")
}
