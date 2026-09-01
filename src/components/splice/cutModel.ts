/*
 * The cut model: N markers over a fixed frame timeline yield N+1 segments, marker i-1 leading
 * segment i and a START sentinel leading the first. Per-segment metadata is keyed by the leading
 * marker id, not the segment index, so a title stays attached to its segment as other markers move.
 * These are the pure operations behind the useCutModel hook; the hook holds the state and generates
 * the ids.
 */

// -- Type Imports --
import type { Segment } from "../../types";

/** How a marker was placed. A dragged auto marker is promoted to manual, so a re-run leaves it be. */
export type MarkerOrigin = "manual" | "silence" | "cue";

/** One divider on the timeline: a stable id, a frame, and its origin. Markers are unique per frame. */
export interface Marker {
  id: string;
  frame: number;
  origin: MarkerOrigin;
}

/** The tags a segment carries into its cut. Absent fields fall back at projection time. */
export interface SegmentMeta {
  title?: string;
  artist?: string;
  track_no?: number;
}

/** One derived segment: its leading marker id, its half-open frame range, and its resolved metadata. */
export interface DerivedSegment {
  id: string;
  start: number;
  end: number;
  meta: SegmentMeta;
  // The origin of the leading marker, for the row's source micro-label. Absent for the first segment,
  // which no marker leads.
  leadingOrigin?: MarkerOrigin;
}

/** The leading id of the first segment, before marker 0. */
export const START_ID = "START";

/**
 * The derived segments as splice-job segments: each half-open frame range paired with the tags its
 * cut carries, an absent field passing as null. The order is the segment order, which numbers the
 * output when a segment holds no track number of its own.
 */
export function toJobSegments(segments: DerivedSegment[]): Segment[] {
  return segments.map((s) => ({
    start_frame: s.start,
    end_frame: s.end,
    title: s.meta.title ?? null,
    artist: s.meta.artist ?? null,
    track_no: s.meta.track_no ?? null,
  }));
}

/** Markers sorted by frame, dropping any that repeat a frame already taken (first inserted wins). */
export function sortMarkers(markers: Marker[]): Marker[] {
  const byFrame = [...markers].sort((a, b) => a.frame - b.frame);
  const out: Marker[] = [];
  let last = Number.NaN;
  for (const m of byFrame) {
    if (m.frame === last) continue;
    out.push(m);
    last = m.frame;
  }
  return out;
}

/**
 * The N+1 segments over [0, totalFrames). Markers are sorted and clamped to the interior, then each
 * carves a boundary; segment i is led by the marker before it (START before marker 0) and reads its
 * metadata by that leading id.
 */
export function deriveSegments(
  markers: Marker[],
  totalFrames: number,
  meta: Map<string, SegmentMeta>,
): DerivedSegment[] {
  const interior = sortMarkers(markers).filter((m) => m.frame > 0 && m.frame < totalFrames);
  const segments: DerivedSegment[] = [];
  let start = 0;
  let leadId = START_ID;
  let leadOrigin: MarkerOrigin | undefined;
  for (const m of interior) {
    segments.push({
      id: leadId,
      start,
      end: m.frame,
      meta: meta.get(leadId) ?? {},
      leadingOrigin: leadOrigin,
    });
    start = m.frame;
    leadId = m.id;
    leadOrigin = m.origin;
  }
  segments.push({
    id: leadId,
    start,
    end: totalFrames,
    meta: meta.get(leadId) ?? {},
    leadingOrigin: leadOrigin,
  });
  return segments;
}

/** The metadata map narrowed to keys still in play: START plus each live marker id. */
export function pruneMeta(
  meta: Map<string, SegmentMeta>,
  markers: Marker[],
): Map<string, SegmentMeta> {
  const live = new Set<string>([START_ID, ...markers.map((m) => m.id)]);
  const out = new Map<string, SegmentMeta>();
  for (const [k, v] of meta) if (live.has(k)) out.set(k, v);
  return out;
}

/** One fresh marker for a source replace: a frame, plus the metadata for the segment it leads. */
export interface ReplaceEntry {
  frame: number;
  meta?: SegmentMeta;
}

/**
 * Replaces every marker of `origin` with a fresh set while leaving markers of other origins alone, so
 * manual placements (and dragged auto markers, promoted to manual) survive a re-run. An entry's
 * metadata lands on the segment its marker leads; an entry at or before the start seeds the START
 * segment instead of a marker (the implicit first cut). Frames out of the interior are dropped.
 */
export function replaceByOrigin(
  markers: Marker[],
  meta: Map<string, SegmentMeta>,
  origin: MarkerOrigin,
  entries: ReplaceEntry[],
  totalFrames: number,
  nextId: () => string,
): { markers: Marker[]; meta: Map<string, SegmentMeta> } {
  const kept = markers.filter((m) => m.origin !== origin);
  const nextMeta = pruneMeta(meta, kept);
  const added: Marker[] = [];
  for (const entry of entries) {
    const frame = Math.round(entry.frame);
    if (frame <= 0) {
      // The implicit first cut: its metadata is the START segment's, no marker placed.
      if (entry.meta) nextMeta.set(START_ID, entry.meta);
      continue;
    }
    if (frame >= totalFrames) continue;
    const marker: Marker = { id: nextId(), frame, origin };
    added.push(marker);
    if (entry.meta) nextMeta.set(marker.id, entry.meta);
  }
  return { markers: [...kept, ...added], meta: nextMeta };
}
