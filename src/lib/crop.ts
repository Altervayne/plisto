/*
 * The cropper's pure trim math: derive the two trim points from a file's silence spans, widen the
 * kept region by a padding, and read a source path's stem. Frame-based and deterministic, so it drives
 * the two-handle body and unit-tests without a decoder. The cropper is a splice with one segment; this
 * is the segment's own arithmetic, kept out of the view.
 */

// -- Type Imports --
import type { SilenceSpan } from "../types";

/** The two trim points over a fixed frame timeline: the head in-point and the tail out-point. */
export interface CropBase {
  inFrame: number;
  outFrame: number;
}

/** The effective kept range a cut writes: the base widened by the padding and clamped to the file. */
export interface CropRange {
  in: number;
  out: number;
}

/**
 * The trim points a file opens on, read from its silence spans (ordered, ascending). The head in-point
 * is the end of the leading span only when that span touches frame 0; the tail out-point is the start
 * of the trailing span only when it touches the end. A file with lead-in and lead-out silence opens
 * already trimmed; one without opens at the full range, nothing to trim. `epsilonFrames` is the slack
 * for "touches the edge". A degenerate result (head at or past tail) falls back to the whole file.
 */
export function detectTrim(
  spans: SilenceSpan[],
  totalFrames: number,
  epsilonFrames: number,
): CropBase {
  let inFrame = 0;
  let outFrame = totalFrames;
  if (spans.length > 0) {
    const first = spans[0];
    if (first.start_frame <= epsilonFrames) {
      inFrame = Math.min(Math.max(0, first.end_frame), totalFrames);
    }
    const last = spans[spans.length - 1];
    if (last.end_frame >= totalFrames - epsilonFrames) {
      outFrame = Math.max(Math.min(totalFrames, last.start_frame), 0);
    }
  }
  if (inFrame >= outFrame) return { inFrame: 0, outFrame: totalFrames };
  return { inFrame, outFrame };
}

/** A padding in milliseconds as whole frames at the sample rate. Never negative. */
export function paddingFrames(paddingMs: number, sampleRate: number): number {
  if (paddingMs <= 0 || sampleRate <= 0) return 0;
  return Math.round((paddingMs / 1000) * sampleRate);
}

/**
 * The effective kept range: the base pushed outward by `pad` frames on both ends, clamped to
 * [0, totalFrames]. Padding leaves a lead-in before the attack and a tail after the release, so a
 * trimmed cut does not clip; it only ever widens the kept region, never narrows it.
 */
export function applyPadding(base: CropBase, pad: number, totalFrames: number): CropRange {
  return {
    in: Math.max(0, base.inFrame - pad),
    out: Math.min(totalFrames, base.outFrame + pad),
  };
}

/** Whether a range actually trims anything: it drops head, tail, or both against the full file. */
export function trimsAnything(range: CropRange, totalFrames: number): boolean {
  return range.in > 0 || range.out < totalFrames;
}

/**
 * The filename stem of a source path: its last component with the extension dropped, tolerant of
 * either separator. It seeds the cut's name so a trimmed file keeps the source's own name.
 */
export function sourceStem(path: string): string {
  const norm = path.replace(/[\\/]+$/, "");
  const cut = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
  const base = cut >= 0 ? norm.slice(cut + 1) : norm;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}
