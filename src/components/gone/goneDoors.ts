/*
 * Where the entry points to the gone sheet lead. Only tracks the sheet can list count: an offline root's
 * tracks are kept, not gone, so a library with nothing else wrong still opens its folders.
 */

/** Where the title-bar label goes: the sheet while the library holds gone tracks, Settings otherwise. */
export function labelDoor(goneTotal: number | null): "gone" | "settings" {
  return goneTotal != null && goneTotal > 0 ? "gone" : "settings";
}

/** Whether the label's tooltip adds its "Click to review" line. Same rule as the click. */
export function showReviewHint(goneTotal: number | null): boolean {
  return labelDoor(goneTotal) === "gone";
}
