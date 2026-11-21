/*
 * The visualizer host: `https://pv-<hash>.invalid/<path>`, the URL a plugin's visualizer frames
 * load from. It serves the same plugin folder as the page host under the same rules, on a label of
 * its own, so a visualizer is another site than the plugin's pages and runs in its own renderer
 * process. Its policy is the frame policy plus blob workers and WebAssembly, which let a frame run
 * code built from data rather than only its installed files; no page frame gets either. It also
 * serves Plisto's visualizer runtime and shader page under `/_plisto/vis/1/`.
 */

// -- Library Imports --
use std::fmt;
use std::path::Path;

// -- Local Imports --
use super::{label_on, parse_on, Host, HOST_SUFFIX, SCHEME_PREFIX};
use crate::plugins::frame_host_files::vis_host_file;
use crate::plugins::paths::{plugin_dir, validate_id};
use crate::plugins::summary::read_manifest;

/// The request pattern the webview routes to the visualizer host.
pub const VIS_FILTER: &str = "https://pv-*.invalid/*";

// The frame policy with WebAssembly compilation and blob workers. A worker cannot load from the
// frame's own host, whose origin is opaque to it, so `blob:` is the only route to one.
pub const VIS_CSP: &str = "sandbox allow-scripts; default-src 'none'; \
    script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; \
    img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src blob:";

/// The host a plugin's visualizer frames load from.
pub(super) static VIS_HOST: Host = Host {
    prefix: "pv-",
    csp: VIS_CSP,
    files: vis_host_file,
};

// The served page that runs a shader kind; the kind's shader file rides in its query.
const SHADER_PAGE: &str = "_plisto/vis/1/shader.html";

/// The base URL a plugin's visualizer frames load from, with its trailing slash.
pub fn vis_url(id: &str) -> String {
    format!("{SCHEME_PREFIX}{}{HOST_SUFFIX}/", label_on(&VIS_HOST, id))
}

/// Splits a visualizer host URL into its label and its path (still percent-encoded, query dropped).
pub fn parse_vis_url(uri: &str) -> Option<(&str, &str)> {
    parse_on(&VIS_HOST, uri)
}

/// Why a visualizer kind has no URL.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KindUrlError {
    /// Not a valid id, not installed, not enabled, or without a readable manifest.
    UnknownPlugin,
    /// The plugin declares no visualizer with that id.
    UnknownKind,
}

impl fmt::Display for KindUrlError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            KindUrlError::UnknownPlugin => write!(f, "no enabled plugin has that id"),
            KindUrlError::UnknownKind => {
                write!(f, "the plugin declares no visualizer with that id")
            }
        }
    }
}

/// The URL one declared visualizer kind of an enabled plugin loads: its page, or the shader page
/// with the kind's shader file in the query. A manifest path holds only letters, digits, `.`, `_`,
/// `-` and `/`, so neither needs escaping. The shader path is relative to the plugin root, not
/// to the shader page's folder; the runtime resolves it against `/`.
pub fn kind_url(
    app_data: &Path,
    id: &str,
    kind: &str,
    enabled: &dyn Fn(&str) -> bool,
) -> Result<String, KindUrlError> {
    if validate_id(id).is_err() || !enabled(id) {
        return Err(KindUrlError::UnknownPlugin);
    }
    let manifest = read_manifest(&plugin_dir(app_data, id)).ok_or(KindUrlError::UnknownPlugin)?;
    let decl = manifest
        .visualizers
        .iter()
        .find(|decl| decl.id == kind)
        .ok_or(KindUrlError::UnknownKind)?;
    let base = vis_url(id);
    Ok(match (&decl.page, &decl.shader) {
        (Some(page), _) => format!("{base}{page}"),
        (None, shader) => {
            let shader = shader.as_deref().unwrap_or_default();
            format!("{base}{SHADER_PAGE}?shader={shader}")
        }
    })
}

#[cfg(test)]
mod tests;
