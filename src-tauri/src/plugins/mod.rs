/*
 * Plugin system foundations: on-disk locations, the strict manifest parser and its sidebar
 * declaration. Everything here is pure or takes the directory it reads from; no command and no
 * runtime state lives in this module.
 */

// Nothing outside this module calls into it yet, so most items are unused.
#![allow(dead_code)]

pub(crate) mod icon;
pub(crate) mod manifest;
pub(crate) mod paths;
pub(crate) mod semver;
pub(crate) mod sidebar_decl;
