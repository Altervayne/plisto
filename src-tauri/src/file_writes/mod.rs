/*
 * The low-level layer for writing over a file in a library folder: the staging and backup names, the
 * Win32 replace that keeps the original under the backup name, free space, file attributes, the
 * in-use check against the player, the fault seam crash tests stop an operation with, the Opus
 * trim in place built on them, and the listing and expiry of the backups it keeps.
 */

pub mod attrs;
#[cfg(windows)]
pub mod backups;
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
