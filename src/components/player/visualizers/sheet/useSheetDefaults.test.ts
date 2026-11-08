import { describe, expect, it } from "vitest";

import { markersOf, tagOf } from "./useSheetDefaults";
import type { Resolution } from "../../../../state/player/visualizerResolve";

const res = (over: Partial<Resolution>): Resolution => ({
  picked: "glass",
  source: "global",
  defaultKind: null,
  defaultTier: null,
  ...over,
});

describe("tagOf", () => {
  it("tags nothing without a default", () => {
    expect(tagOf(res({}), "glass")).toBeNull();
  });

  it("fills the picked kind of a default in effect, by tier", () => {
    const r = res({ picked: "nebula", source: "album", defaultKind: "nebula", defaultTier: "album" });
    expect(tagOf(r, "nebula")).toEqual({ form: "filled", tier: "album" });
    expect(tagOf(r, "glass")).toBeNull();
    expect(tagOf({ ...r, source: "track", defaultTier: "track" }, "nebula")).toEqual({ form: "filled", tier: "track" });
  });

  it("outlines the set-aside default and leaves the picked kind bare", () => {
    const r = res({ picked: "latte", source: "override", defaultKind: "nebula", defaultTier: "track" });
    expect(tagOf(r, "nebula")).toEqual({ form: "set-aside", tier: "track" });
    expect(tagOf(r, "latte")).toBeNull();
  });
});

describe("markersOf", () => {
  it("marks only the picked group when nothing is set aside", () => {
    expect(markersOf(res({ picked: "glass" }))).toEqual({ cozy: { active: true } });
  });

  it("rings the set-aside group beside the active one", () => {
    const r = res({ picked: "latte", source: "override", defaultKind: "nebula", defaultTier: "album" });
    expect(markersOf(r)).toEqual({ cozy: { active: true }, classic: { setAside: true } });
  });

  it("carries both dots on one chip when the groups match", () => {
    const r = res({ picked: "glass", source: "override", defaultKind: "latte", defaultTier: "album" });
    expect(markersOf(r)).toEqual({ cozy: { active: true, setAside: true } });
  });
});
