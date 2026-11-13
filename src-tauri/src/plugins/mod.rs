/*
 * Plugin system foundations: on-disk locations, the strict manifest parser and its sidebar
 * declaration, the frame host that serves plugin pages, and the registry of what is installed with the
 * session marker and safe-mode flag beside it, and the installer that stages a folder or archive and
 * commits it. Everything here is pure or takes the directory it reads from, except the WebView2 binding
 * of the frame host.
 */

// Nothing outside this module calls into it yet, so most items are unused.
#![allow(dead_code)]

pub(crate) mod copy_in;
pub(crate) mod extract;
pub(crate) mod frame_host;
#[cfg(test)]
mod frame_host_guards;
#[cfg(windows)]
pub(crate) mod frame_host_win;
pub(crate) mod icon;
pub(crate) mod install;
pub(crate) mod install_error;
pub(crate) mod manifest;
pub(crate) mod paths;
pub(crate) mod registry;
pub(crate) mod revalidate;
pub(crate) mod semver;
pub(crate) mod session;
pub(crate) mod sidebar_decl;
pub(crate) mod stage;
pub(crate) mod state;
