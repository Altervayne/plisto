/*
 * The pure rules behind relocating a moved root: which roots can be located, whether adding a folder
 * needs the relink check, and which relink candidate to offer. Kept free of the store so each rule is
 * tested on its own. The match thresholds live in the backend; nothing here recomputes them.
 */

// -- Type Imports --
import type { RelinkCandidate, RelocateOutcome, Root } from "../types";

/** A folder the user just picked that looks like a moved root, held until they choose what to do. */
export interface RelinkOffer {
  path: string;
  candidate: RelinkCandidate;
}

/**
 * The result of a relocate as the store reports it: the backend's outcome, plus the two ways the call
 * itself can fail. Busy means a scan holds the lock; failed means the rescan after the commit broke.
 */
export type RelocateResult = RelocateOutcome | { kind: "busy" } | { kind: "failed" };

/** Whether a root offers Locate: it is offline, or every one of its tracks is gone. */
export function locateEligible(root: Root, offlineIds: number[]): boolean {
  if (offlineIds.includes(root.id)) return true;
  return root.track_count > 0 && root.missing_count === root.track_count;
}

/** Whether adding a folder should first ask the backend if it is a moved root. */
export function needsRelinkCheck(roots: Root[], offlineIds: number[]): boolean {
  return roots.some((root) => locateEligible(root, offlineIds));
}

/**
 * The candidate to offer: the best matched fraction. Null when there is none, or when the top two tie,
 * since the app never picks between equally good roots on the user's behalf.
 */
export function bestCandidate(cands: RelinkCandidate[]): RelinkCandidate | null {
  if (cands.length === 0) return null;
  // Cross-multiplied, so equal fractions compare equal without float rounding. A zero sample has matched nothing, so it never divides.
  const beats = (a: RelinkCandidate, b: RelinkCandidate): number =>
    a.matched * (b.sampled || 1) - b.matched * (a.sampled || 1);
  const ranked = [...cands].sort((a, b) => beats(b, a));
  if (ranked.length > 1 && beats(ranked[0], ranked[1]) === 0) return null;
  return ranked[0];
}
