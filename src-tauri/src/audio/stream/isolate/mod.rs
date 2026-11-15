/*
 * Stream decoding in a helper process, so a decoder fault on hostile bytes ends one item instead of
 * the app. `wire` is the frame codec the main process and the helper speak over the helper's pipes;
 * `bridge` is the main process's side of one helper, `helper` and `remote_source` the helper's own,
 * and `alloc` the allocator that ends a helper cleanly at its memory cap.
 */

// -- Module Declarations --
pub mod alloc;
pub mod bridge;
pub mod helper;
mod remote_source;
pub mod wire;

#[cfg(test)]
mod test_faults;
#[cfg(test)]
mod tests;
