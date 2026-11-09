/*
 * Where a stage's dip is heading: the picked kind after its fallbacks, whether it can draw yet, and how
 * long the dip toward it takes. Pending cover pixels never fall back to Ridge: the target holds until
 * they land, so a cover kind never flashes Ridge on its way in. Only absent pixels fall back.
 */

// -- State Imports --
import type { DipReason } from "../../../state/player/visualizerDip";
import {
  effectiveVisualizerKind,
  needsCoverPixels,
  type VisualizerKind,
} from "../../../state/player/visualizerKind";

// -- Local Imports --
import type { CoverPixels, CoverPixelState } from "./useCoverPixels";
import type { CoverStatus } from "../../tracks/coverStatus";

export interface DipTarget {
  target: VisualizerKind;
  // False while the target draws the cover and its pixels are still on the way.
  ready: boolean;
}

/** The kind a stage dips toward for a pick, given whether WebGL failed for it and the cover pixels' state. */
export function dipTarget(picked: VisualizerKind, glFailed: boolean, pixels: CoverPixelState): DipTarget {
  const target = effectiveVisualizerKind(picked, { glFailed, coverPixels: pixels !== "absent" });
  return { target, ready: !(needsCoverPixels(target) && pixels === "pending") };
}

/** Why a stage draws something other than the pick: no cover art, or WebGL could not draw it. */
export type VisualizerFallback = "cover" | "gl";

export function fallbackOf(picked: VisualizerKind, target: VisualizerKind, glFailed: boolean): VisualizerFallback | null {
  if (target === picked) return null;
  return glFailed ? "gl" : "cover";
}

/** Whether the stored defaults are read again: they failed to load and the playing track changed. */
export function shouldRetryDefaults(status: string, prevTrackId: number, trackId: number): boolean {
  return status === "failed" && prevTrackId !== trackId;
}

/**
 * The key a stage's dip reason compares to detect a boundary: the track, split by whether the stored
 * defaults have landed, so their arrival after mount dips as a boundary. An album key flip keeps the
 * same key and reads as manual.
 */
export function boundaryKey(trackId: number, defaultsReady: boolean): number {
  return trackId * 2 + (defaultsReady ? 1 : 0);
}

/**
 * The kind a stage shows when it mounts: the target when it can draw at once, else Off. A cover kind
 * always starts from Off, whether its pixels are a cover or a seed, and rises once they land.
 */
export function mountedKind(picked: VisualizerKind): VisualizerKind {
  const { target, ready } = dipTarget(picked, false, "pending");
  return ready ? target : "off";
}

/**
 * The pixels a stage draws: the cover's while it is on hand or loading, else the seed's. An unsettled
 * cover reads as pending, never absent, so the stage never falls to Ridge in between.
 */
export function composePixels(cover: CoverPixels, seed: CoverPixels, status: CoverStatus): CoverPixels {
  if (status === "coverless") return seed;
  if (cover.state !== "absent") return cover;
  return status === "present" ? seed : { pixels: seed.pixels, state: "pending" };
}

/** The reason latched for the stage's current target, with the track it was latched on. */
export interface DipLatch {
  trackId: number;
  target: VisualizerKind;
  reason: DipReason;
}

/**
 * The reason for the dip toward `target`. A target that changes together with the track is a boundary
 * dip, any other change is manual, and an unchanged target keeps its reason, so a dip held for pixels
 * keeps the pace of the change that started it.
 */
export function dipReason(latch: DipLatch, trackId: number, target: VisualizerKind): DipReason {
  if (target === latch.target) return latch.reason;
  return trackId !== latch.trackId ? "boundary" : "manual";
}
