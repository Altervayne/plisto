/** Whether a track's cover is settled: still loading, known to be missing, or on hand. */
export type CoverStatus = "pending" | "coverless" | "present";

/**
 * The cover status of `trackId`. Pending until a load for this very track completes: the cover hook holds
 * the previous track's cover meanwhile, so a null cover proves nothing.
 */
export function coverStatus(
  trackId: number,
  coverFor: number | null,
  loading: boolean,
  hasCover: boolean,
): CoverStatus {
  if (coverFor !== trackId || loading) return "pending";
  return hasCover ? "present" : "coverless";
}
