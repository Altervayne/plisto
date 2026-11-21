import { describe, expect, it } from "vitest";

import { familyView, hasFamily, listingChange, reviewLanding } from "./pluginFamily";
import { manifest, row, status, visualizerDecl, visualizerRow } from "./fixtures";
import type { FamilyContext } from "./pluginFamily";
import type { PluginRow } from "../../types";

const RUNNING = { runtime: "running", unclean: false, safe_flag: false } as const;
const SAFE = { runtime: "safe", unclean: false, safe_flag: true } as const;
const ctx = (over: Partial<FamilyContext> = {}): FamilyContext => ({
  boot: RUNNING,
  status: undefined,
  groupsOff: [],
  ...over,
});

const only = (over: Partial<PluginRow> = {}) => visualizerRow("com.test.pulse", "Pulse", [visualizerDecl()], over);
const mixed = (over: Partial<PluginRow> = {}) =>
  row({
    id: "com.test.setlist",
    manifest: manifest({ name: "Setlist", visualizers: [visualizerDecl()] }),
    ...over,
  });
const crashed = status({ id: "x", host: "crash_loop" });

describe("familyView status", () => {
  it("reads on and off from the plugin's enabled state when it is visualizer-only", () => {
    expect(familyView(only(), ctx()).status).toBe("on");
    expect(familyView(only({ enabled: false }), ctx()).status).toBe("off");
  });

  it("reads each problem state of the row", () => {
    expect(familyView(only({ state: "broken", problem: "x" }), ctx()).status).toBe("broken");
    expect(familyView(only({ state: "incompatible" }), ctx()).status).toBe("newer");
    expect(familyView(only({ state: "needs_consent", enabled: false }), ctx()).status).toBe("review");
  });

  it("reads a crash loop only while plugins run, and ahead of off", () => {
    expect(familyView(only({ enabled: false }), ctx({ status: crashed })).status).toBe("crash");
    expect(familyView(only(), ctx({ boot: SAFE, status: crashed })).status).toBe("safe");
  });

  it("reads safe mode for an enabled plugin and off for a disabled one", () => {
    expect(familyView(only(), ctx({ boot: SAFE })).status).toBe("safe");
    expect(familyView(only({ enabled: false }), ctx({ boot: SAFE })).status).toBe("off");
  });

  it("lets a problem state outrank a crash loop, and review outrank safe", () => {
    expect(familyView(only({ state: "broken" }), ctx({ status: crashed })).status).toBe("broken");
    expect(familyView(only({ state: "needs_consent" }), ctx({ boot: SAFE })).status).toBe("review");
  });

  it("reads a mixed plugin off in Plugins when it is disabled there", () => {
    expect(familyView(mixed({ enabled: false }), ctx()).status).toBe("offInPlugins");
  });

  it("reads a mixed plugin off by its catalog flag, not by its enabled state", () => {
    const view = familyView(mixed(), ctx({ groupsOff: ["plugin:com.test.setlist"] }));
    expect(view.status).toBe("off");
    expect(familyView(mixed(), ctx()).status).toBe("on");
  });

  it("ignores a stale catalog flag on a visualizer-only plugin", () => {
    expect(familyView(only(), ctx({ groupsOff: ["plugin:com.test.pulse"] })).status).toBe("on");
  });

  it("treats a held runtime like running for a healthy plugin", () => {
    const held = { ...RUNNING, runtime: "held" } as const;
    expect(familyView(only(), ctx({ boot: held })).status).toBe("on");
    expect(familyView(only(), ctx({ boot: null })).status).toBe("on");
  });
});

describe("familyView switch", () => {
  it("flips the plugin's enabled state for a visualizer-only plugin", () => {
    expect(familyView(only(), ctx())).toMatchObject({ checked: true, flip: { kind: "plugin", enable: false } });
    expect(familyView(only({ enabled: false }), ctx())).toMatchObject({
      checked: false,
      flip: { kind: "plugin", enable: true },
    });
  });

  it("flips the family flag for a mixed plugin, never the plugin", () => {
    expect(familyView(mixed(), ctx()).flip).toEqual({ kind: "catalog", family: "plugin:com.test.setlist", on: false });
    const off = familyView(mixed(), ctx({ groupsOff: ["plugin:com.test.setlist"] }));
    expect(off.flip).toEqual({ kind: "catalog", family: "plugin:com.test.setlist", on: true });
  });

  it("keeps the switch live in safe mode", () => {
    const view = familyView(only(), ctx({ boot: SAFE }));
    expect(view).toMatchObject({ checked: true, locked: false, link: "restartNormally" });
    expect(view.flip).toEqual({ kind: "plugin", enable: false });
  });

  it("replaces the switch with one action for a visualizer-only plugin", () => {
    const review = familyView(only({ state: "needs_consent" }), ctx());
    expect(review).toMatchObject({ inline: "review", flip: null });
    expect(familyView(only({ enabled: false }), ctx({ status: crashed }))).toMatchObject({
      inline: "restart",
      flip: null,
      warn: true,
    });
    expect(familyView(only({ state: "broken" }), ctx())).toMatchObject({
      inline: "uninstall",
      tiles: false,
      expandable: false,
    });
  });

  it("holds a mixed plugin's switch grey with a link and no action", () => {
    for (const view of [
      familyView(mixed({ state: "needs_consent" }), ctx()),
      familyView(mixed({ enabled: false }), ctx({ status: crashed })),
      familyView(mixed({ enabled: false }), ctx()),
    ]) {
      expect(view).toMatchObject({ checked: false, locked: true, flip: null, inline: null, link: "plugins" });
    }
  });

  it("locks the switch of a plugin that needs a newer Plisto", () => {
    expect(familyView(only({ state: "incompatible" }), ctx())).toMatchObject({
      locked: true,
      flip: null,
      inline: null,
    });
  });
});

describe("hasFamily", () => {
  it("covers visualizer-only plugins and mixed ones that bring visualizers", () => {
    expect(hasFamily(only())).toBe(true);
    expect(hasFamily(mixed())).toBe(true);
    expect(hasFamily(row())).toBe(false);
    expect(hasFamily(row({ manifest: null }))).toBe(false);
  });
});

describe("reviewLanding", () => {
  it("lands a visualizer-only plugin turned on with its family flag cleared", () => {
    expect(reviewLanding(only({ state: "needs_consent" }))).toEqual({
      enablePlugin: true,
      clearFlag: "plugin:com.test.pulse",
    });
  });

  it("leaves a mixed plugin off in Plugins and clears its family flag", () => {
    expect(reviewLanding(mixed({ state: "needs_consent" }))).toEqual({
      enablePlugin: false,
      clearFlag: "plugin:com.test.setlist",
    });
  });

  it("has nothing to land for a plugin with no family", () => {
    expect(reviewLanding(row())).toBeNull();
  });
});

describe("listingChange", () => {
  it("is null while the listing stays or a manifest is unreadable", () => {
    expect(listingChange(only(), only({ version: "2.0.0" }))).toBeNull();
    expect(listingChange(mixed(), mixed())).toBeNull();
    expect(listingChange(row({ manifest: null }), mixed())).toBeNull();
  });

  it("moves a plugin that gains a page to its own enabled state in Plugins and the family flag here", () => {
    const after = mixed({ id: "com.test.pulse" });
    expect(listingChange(only(), after)).toEqual({
      to: "plugins",
      control: "catalog",
      family: "stays",
      clearFlag: null,
      notice: "ownPage",
    });
  });

  it("returns a plugin that drops its page to the plugin switch and clears the stale flag", () => {
    const before = mixed({ id: "com.test.pulse" });
    expect(listingChange(before, only())).toEqual({
      to: "catalog",
      control: "plugin",
      family: "stays",
      clearFlag: "plugin:com.test.pulse",
      notice: "managedInVisualizers",
    });
  });

  it("says the family is gone when the plugin gains a page and keeps no visualizers", () => {
    const after = row({ id: "com.test.pulse", manifest: manifest({ visualizers: [] }) });
    expect(listingChange(only(), after)).toMatchObject({ to: "plugins", family: "gone" });
  });
});
