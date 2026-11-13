/*
 * Plugin system foundations: on-disk locations, the strict manifest parser and its sidebar
 * declaration, and the frame host that serves plugin pages. Everything here is pure or takes the
 * directory it reads from, except the WebView2 binding of the frame host.
 */

// Nothing outside this module calls into it yet, so most items are unused.
#![allow(dead_code)]

pub(crate) mod frame_host;
#[cfg(test)]
mod frame_host_guards;
#[cfg(windows)]
pub(crate) mod frame_host_win;
pub(crate) mod icon;
pub(crate) mod manifest;
pub(crate) mod paths;
pub(crate) mod semver;
pub(crate) mod sidebar_decl;
