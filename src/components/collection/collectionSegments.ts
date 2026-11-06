/*
 * The Collection switch's segments under the app mode: which show, their counts, and which one the
 * destination lands on. Positions stay stable, so an empty Singles keeps its place dimmed rather than
 * leaving, and a remembered segment that is gone (hidden by a mode, or an unknown stored value) falls
 * back to Albums rather than a blank body.
 */

// -- State Imports --
import { COLLECTION_SEGMENTS } from "../../state/collection/store";

// -- Type Imports --
import type { CollectionSegment } from "../../state/collection/store";
import type { AppMode } from "../../state/player/store";

/** The segments each mode hides. No mode hides one today; the rule stays so the fallback has a seam. */
export const SEGMENT_HIDDEN: Record<AppMode, ReadonlySet<CollectionSegment>> = {
  both: new Set(),
  player: new Set(),
  organizer: new Set(),
};

/** The landing when the remembered segment is absent or gone. */
export const FALLBACK_SEGMENT: CollectionSegment = "albums";

/** The counts the switch shows. Browse is a way of looking, not a set, so it has none. */
export interface SegmentCounts {
  albums: number;
  singles: number;
  tracks: number;
}

/** One shown segment: its count (null for Browse) and whether it reads dimmed for being empty. */
export interface SegmentView {
  id: CollectionSegment;
  count: number | null;
  dimmed: boolean;
}

/** The segments the mode shows, in switch order. */
export function visibleSegments(
  appMode: AppMode,
  hidden: Record<AppMode, ReadonlySet<CollectionSegment>> = SEGMENT_HIDDEN,
): CollectionSegment[] {
  return COLLECTION_SEGMENTS.filter((id) => !hidden[appMode].has(id));
}

/** The switch's rows with their counts. Only an empty Singles dims; it stays clickable. */
export function segmentViews(visible: CollectionSegment[], counts: SegmentCounts): SegmentView[] {
  return visible.map((id) => {
    const count = id === "browse" ? null : counts[id];
    return { id, count, dimmed: id === "singles" && count === 0 };
  });
}

/** Whether the switch shows at all: one segment left has nothing to switch between. */
export function switchShows(visible: CollectionSegment[]): boolean {
  return visible.length > 1;
}

/** The segment to show for a stored value: itself when shown, else Albums, else the first shown. */
export function resolveSegment(
  stored: string | undefined,
  visible: CollectionSegment[],
): CollectionSegment {
  const match = visible.find((id) => id === stored);
  if (match) return match;
  if (visible.includes(FALLBACK_SEGMENT)) return FALLBACK_SEGMENT;
  return visible[0] ?? FALLBACK_SEGMENT;
}
