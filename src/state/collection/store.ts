/*
 * The Collection destination's store: which segment shows, which album holds the drawer or the full
 * pane, and a pending hand-off for the album wall to land. The segment itself lives in the pref cache,
 * so the last one survives a relaunch; the open panes are session state. Every way into the
 * destination goes through `route`, which names its segment explicitly, so a deep link always
 * overrides the remembered segment and then becomes it.
 */

// -- Library Imports --
import { create } from "zustand";

// -- State Imports --
import { PREF_KEYS, usePreference, usePreferencesStore, useSetPreference } from "../preferences/store";

/** The four ways of looking at the collection, in switch order. */
export type CollectionSegment = "browse" | "albums" | "singles" | "tracks";

export const COLLECTION_SEGMENTS: readonly CollectionSegment[] = [
  "browse",
  "albums",
  "singles",
  "tracks",
];

/** An album the wall should land on: opened in its drawer, or pre-ticked with the bar up. */
export interface CollectionHandoff {
  albumId: number;
  how: "open" | "select";
}

/**
 * A route into the Collection. `drawer` opens that album's drawer (null closes any drawer), `full`
 * opens an album's full pane, and `handoff` queues a landing for the wall. Fields left out keep the
 * panes as they are.
 */
export interface CollectionTarget {
  segment: CollectionSegment;
  drawer?: number | null;
  full?: number;
  handoff?: CollectionHandoff;
}

/** The session panes a route moves. */
export interface CollectionPanes {
  drawerAlbumId: number | null;
  fullAlbumId: number | null;
  handoff: CollectionHandoff | null;
}

/**
 * The panes after a route. The drawer and the full pane never show at once, so opening one closes the
 * other; closing the drawer leaves a full pane on the Albums segment alone.
 */
export function routePanes(panes: CollectionPanes, target: CollectionTarget): CollectionPanes {
  let next = panes;
  if (target.full !== undefined) {
    next = { ...next, drawerAlbumId: null, fullAlbumId: target.full };
  } else if (target.drawer !== undefined) {
    next = {
      ...next,
      drawerAlbumId: target.drawer,
      fullAlbumId: target.drawer == null ? next.fullAlbumId : null,
    };
  }
  if (target.handoff) next = { ...next, handoff: target.handoff };
  return next;
}

interface CollectionStore extends CollectionPanes {
  route: (target: CollectionTarget) => void;
  setDrawerAlbumId: (albumId: number | null) => void;
  openFull: (albumId: number) => void;
  closeFull: () => void;
  clearHandoff: () => void;
}

export const useCollectionStore = create<CollectionStore>((set) => ({
  drawerAlbumId: null,
  fullAlbumId: null,
  handoff: null,

  route: (target) => {
    usePreferencesStore.getState().setPreference(PREF_KEYS.collectionSegment, target.segment);
    set((s) => routePanes(s, target));
  },
  setDrawerAlbumId: (drawerAlbumId) => set({ drawerAlbumId }),
  openFull: (fullAlbumId) => set({ fullAlbumId, drawerAlbumId: null }),
  closeFull: () => set({ fullAlbumId: null }),
  clearHandoff: () => set({ handoff: null }),
}));

// -- Selectors (narrow: one value or one stable action each) --

/** The stored segment as written, unresolved: absent on first run, and untrusted like any pref. */
export const useStoredCollectionSegment = (): string | undefined =>
  usePreference(PREF_KEYS.collectionSegment);

export const useCollectionDrawerAlbumId = (): number | null =>
  useCollectionStore((s) => s.drawerAlbumId);
export const useCollectionFullAlbumId = (): number | null =>
  useCollectionStore((s) => s.fullAlbumId);
export const useCollectionHandoff = (): CollectionHandoff | null =>
  useCollectionStore((s) => s.handoff);

export const useRouteCollection = (): ((target: CollectionTarget) => void) =>
  useCollectionStore((s) => s.route);
export const useSetCollectionDrawer = (): ((albumId: number | null) => void) =>
  useCollectionStore((s) => s.setDrawerAlbumId);
export const useOpenCollectionFull = (): ((albumId: number) => void) =>
  useCollectionStore((s) => s.openFull);
export const useCloseCollectionFull = (): (() => void) => useCollectionStore((s) => s.closeFull);
export const useClearCollectionHandoff = (): (() => void) =>
  useCollectionStore((s) => s.clearHandoff);

/** Whether the one-time Browse hint has been retired, by its dismiss or by entering Browse. */
export const useBrowseHintSeen = (): boolean => usePreference(PREF_KEYS.collectionBrowseHint) === "1";

/** Retires the Browse hint for good. */
export const useRetireBrowseHint = (): (() => void) => {
  const setPreference = useSetPreference();
  return () => setPreference(PREF_KEYS.collectionBrowseHint, "1");
};
