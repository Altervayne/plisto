/*
 * The Collection destination's store: which segment shows, which album holds the drawer or the full
 * pane, and a pending hand-off for the album wall to land. The segment itself lives in the pref cache,
 * so the last one survives a relaunch; the open panes are session state. Every way into the
 * destination goes through `route`, which names its segment explicitly, so a deep link always
 * overrides the remembered segment and then becomes it.
 *
 * Browse keeps three more things here: its grouping (a pref), the Albums/Singles chips (session only)
 * and the focused album id, held in the session and written to its pref once the focus rests, so a
 * held arrow key never writes on every step.
 */

// -- Library Imports --
import { create } from "zustand";

// -- State Imports --
import { PREF_KEYS, usePreference, usePreferencesStore, useSetPreference } from "../preferences/store";

// -- Unit Imports --
import { BROWSE_BYS } from "../../components/collection/browse/browseOrder";

// -- Type Imports --
import type { BrowseBy, BrowseKinds } from "../../components/collection/browse/browseOrder";

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

export const ALL_KINDS: BrowseKinds = { albums: true, singles: true };

/** Flips one Browse chip. The last chip on stays on, so the shelf never filters itself empty. */
export function toggleKind(kinds: BrowseKinds, kind: keyof BrowseKinds): BrowseKinds {
  const other = kind === "albums" ? "singles" : "albums";
  if (kinds[kind] && !kinds[other]) return kinds;
  return { ...kinds, [kind]: !kinds[kind] };
}

/** A stored grouping, untrusted like any pref; anything unknown reads None. */
export function normalizeBrowseBy(stored: string | undefined): BrowseBy {
  return BROWSE_BYS.find((by) => by === stored) ?? "none";
}

/** A stored album id, or null when absent or not a positive integer. */
export function parseAlbumId(stored: string | undefined): number | null {
  if (stored === undefined || !/^\d+$/.test(stored)) return null;
  const id = Number(stored);
  return id > 0 ? id : null;
}

/** How long Browse's focus must rest before it is written to its pref. */
export const FOCUS_PERSIST_MS = 600;

let focusPersistTimer: ReturnType<typeof setTimeout> | null = null;

interface CollectionStore extends CollectionPanes {
  browseKinds: BrowseKinds;
  // Null until Browse moves in this session; the stored pref answers until then.
  browseFocusId: number | null;

  route: (target: CollectionTarget) => void;
  setDrawerAlbumId: (albumId: number | null) => void;
  openFull: (albumId: number) => void;
  closeFull: () => void;
  clearHandoff: () => void;
  toggleBrowseKind: (kind: keyof BrowseKinds) => void;
  focusBrowse: (albumId: number) => void;
}

export const useCollectionStore = create<CollectionStore>((set) => ({
  drawerAlbumId: null,
  fullAlbumId: null,
  handoff: null,
  browseKinds: ALL_KINDS,
  browseFocusId: null,

  route: (target) => {
    usePreferencesStore.getState().setPreference(PREF_KEYS.collectionSegment, target.segment);
    set((s) => routePanes(s, target));
  },
  setDrawerAlbumId: (drawerAlbumId) => set({ drawerAlbumId }),
  openFull: (fullAlbumId) => set({ fullAlbumId, drawerAlbumId: null }),
  closeFull: () => set({ fullAlbumId: null }),
  clearHandoff: () => set({ handoff: null }),
  toggleBrowseKind: (kind) => set((s) => ({ browseKinds: toggleKind(s.browseKinds, kind) })),
  focusBrowse: (albumId) => {
    set({ browseFocusId: albumId });
    if (focusPersistTimer !== null) clearTimeout(focusPersistTimer);
    focusPersistTimer = setTimeout(() => {
      focusPersistTimer = null;
      usePreferencesStore
        .getState()
        .setPreference(PREF_KEYS.collectionBrowseFocus, String(albumId));
    }, FOCUS_PERSIST_MS);
  },
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

/** Browse's grouping, from its pref. */
export const useBrowseGroupBy = (): BrowseBy =>
  normalizeBrowseBy(usePreference(PREF_KEYS.collectionBrowseGroup));

/** Persists Browse's grouping. */
export const useSetBrowseGroupBy = (): ((by: BrowseBy) => void) => {
  const setPreference = useSetPreference();
  return (by) => setPreference(PREF_KEYS.collectionBrowseGroup, by);
};

export const useBrowseKinds = (): BrowseKinds => useCollectionStore((s) => s.browseKinds);
export const useToggleBrowseKind = (): ((kind: keyof BrowseKinds) => void) =>
  useCollectionStore((s) => s.toggleBrowseKind);

/** The album Browse focuses: this session's last focus, else the one stored from a past session. */
export const useBrowseFocusId = (): number | null => {
  const session = useCollectionStore((s) => s.browseFocusId);
  const stored = usePreference(PREF_KEYS.collectionBrowseFocus);
  return session ?? parseAlbumId(stored);
};

export const useFocusBrowse = (): ((albumId: number) => void) =>
  useCollectionStore((s) => s.focusBrowse);

/** Whether the one-time Browse hint has been retired, by its dismiss or by entering Browse. */
export const useBrowseHintSeen = (): boolean => usePreference(PREF_KEYS.collectionBrowseHint) === "1";

/** Retires the Browse hint for good. */
export const useRetireBrowseHint = (): (() => void) => {
  const setPreference = useSetPreference();
  return () => setPreference(PREF_KEYS.collectionBrowseHint, "1");
};
