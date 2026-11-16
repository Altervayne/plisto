/*
 * Stream decoding in a helper process, so a decoder fault on hostile bytes ends one item instead of
 * the app. `wire` is the frame codec the main process and the helper speak over the helper's pipes;
 * `bridge` is the main process's side of one helper, `helper` and `remote_source` the helper's own,
 * and `alloc` the allocator that ends a helper cleanly at its memory cap. `file` opens a local file
 * the user opened in a helper of its own, and `inspect` reads such files' tags and covers in one.
 */

// -- Module Declarations --
pub mod alloc;
pub mod bridge;
pub mod file;
pub mod helper;
pub mod inspect;
mod remote_source;
pub mod wire;

#[cfg(test)]
pub(crate) mod test_faults;
#[cfg(test)]
mod tests;
