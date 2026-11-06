// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { routePanes, useCollectionStore } from "./store";
import { PREF_KEYS, usePreferencesStore } from "../preferences/store";
import type { CollectionPanes } from "./store";

vi.mock("../../lib/ipc", () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
}));

const CLOSED: CollectionPanes = { drawerAlbumId: null, fullAlbumId: null, handoff: null };

beforeEach(() => {
  useCollectionStore.setState(CLOSED);
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
