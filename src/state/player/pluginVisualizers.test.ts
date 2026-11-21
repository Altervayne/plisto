// -- Test Imports --
import { afterEach, describe, expect, it } from "vitest";

// -- Unit Imports --
import {
  applyPluginRows,
  familyLabel,
  isPendingPluginKind,
  isPluginKindId,
  pluginVisualizer,
  pluginVisualizerRevision,
  pluginVisualizers,
  resolveAlias,
} from "./pluginVisualizers";
import {
  VISUALIZER_KINDS,
  effectiveVisualizerKind,
  fillsStage,
  isDarkOnly,
  isGlKind,
  isKnownKind,
  needsCoverPixels,
  needsFineSpectrum,
  normalizeVisualizerKind,
  type VisualizerKind,
} from "./visualizerKind";
import { applyManualPick, resolveVisualizer, type ResolveInput } from "./visualizerResolve";
import { buildCatalog, catalogOf, serializeCatalog } from "./visualizerCatalog";
import { row, visualizerDecl as decl, visualizerRow as visRow } from "../plugins/fixtures";
import { usePluginsStore } from "../plugins/store";

afterEach(() => {
  usePluginsStore.setState({ rows: [], boot: null, status: "idle", listed: false });
  applyPluginRows([]);
});

describe("built-in kinds", () => {
  // kind, isGlKind, needs.fine, needs.cover, fillsStage, darkOnly, effective after a GL failure, effective without cover pixels
  const before: [string, boolean, boolean, boolean, boolean, boolean, string, string][] = [
    ["ridge", false, false, false, false, false, "ridge", "ridge"],
    ["terrain", true, true, false, false, false, "ridge", "terrain"],
    ["warp", true, false, false, false, false, "ridge", "warp"],
    ["nebula", true, false, false, false, false, "ridge", "nebula"],
    ["bloom", true, false, false, false, false, "ridge", "bloom"],
    ["halftone", true, false, false, false, false, "ridge", "halftone"],
    ["dot-spectrum", true, true, false, false, false, "ridge", "dot-spectrum"],
    ["dot-cover", true, false, true, false, false, "ridge", "ridge"],
    ["liquid", true, false, true, true, false, "ridge", "ridge"],
    ["ink", true, false, true, true, false, "ridge", "ridge"],
    ["mercury", true, false, true, true, false, "ridge", "ridge"],
    ["silk", true, false, false, true, false, "ridge", "silk"],
    ["pond", true, false, true, true, false, "ridge", "ridge"],
    ["glass", true, false, true, true, false, "ridge", "ridge"],
    ["train", true, false, true, true, false, "ridge", "ridge"],
    ["record", true, false, true, true, false, "ridge", "ridge"],
    ["snowfall", true, false, true, true, false, "ridge", "ridge"],
    ["latte", true, false, true, true, false, "ridge", "ridge"],
    ["fireflies", true, false, true, true, false, "ridge", "ridge"],
    ["window", true, false, true, true, false, "ridge", "ridge"],
    ["lake", true, false, true, true, false, "ridge", "ridge"],
    ["neon-highway", true, false, false, true, false, "ridge", "neon-highway"],
    ["server-room", true, false, true, true, false, "ridge", "ridge"],
    ["circuit-board", true, false, true, true, false, "ridge", "ridge"],
    ["oscilloscope", true, false, true, true, false, "ridge", "ridge"],
    ["hologram", true, false, true, true, false, "ridge", "ridge"],
    ["gravitational-waves", true, false, true, true, true, "ridge", "ridge"],
    ["ringed-planet", true, false, true, true, true, "ridge", "ridge"],
    ["station", true, false, true, true, true, "ridge", "ridge"],
    ["solar-flare", true, false, false, true, true, "ridge", "solar-flare"],
    ["event-horizon", true, false, false, true, true, "ridge", "event-horizon"],
    ["off", false, false, false, false, false, "off", "off"],
  ];

  const answers = () =>
    VISUALIZER_KINDS.map((k) => [
      k,
      isGlKind(k),
      needsFineSpectrum(k),
      needsCoverPixels(k),
      fillsStage(k),
      isDarkOnly(k),
      effectiveVisualizerKind(k, { glFailed: true, coverPixels: true }),
      effectiveVisualizerKind(k, { glFailed: false, coverPixels: false }),
    ]);

  it("answers every predicate for all 31 kinds and Off as before", () => {
    expect(VISUALIZER_KINDS).toHaveLength(32);
    expect(answers()).toEqual(before);
  });

  it("answers the same with plugin kinds installed, including one whose kind id is a built-in id", () => {
    applyPluginRows([
      visRow("com.example.vis", "Example", [
        decl({ id: "ridge", fills_stage: true, dark_only: true, needs: { fine: true, cover: true, pointer: true, waveform: false } }),
      ]),
    ]);
    expect(answers()).toEqual(before);
  });

  it("keeps every built-in through normalize", () => {
    for (const kind of VISUALIZER_KINDS) expect(normalizeVisualizerKind(kind)).toBe(kind);
  });
});

describe("plugin kind ids", () => {
  it("accepts a reverse-DNS plugin id and a kind id", () => {
    expect(isPluginKindId("com.example.vis/aurora-rings")).toBe(true);
    expect(isPluginKindId("cozy.x/a")).toBe(true);
  });

  it("refuses malformed ids", () => {
    for (const raw of [
      "",
      "ridge",
      "/aurora",
      "com.example/",
      "example/aurora",
      "Com.example/aurora",
      "com.example/Aurora",
      "com.example/a/b",
      "com..example/aurora",
      `com.example/${"a".repeat(25)}`,
      `${"a".repeat(32)}.${"b".repeat(32)}/aurora`,
      "plugin:com.example",
    ]) {
      expect(isPluginKindId(raw), raw).toBe(false);
    }
    expect(isPluginKindId(null)).toBe(false);
    expect(isPluginKindId(undefined)).toBe(false);
  });

  it("keeps a well-formed plugin kind through normalize whether or not it is installed", () => {
    expect(normalizeVisualizerKind("com.example.vis/aurora-rings")).toBe("com.example.vis/aurora-rings");
    expect(normalizeVisualizerKind("com.example/Aurora")).toBe("ridge");
    expect(normalizeVisualizerKind("example/aurora")).toBe("ridge");
  });
});

describe("an unknown plugin kind", () => {
  const unknown: VisualizerKind[] = ["com.example.vis/missing", "toString/constructor" as VisualizerKind];

  it("answers false at every predicate and never throws", () => {
    for (const kind of unknown) {
      expect(isGlKind(kind)).toBe(false);
      expect(needsFineSpectrum(kind)).toBe(false);
      expect(needsCoverPixels(kind)).toBe(false);
      expect(fillsStage(kind)).toBe(false);
      expect(isDarkOnly(kind)).toBe(false);
      expect(isKnownKind(kind)).toBe(false);
      expect(effectiveVisualizerKind(kind, { glFailed: true, coverPixels: false })).toBe(kind);
    }
  });

  it("is safe for a string that is no id at all", () => {
    const junk = "__proto__" as VisualizerKind;
    expect(needsCoverPixels(junk)).toBe(false);
    expect(isDarkOnly(junk)).toBe(false);
    expect(isKnownKind(junk)).toBe(false);
  });
});

describe("the plugin table", () => {
  const glow = decl({
    id: "level-glow",
    name: "Level glow",
    fills_stage: true,
    dark_only: true,
    needs: { fine: true, cover: true, pointer: false, waveform: false },
    aliases: ["glow", "old-glow"],
  });

  it("resolves an installed kind's traits through the table", () => {
    applyPluginRows([visRow("com.example.vis", "Example", [decl(), glow])]);
    const id = "com.example.vis/level-glow";
    expect(isKnownKind(id)).toBe(true);
    expect(needsFineSpectrum(id)).toBe(true);
    expect(needsCoverPixels(id)).toBe(true);
    expect(fillsStage(id)).toBe(true);
    expect(isDarkOnly(id)).toBe(true);
    expect(isGlKind(id)).toBe(false);
    expect(needsCoverPixels("com.example.vis/aurora-rings")).toBe(false);
  });

  it("carries the family, plugin name, version and manifest hash", () => {
    applyPluginRows([visRow("com.example.vis", "Example", [glow], { version: "2.0.0", manifest_hash: "h2" })]);
    expect(pluginVisualizer("com.example.vis/level-glow")).toMatchObject({
      pluginId: "com.example.vis",
      kindId: "level-glow",
      family: "plugin:com.example.vis",
      pluginName: "Example",
      name: "Level glow",
      version: "2.0.0",
      manifestHash: "h2",
      aliases: ["com.example.vis/glow", "com.example.vis/old-glow"],
    });
  });

  it("leaves out disabled, unready and manifest-less rows", () => {
    applyPluginRows([
      visRow("com.a.vis", "A", [decl()], { enabled: false }),
      visRow("com.b.vis", "B", [decl()], { state: "broken" }),
      visRow("com.c.vis", "C", [decl()], { state: "needs_consent" }),
      row({ id: "com.d.vis", manifest: null }),
    ]);
    expect(pluginVisualizers()).toEqual([]);
  });

  it("orders kinds by plugin name, then declared order", () => {
    applyPluginRows([
      visRow("com.z.vis", "Zebra", [decl({ id: "b" }), decl({ id: "a" })]),
      visRow("com.a.vis", "Moth", [decl({ id: "c" })]),
    ]);
    expect(pluginVisualizers().map((d) => d.id)).toEqual(["com.a.vis/c", "com.z.vis/b", "com.z.vis/a"]);
  });

  it("bumps the revision only when the content changes", () => {
    const rows = [visRow("com.example.vis", "Example", [glow])];
    applyPluginRows(rows);
    const rev = pluginVisualizerRevision();
    applyPluginRows(rows);
    applyPluginRows([visRow("com.example.vis", "Example", [glow])]);
    expect(pluginVisualizerRevision()).toBe(rev);
    applyPluginRows([visRow("com.example.vis", "Example", [glow], { version: "9.0.0" })]);
    expect(pluginVisualizerRevision()).toBe(rev + 1);
  });

  it("follows the plugins store", () => {
    usePluginsStore.getState().applyRows([visRow("com.example.vis", "Example", [glow])]);
    expect(isKnownKind("com.example.vis/level-glow")).toBe(true);
    usePluginsStore.getState().removeRow("com.example.vis");
    expect(isKnownKind("com.example.vis/level-glow")).toBe(false);
  });
});

describe("resolveAlias", () => {
  it("names the current kind for a former id and leaves anything else as is", () => {
    applyPluginRows([visRow("com.example.vis", "Example", [decl({ aliases: ["rings"] })])]);
    expect(resolveAlias("com.example.vis/rings")).toBe("com.example.vis/aurora-rings");
    expect(resolveAlias("com.example.vis/aurora-rings")).toBe("com.example.vis/aurora-rings");
    expect(resolveAlias("com.other.vis/rings")).toBe("com.other.vis/rings");
    expect(resolveAlias("ridge")).toBe("ridge");
  });

  it("stops resolving once the plugin is gone", () => {
    applyPluginRows([visRow("com.example.vis", "Example", [decl({ aliases: ["rings"] })])]);
    applyPluginRows([]);
    expect(resolveAlias("com.example.vis/rings")).toBe("com.example.vis/rings");
  });
});

describe("familyLabel", () => {
  it("is the plugin's name for an installed plugin family, else null", () => {
    applyPluginRows([visRow("com.example.vis", "Example", [decl()])]);
    expect(familyLabel("plugin:com.example.vis")).toBe("Example");
    expect(familyLabel("plugin:com.other.vis")).toBeNull();
    expect(familyLabel("cozy")).toBeNull();
  });
});

describe("isPendingPluginKind", () => {
  const rings = visRow("com.example.vis", "Example", [decl({ aliases: ["rings"] })]);

  it("holds a plugin kind the table lacks until a listing applies", () => {
    expect(isPendingPluginKind("com.example.vis/aurora-rings", false)).toBe(true);
    expect(isPendingPluginKind("com.example.vis/aurora-rings", true)).toBe(false);
  });

  it("never holds a built-in, a malformed id, an installed kind or its alias", () => {
    applyPluginRows([rings]);
    const kinds = ["ridge", "off", "example/aurora", "com.example.vis/aurora-rings", "com.example.vis/rings"];
    for (const kind of kinds) expect(isPendingPluginKind(kind, false), kind).toBe(false);
  });
});

describe("the plugins store's listing", () => {
  const store = () => usePluginsStore.getState();

  it("counts as listed only once a listing applied, whatever the status says", () => {
    store().setStatus("failed");
    expect(store().listed).toBe(false);
    store().applyRows([]);
    expect(store().listed).toBe(true);
    store().setStatus("failed");
    expect(store().listed).toBe(true);
  });

  it.each(["safe", "held"] as const)("keeps the kinds of a %s runtime in the table", (runtime) => {
    store().applyRows([visRow("com.example.vis", "Example", [decl()])]);
    store().applyBoot({ runtime, unclean: true, safe_flag: runtime === "safe" });
    expect(isKnownKind("com.example.vis/aurora-rings")).toBe(true);
    expect(pluginVisualizers()).toHaveLength(1);
  });
});

describe("resolving stored plugin kinds", () => {
  const AURORA = "com.example.vis/aurora-rings";
  const input = (patch: Partial<ResolveInput> = {}): ResolveInput => ({
    global: "ridge",
    trackDefault: null,
    albumDefault: null,
    override: null,
    albumKey: "album:7",
    catalog: catalogOf(undefined, false),
    ...patch,
  });

  it("takes a pending pick at its word and falls back only once the listing lacks it", () => {
    expect(resolveVisualizer(input({ global: AURORA, pluginsPending: true })).picked).toBe(AURORA);
    expect(resolveVisualizer(input({ global: AURORA })).picked).toBe("ridge");
  });

  it("keeps a pending kind out of play when the stored catalog turns it or its family off", () => {
    const off = (kinds: string[], groups: string[]) =>
      buildCatalog(serializeCatalog({ kinds, groups }), false);
    for (const catalog of [off([AURORA], []), off([], ["plugin:com.example.vis"])]) {
      const res = resolveVisualizer(input({ albumDefault: AURORA, pluginsPending: true, catalog }));
      expect(res.picked).toBe("ridge");
      expect(res.skipped).toEqual({ kind: AURORA, tier: "album" });
    }
  });

  it("sets a pick aside over a pending default instead of writing the global pick", () => {
    const pending = input({ albumDefault: AURORA, pluginsPending: true });
    const res = resolveVisualizer(pending);
    expect(res).toMatchObject({ picked: AURORA, defaultKind: AURORA, defaultTier: "album" });
    expect(applyManualPick(pending, "nebula")).toEqual({
      override: { kind: "nebula", albumKey: "album:7" },
      global: null,
    });
  });

  it("reads an alias as its current kind and writes the current kind on a pick", () => {
    applyPluginRows([visRow("com.example.vis", "Example", [decl({ aliases: ["rings"] })])]);
    const alias = "com.example.vis/rings";
    const stored = input({ global: alias });
    expect(resolveVisualizer(stored).picked).toBe(AURORA);
    expect(resolveVisualizer(input({ albumDefault: alias })).defaultKind).toBe(AURORA);
    expect(applyManualPick(stored, alias)).toEqual({ override: null, global: AURORA });
  });
});
