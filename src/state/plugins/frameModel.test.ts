// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import {
  backgroundOrder,
  crashKey,
  frameCapable,
  nextRelease,
  pluginRuntimeReady,
  remountsOnStarting,
  runsInBackground,
  wantedFrames,
} from "./frameModel";
import { manifest, row } from "./fixtures";

// -- Type Imports --
import type { WantedInput } from "./frameModel";
import type { PluginRow } from "../../types";

const ui = (id: string, over: Partial<PluginRow> = {}, modes: ("player" | "organizer")[] = ["player", "organizer"]) =>
  row({ id, granted: [], installed_at: 1, manifest: manifest({ name: id, modes, entry: `${id}.html` }), ...over });
const bg = (id: string, over: Partial<PluginRow> = {}) => ui(id, { granted: ["background"], ...over });

const input = (rows: PluginRow[], over: Partial<WantedInput> = {}): WantedInput => ({
  rows,
  appMode: "both",
  pageId: null,
  runtime: true,
  crashed: new Set(),
  released: new Set(),
  generation: {},
  ...over,
});

const ids = (rows: PluginRow[], over: Partial<WantedInput> = {}) =>
  wantedFrames(input(rows, over)).map((w) => `${w.kind}:${w.id}`);

describe("pluginRuntimeReady", () => {
  it("is true only while the runtime is running", () => {
    expect(pluginRuntimeReady(null)).toBe(false);
    expect(pluginRuntimeReady({ runtime: "held", unclean: true, safe_flag: false })).toBe(false);
    expect(pluginRuntimeReady({ runtime: "safe", unclean: false, safe_flag: true })).toBe(false);
    expect(pluginRuntimeReady({ runtime: "running", unclean: true, safe_flag: false })).toBe(true);
  });
});

describe("frameCapable and runsInBackground", () => {
  it("needs a live UI plugin", () => {
    expect(frameCapable(ui("a"))).toBe(true);
    expect(frameCapable(ui("a", { tier: "native" }))).toBe(false);
    expect(frameCapable(ui("a", { enabled: false }))).toBe(false);
    expect(frameCapable(ui("a", { state: "needs_consent" }))).toBe(false);
    expect(frameCapable(ui("a", { manifest: null }))).toBe(false);
  });

  it("adds the background grant", () => {
    expect(runsInBackground(bg("a"))).toBe(true);
    expect(runsInBackground(ui("a"))).toBe(false);
    expect(runsInBackground(bg("a", { tier: "native" }))).toBe(false);
    expect(runsInBackground(bg("a", { enabled: false }))).toBe(false);
  });
});

describe("wantedFrames", () => {
  it("mounts nothing while the runtime is not ready", () => {
    expect(ids([bg("a"), ui("p")], { runtime: false, pageId: "p", released: new Set(["a"]) })).toEqual([]);
  });

  it("mounts the page frame only while its page is open", () => {
    const rows = [ui("p")];
    expect(ids(rows)).toEqual([]);
    expect(wantedFrames(input(rows, { pageId: "p" }))).toEqual([
      { mountKey: "p|1.3.0|hash-1|0", id: "p", kind: "page", entry: "p.html", name: "p", active: true },
    ]);
  });

  it("does not mount a page for a plugin the mode hides", () => {
    expect(ids([ui("p", {}, ["player"])], { pageId: "p", appMode: "organizer" })).toEqual([]);
  });

  it("mounts a background frame only once released or when its page opens", () => {
    const rows = [bg("a"), bg("b")];
    expect(ids(rows)).toEqual([]);
    expect(ids(rows, { released: new Set(["a"]) })).toEqual(["background:a"]);
    expect(wantedFrames(input(rows, { pageId: "b" })).map((w) => [w.id, w.active])).toEqual([["b", true]]);
  });

  it("keeps a background frame across navigation, inactive", () => {
    const rows = [bg("a")];
    const released = new Set(["a"]);
    expect(wantedFrames(input(rows, { released, pageId: "a" }))[0].active).toBe(true);
    expect(wantedFrames(input(rows, { released, pageId: null }))[0]).toMatchObject({ id: "a", active: false });
    expect(wantedFrames(input(rows, { released, pageId: "other" }))[0].active).toBe(false);
  });

  it("keeps a background frame across an app-mode change, hiding only its page", () => {
    const rows = [bg("a", { manifest: manifest({ modes: ["player"], entry: "a.html" }) })];
    const released = new Set(["a"]);
    for (const appMode of ["both", "player", "organizer"] as const) {
      expect(ids(rows, { released, appMode })).toEqual(["background:a"]);
    }
    expect(wantedFrames(input(rows, { released, appMode: "organizer", pageId: "a" }))[0].active).toBe(false);
    expect(wantedFrames(input(rows, { released, appMode: "player", pageId: "a" }))[0].active).toBe(true);
  });

  it("unmounts a disabled or removed plugin", () => {
    const released = new Set(["a"]);
    expect(ids([bg("a", { enabled: false })], { released })).toEqual([]);
    expect(ids([], { released })).toEqual([]);
    expect(ids([bg("a", { state: "broken" })], { released })).toEqual([]);
  });

  it("never mounts a native plugin", () => {
    const native = bg("n", { tier: "native" });
    expect(ids([native], { released: new Set(["n"]), pageId: "n" })).toEqual([]);
  });

  it("excludes a crashed frame until restart bumps the generation", () => {
    const rows = [bg("a"), ui("p")];
    const crashed = new Set([crashKey(rows[0]), crashKey(rows[1])]);
    const released = new Set(["a"]);
    expect(ids(rows, { crashed, released, pageId: "p" })).toEqual([]);
    expect(ids(rows, { crashed, released, pageId: "a" })).toEqual([]);
    // Restart clears the crash key and raises the generation.
    const wants = wantedFrames(input(rows, { released, generation: { a: 1 } }));
    expect(wants[0].mountKey).toBe("a|1.3.0|hash-1|1");
  });

  it("changes the mount key on an update and frees a crash", () => {
    const before = bg("a");
    const crashed = new Set([crashKey(before)]);
    const released = new Set(["a"]);
    expect(ids([before], { crashed, released })).toEqual([]);
    const byVersion = bg("a", { version: "1.4.0" });
    const byHash = bg("a", { manifest_hash: "hash-2" });
    expect(wantedFrames(input([byVersion], { crashed, released }))[0].mountKey).toBe("a|1.4.0|hash-1|0");
    expect(wantedFrames(input([byHash], { crashed, released }))[0].mountKey).toBe("a|1.3.0|hash-2|0");
  });

  it("lists background frames in install order, then the page", () => {
    const rows = [
      bg("late", { installed_at: 3 }),
      ui("page", { installed_at: 1 }),
      bg("early", { installed_at: 2 }),
    ];
    expect(ids(rows, { released: new Set(["late", "early"]), pageId: "page" })).toEqual([
      "background:early",
      "background:late",
      "page:page",
    ]);
  });
});

describe("backgroundOrder", () => {
  it("lists background plugins by install time", () => {
    const rows = [
      bg("b", { installed_at: 20 }),
      ui("plain", { installed_at: 5 }),
      bg("a", { installed_at: 10 }),
      bg("off", { installed_at: 1, enabled: false }),
      bg("native", { installed_at: 2, tier: "native" }),
    ];
    expect(backgroundOrder(rows)).toEqual(["a", "b"]);
  });
});

describe("nextRelease", () => {
  const order = ["a", "b", "c"];
  const none = () => undefined;

  it("releases the first at once", () => {
    expect(nextRelease(order, new Set(), none, none, 0)).toBe("a");
  });

  it("waits for the previous to be live", () => {
    const released = new Set(["a"]);
    expect(nextRelease(order, released, () => "loading", () => 0, 1999)).toBeNull();
    expect(nextRelease(order, released, () => "live", () => 0, 100)).toBe("b");
  });

  it("releases after 2000 ms from the previous mount", () => {
    const released = new Set(["a"]);
    expect(nextRelease(order, released, () => "loading", () => 1000, 2999)).toBeNull();
    expect(nextRelease(order, released, () => "loading", () => 1000, 3000)).toBe("b");
  });

  it("moves on when the previous crashed or is unavailable", () => {
    const released = new Set(["a"]);
    expect(nextRelease(order, released, () => "crashed", none, 0)).toBe("b");
    expect(nextRelease(order, released, () => "unavailable", none, 0)).toBe("b");
  });

  it("waits for a previous that has not mounted yet", () => {
    expect(nextRelease(order, new Set(["a"]), none, none, 5000)).toBeNull();
  });

  it("returns null when everything is released", () => {
    expect(nextRelease(order, new Set(order), none, none, 0)).toBeNull();
    expect(nextRelease([], new Set(), none, none, 0)).toBeNull();
  });

  it("keeps install order when a later id was released early", () => {
    expect(nextRelease(order, new Set(["c"]), none, none, 0)).toBe("a");
  });
});

describe("frames while the runtime is held", () => {
  it("mounts nothing, even for a background plugin with its page open", () => {
    const held = pluginRuntimeReady({ runtime: "held", unclean: true, safe_flag: false });
    expect(ids([bg("a"), ui("b")], { runtime: held, pageId: "b", released: new Set(["a"]) })).toEqual([]);
  });
});

describe("remountsOnStarting", () => {
  const crashedOf = (r: PluginRow) => new Set([crashKey(r)]);

  it("remounts a crashed background frame", () => {
    const a = bg("a");
    expect(remountsOnStarting(a, crashedOf(a))).toBe(true);
  });

  it("leaves a crashed page frame for the user's Restart", () => {
    const a = ui("a");
    expect(remountsOnStarting(a, crashedOf(a))).toBe(false);
  });

  it("leaves a background frame that did not crash", () => {
    expect(remountsOnStarting(bg("a"), new Set())).toBe(false);
  });
});
