// -- Framework Imports --
import { useCallback, useEffect, useMemo, useState } from "react";

// -- State Imports --
import { useTracks } from "../../state/store";
import { useAlbumIndex } from "../../state/organize/store";
import { usePlaylistsStore } from "../../state/playlists/store";
import {
  useDismissalsLoaded,
  useDuplicates,
  useLoadDismissals,
} from "../../state/duplicates/store";

// -- Hook Imports --
import { usePlayCounts } from "./usePlayCounts";

// -- IPC Imports --
import { undismissDuplicates } from "../../lib/ipc";

// -- Utils Imports --
import { countPlaylistsByTrack, describeCopy } from "./copyFacts";

// -- Type Imports --
import type { CopyFacts } from "./copyFacts";
import type { DuplicateGroup } from "../../state/duplicates/findDuplicates";
import type { MergeReceipt, TrackRow } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

/** A set just merged: the group as it stood, and what the receipt line names. */
interface Landed {
  group: DuplicateGroup;
  receipt: MergeReceipt;
  filename: string;
}

/** One card in the list: a live set, or a set just merged and collapsed to its receipt. */
export type ReviewItem =
  | { kind: "set"; group: DuplicateGroup; copies: CopyFacts[] }
  | ({ kind: "merged" } & Landed);

/**
 * The duplicates sheet's model. Reads the dismissed pairs on open, derives the sets from the live
 * library, and holds each merged set's receipt so its line stays in place after the set itself drops
 * out. A merged set whose group shows again, undone from anywhere, gives its place back to the group.
 */
export function useDuplicatesReview() {
  const t = useT();
  const loadDismissals = useLoadDismissals();
  const loaded = useDismissalsLoaded();
  const { groups, dismissed } = useDuplicates();
  const tracks = useTracks();
  const albumIndex = useAlbumIndex();
  const slots = usePlaylistsStore((s) => s.tracks);
  const plays = usePlayCounts();
  const [landed, setLanded] = useState<Map<string, Landed>>(() => new Map());

  useEffect(() => {
    void loadDismissals();
  }, [loadDismissals]);

  const single = t((d) => d.singles.marker);
  const unsorted = t((d) => d.home.unsortedLabel);
  const untitled = t((d) => d.albums.untitled);

  const items = useMemo<ReviewItem[]>(() => {
    const byId = new Map<number, TrackRow>(tracks.map((track) => [track.id, track]));
    const playlistsByTrack = countPlaylistsByTrack(slots);
    const labels = { single, unsorted, untitled };
    const live: ReviewItem[] = groups.map((group) => {
      const identical = new Set(group.identicalIds);
      const ctx = { albumIndex, playlistsByTrack, plays, labels, identical };
      const copies = group.trackIds
        .map((id) => byId.get(id))
        .filter((track): track is TrackRow => track != null)
        .map((track) => describeCopy(track, ctx));
      return { kind: "set", group, copies };
    });
    const shown = new Set(groups.map((g) => g.key));
    const merged: ReviewItem[] = [...landed.values()]
      .filter((entry) => !shown.has(entry.group.key))
      .map((entry) => ({ kind: "merged", ...entry }));
    return [...live, ...merged].sort((a, b) =>
      a.group.sortKey < b.group.sortKey ? -1 : a.group.sortKey > b.group.sortKey ? 1 : 0,
    );
  }, [groups, landed, tracks, slots, albumIndex, plays, single, unsorted, untitled]);

  // A group back on screen retires its receipt, so a later collapse never revives a stale line.
  useEffect(() => {
    const shown = new Set(groups.map((g) => g.key));
    setLanded((prev) => {
      if (![...prev.keys()].some((key) => shown.has(key))) return prev;
      return new Map([...prev].filter(([key]) => !shown.has(key)));
    });
  }, [groups]);

  const markMerged = useCallback((group: DuplicateGroup, receipt: MergeReceipt, filename: string) => {
    setLanded((prev) => new Map(prev).set(group.key, { group, receipt, filename }));
  }, []);

  const dropMerged = useCallback((key: string) => {
    setLanded((prev) => {
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  }, []);

  const restore = useCallback(
    async (group: DuplicateGroup) => {
      await undismissDuplicates(group.trackIds);
      await loadDismissals();
    },
    [loadDismissals],
  );

  const files = groups.reduce((sum, g) => sum + g.trackIds.length, 0);

  return { loaded, items, dismissed, sets: groups.length, files, markMerged, dropMerged, restore };
}
