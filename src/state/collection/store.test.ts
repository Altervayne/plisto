// -- Test Imports --
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import {
  ALL_KINDS,
  FOCUS_PERSIST_MS,
  normalizeBrowseBy,
  parseAlbumId,
  routePanes,
  toggleKind,
  useCollectionStore,
} from "./store";
import { PREF_KEYS, usePreferencesStore } from "../preferences/store";
import type { CollectionPanes } from "./store";

vi.mock("../../lib/ipc", () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
}));

const CLOSED: CollectionPanes = { drawerAlbumId: null, fullAlbumId: null, handoff: null };

beforeEach(() => {
  useCollectionStore.setState({ ...CLOSED, browseKinds: ALL_KINDS, browseFocusId: null });
  usePreferencesStore.setState({ values: {} });
});

describe("routePanes", () => {
  it("leaves the panes alone for a bare segment", () => {
    const open = { ...CLOSED, drawerAlbumId: 4 };
    expect(routePanes(open, { segment: "tracks" })).toBe(open);
  });

  it("opens a full pane and closes the drawer", () => {
    const open = { ...CLOSED, drawerAlbumId: 4 };
    expect(routePanes(open, { segment: "albums", full: 9 })).toEqual({
      ...CLOSED,
      fullAlbumId: 9,
    });
  });

  it("opens a drawer and closes the full pane", () => {
    const open = { ...CLOSED, fullAlbumId: 9 };
    expect(routePanes(open, { segment: "albums", drawer: 4 })).toEqual({
      ...CLOSED,
      drawerAlbumId: 4,
    });
  });

  it("closes the drawer on null and keeps a full pane", () => {
    const open = { ...CLOSED, drawerAlbumId: 4, fullAlbumId: 9 };
    expect(routePanes(open, { segment: "singles", drawer: null })).toEqual({
      ...CLOSED,
      fullAlbumId: 9,
    });
  });

  it("queues a hand-off", () => {
    const handoff = { albumId: 3, how: "select" as const };
    expect(routePanes(CLOSED, { segment: "albums", handoff }).handoff).toEqual(handoff);
  });
});

describe("route", () => {
  it("remembers the routed segment", () => {
    useCollectionStore.getState().route({ segment: "singles", drawer: 7 });
    expect(usePreferencesStore.getState().values[PREF_KEYS.collectionSegment]).toBe("singles");
    expect(useCollectionStore.getState().drawerAlbumId).toBe(7);
  });

  it("lets a later deep link override the remembered segment", () => {
    useCollectionStore.getState().route({ segment: "browse" });
    useCollectionStore.getState().route({ segment: "albums", full: 2 });
    expect(usePreferencesStore.getState().values[PREF_KEYS.collectionSegment]).toBe("albums");
    expect(useCollectionStore.getState().fullAlbumId).toBe(2);
  });
});

describe("toggleKind", () => {
  it("turns a chip off while the other stays on", () => {
    expect(toggleKind(ALL_KINDS, "singles")).toEqual({ albums: true, singles: false });
  });

  it("keeps the last chip on", () => {
    const albumsOnly = { albums: true, singles: false };
    expect(toggleKind(albumsOnly, "albums")).toBe(albumsOnly);
  });

  it("turns a chip back on", () => {
    expect(toggleKind({ albums: true, singles: false }, "singles")).toEqual(ALL_KINDS);
  });
});

describe("normalizeBrowseBy", () => {
  it("reads a known grouping", () => {
    expect(normalizeBrowseBy("genre")).toBe("genre");
  });

  it("reads absent or unknown as None", () => {
    expect(normalizeBrowseBy(undefined)).toBe("none");
    expect(normalizeBrowseBy("label")).toBe("none");
  });
});

describe("parseAlbumId", () => {
  it("reads a positive integer", () => {
    expect(parseAlbumId("42")).toBe(42);
  });

  it("rejects anything else", () => {
    expect(parseAlbumId(undefined)).toBeNull();
    expect(parseAlbumId("0")).toBeNull();
    expect(parseAlbumId("-3")).toBeNull();
    expect(parseAlbumId("4.5")).toBeNull();
    expect(parseAlbumId("x")).toBeNull();
  });
});

describe("focusBrowse", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("holds the focus at once and writes the pref only once it rests", () => {
    const { focusBrowse } = useCollectionStore.getState();
    focusBrowse(3);
    focusBrowse(4);
    expect(useCollectionStore.getState().browseFocusId).toBe(4);
    expect(usePreferencesStore.getState().values[PREF_KEYS.collectionBrowseFocus]).toBeUndefined();
    vi.advanceTimersByTime(FOCUS_PERSIST_MS);
    expect(usePreferencesStore.getState().values[PREF_KEYS.collectionBrowseFocus]).toBe("4");
  });
});