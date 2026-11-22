// -- Test Imports --
import { beforeEach, describe, expect, it } from "vitest";

// -- Unit Imports --
import {
  applyPreset,
  kindValues,
  kindValuesKey,
  matchingPreset,
  parseSettingsPref,
  withKindValues,
} from "./kindSettings";

// -- State Imports --
import { pluginVisualizer, type PluginVisualizerDescriptor } from "../pluginVisualizers";
import { usePluginsStore } from "../../plugins/store";
import { visualizerDecl as decl, visualizerRow as visRow } from "../../plugins/fixtures";

const KIND = "com.example.rings/aurora-rings";

function descriptor(): PluginVisualizerDescriptor {
  return pluginVisualizer(KIND)!;
}

beforeEach(() => {
  usePluginsStore.setState({
    rows: [
      visRow("com.example.rings", "Rings", [
        decl({
          settings: [
            {
              id: "layout",
              label: "Layout",
              type: "choice",
              options: [
                { id: "left", label: "Left" },
                { id: "mirrored", label: "Mirrored" },
              ],
              default: "left",
            },
            { id: "glow", label: "Glow", type: "toggle", default: false },
            { id: "size", label: "Size", type: "range", min: 1, max: 10, step: 1, default: 4 },
            { id: "tint", label: "Tint", type: "color", default: "cover" },
          ],
          presets: [
            { id: "calm", label: "Calm", values: { layout: "mirrored", size: 2 } },
            { id: "blue", label: "Blue", values: { tint: "#3a6ea5" } },
          ],
        }),
      ]),
    ],
  });
});

describe("kind settings", () => {
  it("reads the declared defaults when nothing is stored", () => {
    const defaults = { layout: "left", glow: false, size: 4, tint: "cover" };
    expect(kindValues(descriptor(), undefined)).toEqual(defaults);
    expect(kindValues(descriptor(), "")).toEqual(defaults);
    expect(kindValues(descriptor(), "not json")).toEqual(defaults);
    expect(kindValues(descriptor(), "[1,2]")).toEqual(defaults);
    expect(kindValues(descriptor(), JSON.stringify({ other: { glow: true } }))).toEqual(defaults);
  });

  it("falls back to the default for each invalid value and keeps the valid ones", () => {
    const raw = JSON.stringify({
      [KIND]: { layout: "diagonal", glow: "yes", size: "big", tint: "red", extra: 1 },
    });
    expect(kindValues(descriptor(), raw)).toEqual({ layout: "left", glow: false, size: 4, tint: "cover" });
    const good = JSON.stringify({ [KIND]: { layout: "mirrored", glow: true, size: 7, tint: "#aabbcc" } });
    expect(kindValues(descriptor(), good)).toEqual({
      layout: "mirrored",
      glow: true,
      size: 7,
      tint: "#aabbcc",
    });
  });

  it("clamps a number into its range and ignores a setting the kind no longer declares", () => {
    const raw = JSON.stringify({ [KIND]: { size: 99, removed: "left" } });
    const values = kindValues(descriptor(), raw);
    expect(values.size).toBe(10);
    expect("removed" in values).toBe(false);
  });

  it("stores only values that differ from the defaults and keeps other kinds", () => {
    const other = JSON.stringify({ "a.b.c/d": { x: 1 } });
    const mirrored = { layout: "mirrored", glow: false, size: 4, tint: "cover" };
    const raw = withKindValues(other, descriptor(), mirrored);
    expect(parseSettingsPref(raw)).toEqual({ "a.b.c/d": { x: 1 }, [KIND]: { layout: "mirrored" } });
    const back = withKindValues(raw, descriptor(), { layout: "left", glow: false, size: 4, tint: "cover" });
    expect(parseSettingsPref(back)).toEqual({ "a.b.c/d": { x: 1 } });
  });

  it("reads as custom when the values match no preset and applies a preset over the current values", () => {
    const base = kindValues(descriptor(), undefined);
    expect(matchingPreset(descriptor(), base)).toBeNull();
    const calm = applyPreset(descriptor(), { ...base, glow: true }, "calm");
    expect(calm).toEqual({ layout: "mirrored", glow: true, size: 2, tint: "cover" });
    expect(matchingPreset(descriptor(), calm)).toBe("calm");
    expect(matchingPreset(descriptor(), { ...calm, size: 3 })).toBeNull();
    expect(matchingPreset(descriptor(), applyPreset(descriptor(), base, "blue"))).toBe("blue");
  });

  it("leaves the values alone for a preset that does not exist", () => {
    const base = kindValues(descriptor(), undefined);
    expect(applyPreset(descriptor(), base, "gone")).toBe(base);
  });
});

describe("kind settings key", () => {
  it("stays the same when only another kind's settings change, and changes with this kind's", () => {
    const key = (raw: string) => kindValuesKey(kindValues(descriptor(), raw));
    const before = key(JSON.stringify({ other: { glow: true } }));
    expect(key(JSON.stringify({ other: { glow: false, size: 9 } }))).toBe(before);
    expect(key(JSON.stringify({ [descriptor().id]: { glow: true } }))).not.toBe(before);
  });

  it("reads equal values as equal whatever their order", () => {
    expect(kindValuesKey({ a: 1, b: "x" })).toBe(kindValuesKey({ b: "x", a: 1 }));
  });
});
