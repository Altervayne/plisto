// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import {
  albumKeyOf,
  applyManualPick,
  clearDefaultTier,
  defaultActions,
  placeOf,
  resolveVisualizer,
  storedDefaultsOf,
  writeEndsOverride,
  type ResolveInput,
  type TrackPlace,
} from "./visualizerResolve";

const ALBUM_KEY = "album:7";
const filed: TrackPlace = { kind: "album", trackId: 3, albumId: 7 };
const single: TrackPlace = { kind: "single", trackId: 4, albumId: 8 };
const loose: TrackPlace = { kind: "loose", trackId: 5 };
const adhoc: TrackPlace = { kind: "adhoc" };

function input(patch: Partial<ResolveInput> = {}): ResolveInput {
  return { global: "ridge", trackDefault: null, albumDefault: null, override: null, albumKey: ALBUM_KEY, ...patch };
}

describe("resolveVisualizer", () => {
  it("draws the global pick with no default", () => {
    expect(resolveVisualizer(input())).toEqual({
      picked: "ridge",
      source: "global",
      defaultKind: null,
      defaultTier: null,
    });
  });

  it("follows an album default", () => {
    expect(resolveVisualizer(input({ albumDefault: "nebula" }))).toEqual({
      picked: "nebula",
      source: "album",
      defaultKind: "nebula",
      defaultTier: "album",
    });
  });

  it("lets a track default win over an album default", () => {
    expect(resolveVisualizer(input({ albumDefault: "nebula", trackDefault: "terrain" }))).toEqual({
      picked: "terrain",
      source: "track",
      defaultKind: "terrain",
      defaultTier: "track",
    });
  });

  it("draws an override over the album default and reports the default set aside", () => {
    const res = resolveVisualizer(input({ albumDefault: "nebula", override: { kind: "bloom", albumKey: ALBUM_KEY } }));
    expect(res).toEqual({ picked: "bloom", source: "override", defaultKind: "nebula", defaultTier: "album" });
  });

  it("falls through an unknown or empty stored string to the next tier", () => {
    expect(resolveVisualizer(input({ trackDefault: "aurora-x", albumDefault: "nebula" })).source).toBe("album");
    expect(resolveVisualizer(input({ trackDefault: "", albumDefault: "nebula" })).picked).toBe("nebula");
    expect(resolveVisualizer(input({ albumDefault: "aurora-x" }))).toEqual({
      picked: "ridge",
      source: "global",
      defaultKind: null,
      defaultTier: null,
    });
  });

  it("takes Off as a default", () => {
    expect(resolveVisualizer(input({ global: "warp", albumDefault: "off" }))).toEqual({
      picked: "off",
      source: "album",
      defaultKind: "off",
      defaultTier: "album",
    });
  });

  it("holds the override while the album key stays and ends it when the key changes", () => {
    const override = { kind: "bloom", albumKey: ALBUM_KEY } as const;
    expect(resolveVisualizer(input({ albumDefault: "nebula", override })).picked).toBe("bloom");
    const next = resolveVisualizer(input({ albumDefault: "glass", override, albumKey: "album:9" }));
    expect(next).toEqual({ picked: "glass", source: "album", defaultKind: "glass", defaultTier: "album" });
  });

  it("never applies an override outside the library", () => {
    const override = { kind: "bloom", albumKey: ALBUM_KEY } as const;
    expect(resolveVisualizer(input({ override, albumKey: null })).picked).toBe("ridge");
  });

  it("keeps a temporary pick showing once the last default is cleared", () => {
    const res = resolveVisualizer(input({ override: { kind: "bloom", albumKey: ALBUM_KEY } }));
    expect(res).toEqual({ picked: "bloom", source: "global", defaultKind: null, defaultTier: null });
  });
});

describe("applyManualPick", () => {
  it("writes the global pref with no default", () => {
    expect(applyManualPick(input(), "terrain")).toEqual({ override: null, global: "terrain" });
  });

  it("clears a stale override with no default", () => {
    const stale = input({ override: { kind: "bloom", albumKey: ALBUM_KEY } });
    expect(applyManualPick(stale, "warp")).toEqual({ override: null, global: "warp" });
  });

  it("sets a temporary override over a default, keyed to the album", () => {
    expect(applyManualPick(input({ albumDefault: "nebula" }), "bloom")).toEqual({
      override: { kind: "bloom", albumKey: ALBUM_KEY },
      global: null,
    });
  });

  it("drops the override when the default itself is picked", () => {
    const over = input({ albumDefault: "nebula", override: { kind: "bloom", albumKey: ALBUM_KEY } });
    expect(applyManualPick(over, "nebula")).toEqual({ override: null, global: null });
  });

  it("measures the default against the track tier when it wins", () => {
    const both = input({ albumDefault: "nebula", trackDefault: "terrain" });
    expect(applyManualPick(both, "terrain")).toEqual({ override: null, global: null });
    expect(applyManualPick(both, "nebula").override).toEqual({ kind: "nebula", albumKey: ALBUM_KEY });
  });

  it("writes the global pref for a file opened from disk", () => {
    expect(applyManualPick(input({ albumKey: null }), "glass")).toEqual({ override: null, global: "glass" });
  });
});

describe("clearDefaultTier", () => {
  it("clears the track tier first, then the album tier", () => {
    expect(clearDefaultTier({ trackDefault: "terrain", albumDefault: "nebula" })).toBe("track");
    expect(clearDefaultTier({ trackDefault: null, albumDefault: "nebula" })).toBe("album");
    expect(clearDefaultTier({ trackDefault: null, albumDefault: null })).toBeNull();
  });

  it("skips a tier whose stored string names no kind", () => {
    expect(clearDefaultTier({ trackDefault: "aurora-x", albumDefault: "nebula" })).toBe("album");
  });

  it("keeps a temporary pick: clearing during an override still shows the pick", () => {
    const override = { kind: "bloom", albumKey: ALBUM_KEY } as const;
    const before = input({ albumDefault: "nebula", override });
    expect(clearDefaultTier(before)).toBe("album");
    expect(resolveVisualizer({ ...before, albumDefault: null }).picked).toBe("bloom");
  });
});

describe("placeOf and albumKeyOf", () => {
  const index = new Map([
    [3, { id: 7, kind: "album" as const }],
    [4, { id: 8, kind: "single" as const }],
  ]);

  it("places a filed track, a single, a loose track and a file from disk", () => {
    expect(placeOf(3, index)).toEqual(filed);
    expect(placeOf(4, index)).toEqual(single);
    expect(placeOf(5, index)).toEqual(loose);
    expect(placeOf(-2, index)).toEqual(adhoc);
  });

  it("keys a filed track and a single on their album, a loose track on itself, a file on nothing", () => {
    expect(albumKeyOf(3, index)).toBe("album:7");
    expect(albumKeyOf(4, index)).toBe("album:8");
    expect(albumKeyOf(5, index)).toBe("track:5");
    expect(albumKeyOf(-2, index)).toBeNull();
  });
});

describe("storedDefaultsOf", () => {
  const albums = { 7: "nebula", 8: "glass" };
  const tracks = { 3: "terrain", 4: "warp", 5: "bloom" };

  it("reads both tiers for a filed track", () => {
    expect(storedDefaultsOf(filed, albums, tracks)).toEqual({ trackDefault: "terrain", albumDefault: "nebula" });
  });

  it("reads only the album tier for a single", () => {
    expect(storedDefaultsOf(single, albums, tracks)).toEqual({ trackDefault: null, albumDefault: "glass" });
  });

  it("reads only the track tier for a loose track", () => {
    expect(storedDefaultsOf(loose, albums, tracks)).toEqual({ trackDefault: "bloom", albumDefault: null });
  });

  it("reads nothing for a file from disk", () => {
    expect(storedDefaultsOf(adhoc, albums, tracks)).toEqual({ trackDefault: null, albumDefault: null });
  });
});

describe("defaultActions", () => {
  const flags = (place: TrackPlace, patch: Partial<ResolveInput> = {}, status = "ready" as const) =>
    defaultActions(place, resolveVisualizer(input(patch)), status);

  it("offers both save actions and hides Clear with no default", () => {
    expect(flags(filed)).toEqual({
      useAlbum: { visible: true, disabled: false },
      useTrack: { visible: true, disabled: false },
      clear: { visible: false, disabled: false },
    });
  });

  it("dims Use for this album while the album default is showing", () => {
    const a = flags(filed, { albumDefault: "nebula" });
    expect(a.useAlbum.disabled).toBe(true);
    expect(a.useTrack.disabled).toBe(false);
    expect(a.clear).toEqual({ visible: true, disabled: false });
  });

  it("keeps Use for this album live when a track default wins", () => {
    const a = flags(filed, { albumDefault: "nebula", trackDefault: "nebula" });
    expect(a.useAlbum.disabled).toBe(false);
    expect(a.useTrack.disabled).toBe(true);
  });

  it("keeps both live during an override, to make the pick permanent", () => {
    const a = flags(filed, { albumDefault: "nebula", override: { kind: "bloom", albumKey: ALBUM_KEY } });
    expect(a.useAlbum.disabled).toBe(false);
    expect(a.useTrack.disabled).toBe(false);
    expect(a.clear.visible).toBe(true);
  });

  it("offers a single the album tier only", () => {
    const a = flags(single);
    expect(a.useAlbum.visible).toBe(true);
    expect(a.useTrack.visible).toBe(false);
  });

  it("hides Use for this album on a loose track", () => {
    const a = flags(loose);
    expect(a.useAlbum.visible).toBe(false);
    expect(a.useTrack.visible).toBe(true);
  });

  it("hides every action for a file from disk", () => {
    const a = flags(adhoc, { albumKey: null });
    expect([a.useAlbum.visible, a.useTrack.visible, a.clear.visible]).toEqual([false, false, false]);
  });

  it("disables every action until the defaults are read", () => {
    for (const status of ["loading", "failed"] as const) {
      const a = defaultActions(filed, resolveVisualizer(input({ albumDefault: "nebula" })), status);
      expect([a.useAlbum.disabled, a.useTrack.disabled, a.clear.disabled]).toEqual([true, true, true]);
    }
  });
});

describe("writeEndsOverride", () => {
  const override = { kind: "bloom", albumKey: ALBUM_KEY } as const;

  it("ends on a write for the overridden album, not another", () => {
    expect(writeEndsOverride(override, { album: 7 }, 3)).toBe(true);
    expect(writeEndsOverride(override, { album: 9 }, 3)).toBe(false);
  });

  it("ends on a write for the playing track, not another in the same album", () => {
    expect(writeEndsOverride(override, { track: 3 }, 3)).toBe(true);
    expect(writeEndsOverride(override, { track: 6 }, 3)).toBe(false);
  });

  it("has nothing to end without an override", () => {
    expect(writeEndsOverride(null, { album: 7 }, 3)).toBe(false);
  });
});
