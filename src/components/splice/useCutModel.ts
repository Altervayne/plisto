// -- Framework Imports --
import { useCallback, useMemo, useRef, useState } from "react";

// -- Local Imports --
import {
  deriveSegments,
  replaceByOrigin,
  type DerivedSegment,
  type Marker,
  type MarkerOrigin,
  type SegmentMeta,
} from "./cutModel";

// -- Type Imports --
import type { CueSheet, SilenceSpan } from "../../types";

/** The cut model's state and operations, derived from the marker list over a fixed frame timeline. */
export interface CutModel {
  markers: Marker[];
  segments: DerivedSegment[];
  addMarker: (frame: number, origin: MarkerOrigin) => void;
  removeMarker: (id: string) => void;
  moveMarker: (id: string, frame: number) => void;
  setSegmentMeta: (leadingId: string, patch: SegmentMeta) => void;
  replaceSilence: (spans: SilenceSpan[]) => void;
  replaceCue: (sheet: CueSheet, sampleRate: number) => void;
}

/**
 * Holds the marker list and per-segment metadata for one source over `totalFrames`, deriving the N+1
 * segments on every change. Marker ids come from a monotonic counter so a drag keeps its id (and its
 * metadata) stable, and deleting a divider merges its two segments by simply dropping the marker: the
 * earlier segment keeps its own leading id, so its metadata rides along untouched. Silence and cue
 * re-runs replace only their own origin, leaving manual markers in place.
 */
export function useCutModel(totalFrames: number): CutModel {
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [meta, setMeta] = useState<Map<string, SegmentMeta>>(() => new Map());
  const counter = useRef(0);
  const nextId = useCallback(() => `m${(counter.current += 1)}`, []);

  const segments = useMemo(
    () => deriveSegments(markers, totalFrames, meta),
    [markers, totalFrames, meta],
  );

  const addMarker = useCallback(
    (frame: number, origin: MarkerOrigin) => {
      const f = Math.round(frame);
      if (f <= 0 || f >= totalFrames) return;
      setMarkers((cur) =>
        cur.some((m) => m.frame === f) ? cur : [...cur, { id: nextId(), frame: f, origin }],
      );
    },
    [totalFrames, nextId],
  );

  const removeMarker = useCallback((id: string) => {
    // The removed marker's metadata is left orphaned in the map: its id is never reused, so nothing
    // reads it again, and the earlier segment keeps its own metadata under its unchanged leading id.
    setMarkers((cur) => cur.filter((m) => m.id !== id));
  }, []);

  const moveMarker = useCallback(
    (id: string, frame: number) => {
      const f = Math.min(totalFrames - 1, Math.max(1, Math.round(frame)));
      setMarkers((cur) =>
        cur.map((m) => (m.id === id ? { ...m, frame: f, origin: "manual" } : m)),
      );
    },
    [totalFrames],
  );

  const setSegmentMeta = useCallback((leadingId: string, patch: SegmentMeta) => {
    setMeta((cur) => {
      const next = new Map(cur);
      next.set(leadingId, { ...cur.get(leadingId), ...patch });
      return next;
    });
  }, []);

  const replaceSilence = useCallback(
    (spans: SilenceSpan[]) => {
      const entries = spans.map((s) => ({
        frame: Math.round((s.start_frame + s.end_frame) / 2),
      }));
      const res = replaceByOrigin(markers, meta, "silence", entries, totalFrames, nextId);
      setMarkers(res.markers);
      setMeta(res.meta);
    },
    [markers, meta, totalFrames, nextId],
  );

  const replaceCue = useCallback(
    (sheet: CueSheet, sampleRate: number) => {
      const entries = sheet.tracks.map((tr) => ({
        frame: Math.round(tr.start_secs * sampleRate),
        meta: {
          title: tr.title ?? undefined,
          artist: tr.performer ?? sheet.performer ?? undefined,
          track_no: tr.number,
        },
      }));
      const res = replaceByOrigin(markers, meta, "cue", entries, totalFrames, nextId);
      setMarkers(res.markers);
      setMeta(res.meta);
    },
    [markers, meta, totalFrames, nextId],
  );

  return {
    markers,
    segments,
    addMarker,
    removeMarker,
    moveMarker,
    setSegmentMeta,
    replaceSilence,
    replaceCue,
  };
}
