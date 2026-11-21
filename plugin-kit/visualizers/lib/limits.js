// A generated copy of a Plisto source file; do not edit.
/*
 * The limits a plugin visualizer's stage nets enforce, in one place. A frame that does not answer within the
 * hang limit is a hang; a frame whose median step cost stays over the slow-frame limit across the slow-frame
 * span is too slow to keep.
 */
/** A mount that gives no sign of life for this long is hung. */
export const HANG_LIMIT_MS = 2000;
/** The median step cost, in ms, a mount may not stay over for SLOW_SPAN_MS. */
export const SLOW_FRAME_LIMIT_MS = 50;
/** The span the slow-frame median is taken over. */
export const SLOW_SPAN_MS = 5000;
/** The flash-meter limit of the same name in Plisto. */
export const FLASHES_PER_SEC_LIMIT = 3;
/** The flash-meter limit of the same name in Plisto. */
export const RED_FLASHES_LIMIT = 0;
