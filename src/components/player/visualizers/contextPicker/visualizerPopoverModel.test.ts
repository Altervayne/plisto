// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { visualizerPopoverModel as buildModel, type PopoverStored, type PopoverSubject } from "./visualizerPopoverModel";
import { ALL_OFFERED, buildCatalog, serializeCatalog, type Catalog } from "../../../../state/player/visualizerCatalog";

const visualizerPopoverModel = (subject: PopoverSubject, stored: PopoverStored, catalog: Catalog = ALL_OFFERED) =>
  buildModel(subject, stored, catalog);

/** A catalog with the given kinds and families turned off. */
const without = (kinds: string[], groups: string[] = []) => buildCatalog(serializeCatalog({ kinds, groups }), false);

const album: PopoverSubject = { kind: "album", albumId: 7 };
const track: PopoverSubject = { kind: "track", place: { kind: "album", trackId: 3, albumId: 7 } };
const single: PopoverSubject = { kind: "track", place: { kind: "single", trackId: 4, albumId: 9 } };
const loose: PopoverSubject = { kind: "track", place: { kind: "loose", trackId: 5 } };
const adhoc: PopoverSubject = { kind: "track", place: { kind: "adhoc" } };

const none = { trackDefault: null, albumDefault: null };
const noMarkers = { active: false, setAside: false };

describe("visualizerPopoverModel", () => {
  it("album with no default: global pick checked, Classic tab, no markers", () => {
    const m = visualizerPopoverModel(album, none);
    expect(m.target).toEqual({ tier: "album", id: 7 });
    expect(m.stored).toBeNull();
    expect(m.topLabel).toEqual({ form: "global" });
    expect(m.topChecked).toBe(true);
    expect(m.setAside).toBeNull();
    expect(m.openTab).toBe("classic");
    expect(Object.values(m.markers).every((x) => !x.active && !x.setAside)).toBe(true);
  });

  it("album with a default: that kind checked, its tab opens and carries the dot", () => {
    const m = visualizerPopoverModel(album, { trackDefault: null, albumDefault: "liquid" });
    expect(m.stored).toBe("liquid");
    expect(m.topLabel).toEqual({ form: "global" });
    expect(m.topChecked).toBe(false);
    expect(m.openTab).toBe("fluid");
    expect(m.markers.fluid).toEqual({ active: true, setAside: false });
    expect(m.markers.classic).toEqual(noMarkers);
  });

  it("an album scope ignores a track string", () => {
    const m = visualizerPopoverModel(album, { trackDefault: "warp", albumDefault: null });
    expect(m.stored).toBeNull();
  });

  it("track with no default and no album default: global pick", () => {
    const m = visualizerPopoverModel(track, none);
    expect(m.target).toEqual({ tier: "track", id: 3 });
    expect(m.topLabel).toEqual({ form: "global" });
    expect(m.topChecked).toBe(true);
    expect(m.albumDefault).toBeNull();
    expect(m.openTab).toBe("classic");
  });

  it("track with an album default only: the top row offers it and is checked, its tile set aside", () => {
    const m = visualizerPopoverModel(track, { trackDefault: null, albumDefault: "glass" });
    expect(m.topLabel).toEqual({ form: "albumDefault", kind: "glass" });
    expect(m.topChecked).toBe(true);
    expect(m.albumDefault).toBe("glass");
    expect(m.setAside).toBe("glass");
    expect(m.markers.cozy).toEqual({ active: false, setAside: true });
    expect(m.openTab).toBe("cozy");
  });

  it("track with its own default over an album default: both marked, the stored tab opens", () => {
    const m = visualizerPopoverModel(track, { trackDefault: "terrain", albumDefault: "glass" });
    expect(m.stored).toBe("terrain");
    expect(m.topLabel).toEqual({ form: "albumDefault", kind: "glass" });
    expect(m.topChecked).toBe(false);
    expect(m.setAside).toBe("glass");
    expect(m.markers.classic).toEqual({ active: true, setAside: false });
    expect(m.markers.cozy).toEqual({ active: false, setAside: true });
    expect(m.openTab).toBe("classic");
  });

  it("both dots land on one tab when the two kinds share a group", () => {
    const m = visualizerPopoverModel(track, { trackDefault: "terrain", albumDefault: "nebula" });
    expect(m.markers.classic).toEqual({ active: true, setAside: true });
  });

  it("a track default equal to the album default sets nothing aside", () => {
    const m = visualizerPopoverModel(track, { trackDefault: "nebula", albumDefault: "nebula" });
    expect(m.stored).toBe("nebula");
    expect(m.setAside).toBeNull();
    expect(m.markers.classic).toEqual({ active: true, setAside: false });
  });

  it("track with its own default and no album default", () => {
    const m = visualizerPopoverModel(track, { trackDefault: "halftone", albumDefault: null });
    expect(m.stored).toBe("halftone");
    expect(m.topLabel).toEqual({ form: "global" });
    expect(m.openTab).toBe("dots");
  });

  it("single: writes the album tier, says global pick, never offers an album default", () => {
    const m = visualizerPopoverModel(single, { trackDefault: "warp", albumDefault: "nebula" });
    expect(m.single).toBe(true);
    expect(m.target).toEqual({ tier: "album", id: 9 });
    expect(m.stored).toBe("nebula");
    expect(m.albumDefault).toBeNull();
    expect(m.setAside).toBeNull();
    expect(m.topLabel).toEqual({ form: "global" });
    expect(m.markers.classic).toEqual({ active: true, setAside: false });
  });

  it("loose track: writes its own tier with no album default", () => {
    const m = visualizerPopoverModel(loose, { trackDefault: "ink", albumDefault: null });
    expect(m.target).toEqual({ tier: "track", id: 5 });
    expect(m.stored).toBe("ink");
    expect(m.topLabel).toEqual({ form: "global" });
  });

  it("a file opened from disk has no target", () => {
    const m = visualizerPopoverModel(adhoc, none);
    expect(m.target).toBeNull();
    expect(m.topChecked).toBe(true);
  });

  it("unknown stored strings read as no default at either tier", () => {
    const m = visualizerPopoverModel(track, { trackDefault: "aurora", albumDefault: "" });
    expect(m.stored).toBeNull();
    expect(m.albumDefault).toBeNull();
    expect(m.topLabel).toEqual({ form: "global" });
    expect(m.topChecked).toBe(true);
    expect(m.openTab).toBe("classic");
    const a = visualizerPopoverModel(album, { trackDefault: null, albumDefault: "Ridge" });
    expect(a.stored).toBeNull();
    expect(a.topChecked).toBe(true);
  });

  it("an unknown track string falls back to the album default", () => {
    const m = visualizerPopoverModel(track, { trackDefault: "aurora", albumDefault: "glass" });
    expect(m.topLabel).toEqual({ form: "albumDefault", kind: "glass" });
    expect(m.topChecked).toBe(true);
  });

  it("Off stored: checked, no tab marked, the album default's tab opens", () => {
    const m = visualizerPopoverModel(track, { trackDefault: "off", albumDefault: "glass" });
    expect(m.stored).toBe("off");
    expect(m.topChecked).toBe(false);
    expect(m.markers.cozy).toEqual({ active: false, setAside: true });
    expect(m.openTab).toBe("cozy");
    expect(visualizerPopoverModel(album, { trackDefault: null, albumDefault: "off" }).openTab).toBe("classic");
  });

  it("Off as the album default is offered by name", () => {
    const m = visualizerPopoverModel(track, { trackDefault: null, albumDefault: "off" });
    expect(m.topLabel).toEqual({ form: "albumDefault", kind: "off" });
    expect(m.setAside).toBe("off");
    expect(Object.values(m.markers).every((x) => !x.setAside)).toBe(true);
  });
});

describe("visualizerPopoverModel over a catalog", () => {
  it("tabs and markers cover the offered families only", () => {
    const m = visualizerPopoverModel(album, none, without([], ["dots"]));
    expect(m.groups.map((g) => g.id)).toEqual(["classic", "fluid", "cozy", "cyber", "cosmic"]);
    expect(Object.keys(m.markers)).toEqual(["classic", "fluid", "cozy", "cyber", "cosmic"]);
  });

  it("opens the Cosmic tab for a stored cosmic kind", () => {
    const m = visualizerPopoverModel(album, { trackDefault: null, albumDefault: "ringed-planet" });
    expect(m.openTab).toBe("cosmic");
    expect(m.markers.cosmic).toEqual({ active: true, setAside: false });
  });

  it("opens the Cyber tab for a stored cyber kind", () => {
    const m = visualizerPopoverModel(album, { trackDefault: null, albumDefault: "hologram" });
    expect(m.openTab).toBe("cyber");
    expect(m.markers.cyber).toEqual({ active: true, setAside: false });
  });

  it("a family with every kind off loses its tab", () => {
    const m = visualizerPopoverModel(album, none, without(["halftone", "dot-spectrum", "dot-cover"]));
    expect(m.groups.map((g) => g.id)).not.toContain("dots");
  });

  it("a turned-off stored kind reads as no default: top row checked, nothing marked, line data set", () => {
    const m = visualizerPopoverModel(album, { trackDefault: null, albumDefault: "train" }, without(["train"]));
    expect(m.stored).toBeNull();
    expect(m.topChecked).toBe(true);
    expect(m.turnedOff).toEqual({ kind: "train", tier: "album" });
    expect(Object.values(m.markers).every((x) => !x.active)).toBe(true);
    expect(m.openTab).toBe("classic");
  });

  it("a turned-off track default is reported on the track tier", () => {
    const m = visualizerPopoverModel(track, { trackDefault: "train", albumDefault: null }, without(["train"]));
    expect(m.turnedOff).toEqual({ kind: "train", tier: "track" });
  });

  it("a turned-off album default is not offered to a track, and is reported apart", () => {
    const m = visualizerPopoverModel(track, { trackDefault: null, albumDefault: "train" }, without(["train"]));
    expect(m.albumDefault).toBeNull();
    expect(m.albumDefaultOff).toBe("train");
    expect(m.turnedOff).toBeNull();
    expect(m.topLabel).toEqual({ form: "global" });
    expect(m.setAside).toBeNull();
  });

  it("an offered default leaves nothing turned off", () => {
    const m = visualizerPopoverModel(track, { trackDefault: "train", albumDefault: "glass" });
    expect(m.turnedOff).toBeNull();
    expect(m.albumDefaultOff).toBeNull();
  });

  it("opens on the first offered family when nothing is stored", () => {
    const m = visualizerPopoverModel(album, none, without([], ["classic"]));
    expect(m.openTab).toBe("dots");
  });

  it("a family turned off by switch hides a stored kind inside it", () => {
    const m = visualizerPopoverModel(album, { trackDefault: null, albumDefault: "glass" }, without([], ["cozy"]));
    expect(m.stored).toBeNull();
    expect(m.turnedOff).toEqual({ kind: "glass", tier: "album" });
  });

  it("Off stays offered under any catalog", () => {
    const m = visualizerPopoverModel(album, { trackDefault: null, albumDefault: "off" }, without(["ridge"]));
    expect(m.stored).toBe("off");
    expect(m.turnedOff).toBeNull();
  });
});
