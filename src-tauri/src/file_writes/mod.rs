/*
 * The low-level layer for writing over a file in a library folder: the staging and backup names, the
 * Win32 replace that keeps the original under the backup name, free space, file attributes, the
 * in-use check against the player, the fault seam crash tests stop an operation with, and the Opus
 * trim in place built on them.
 */

pub mod attrs;
pub mod fault;
pub mod in_use;
pub mod names;
#[cfg(windows)]
pub mod recover;
#[cfg(windows)]
pub mod replace;
#[cfg(windows)]
pub mod settle;
#[cfg(windows)]
pub mod space;
#[cfg(windows)]
pub mod trim;
