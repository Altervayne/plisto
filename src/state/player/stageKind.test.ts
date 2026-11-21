import { beforeEach, describe, expect, it } from "vitest";
import { applyPluginRows, type PluginKindId } from "./pluginVisualizers";
import { visualizerDecl as decl, visualizerRow as visRow } from "../plugins/fixtures";
import { stageKind } from "./visualizerResolve";

const RINGS = "com.example.rings/aurora-rings" as PluginKindId;
const FINE = { glFailed: false, coverPixels: true };

beforeEach(() => {
  const needs = { fine: false, cover: true, pointer: false, waveform: false };
  applyPluginRows([visRow("com.example.rings", "Rings", [decl({ needs })])]);
});

describe("stageKind", () => {
  it("keeps the built-in fallbacks", () => {
    expect(stageKind("nebula", FINE)).toBe("nebula");
    expect(stageKind("nebula", { ...FINE, glFailed: true })).toBe("ridge");
    expect(stageKind("ridge", { ...FINE, glFailed: true })).toBe("ridge");
  });

  it("falls a plugin kind to Ridge when its frame failed or its cover is missing", () => {
    expect(stageKind(RINGS, FINE)).toBe(RINGS);
    expect(stageKind(RINGS, { ...FINE, glFailed: true })).toBe("ridge");
    expect(stageKind(RINGS, { ...FINE, coverPixels: false })).toBe("ridge");
  });
});
