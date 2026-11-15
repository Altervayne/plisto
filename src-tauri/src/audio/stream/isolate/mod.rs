/*
 * Stream decoding in a helper process, so a decoder fault on hostile bytes ends one item instead of
 * the app. `wire` is the frame codec the main process and the helper speak over the helper's pipes.
 */

// -- Module Declarations --
pub mod wire;
