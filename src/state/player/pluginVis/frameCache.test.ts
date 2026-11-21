import { beforeEach, describe, expect, it } from "vitest";
import { applyPluginRows, type PluginKindId } from "../pluginVisualizers";
import { visualizerDecl as decl, visualizerRow as visRow } from "../../plugins/fixtures";
import {
  FRAME_KEEP_MS,
  PLUGIN_PREVIEW_DWELL_MS,
  STAGE_FALLBACK,
  isFrameWanted,
  keepStep,
  keptFrames,
  leavePhase,
  liveFrames,
  phaseOf,
  pluginLoading,
  previewDwellMs,
  reportPhase,
  stageAim,
  useFrameCache,
  wantFrame,
  type FrameKeep,
} from "./frameCache";

const RINGS = "com.example.rings/aurora-rings" as PluginKindId;
const WAVES = "com.example.waves/aurora-rings" as PluginKindId;
const never = () => false;

beforeEach(() => {
  useFrameCache.setState({ wants: {}, phases: {} });
  applyPluginRows([visRow("com.example.rings", "Rings", [decl()])]);
});

describe("stageAim", () => {
  it("passes built-in kinds through untouched", () => {
    expect(stageAim("nebula", true, undefined, false)).toEqual({ target: "nebula", ready: true });
    expect(stageAim("nebula", false, "slow", false)).toEqual({ target: "nebula", ready: false });
    expect(stageAim("ridge", true, undefined, false)).toEqual({ target: "ridge", ready: true });
    expect(stageAim("off", true, undefined, false)).toEqual({ target: "off", ready: true });
  });

  it("holds the outgoing kind while a plugin frame compiles", () => {
    expect(stageAim(RINGS, true, undefined, true)).toEqual({ target: RINGS, ready: false });
    expect(stageAim(RINGS, true, "mounting", true)).toEqual({ target: RINGS, ready: false });
  });

  it("aims at the plugin kind once its frame drew", () => {
    expect(stageAim(RINGS, true, "ready", true)).toEqual({ target: RINGS, ready: true });
  });

  it("shows the fallback while slow, given up on or failed, and for a kind not installed", () => {
    const fallback = { target: STAGE_FALLBACK, ready: true };
    expect(stageAim(RINGS, true, "slow", true)).toEqual(fallback);
    expect(stageAim(RINGS, true, "dropped", true)).toEqual(fallback);
    expect(stageAim(RINGS, true, "failed", true)).toEqual(fallback);
    expect(stageAim(WAVES, true, undefined, false)).toEqual(fallback);
  });

  it("keeps holding a plugin kind that waits on something else", () => {
    expect(stageAim(RINGS, false, "slow", true)).toEqual({ target: RINGS, ready: false });
  });
});

describe("phases", () => {
  it("keeps each surface's phase apart", () => {
    reportPhase("player", RINGS, "ready");
    reportPhase("ambient", RINGS, "mounting");
    expect(phaseOf("player", RINGS)).toBe("ready");
    expect(phaseOf("ambient", RINGS)).toBe("mounting");
    expect(phaseOf("player", WAVES)).toBeUndefined();
  });

  it("forgets a leaving stage's phase but holds a given-up one", () => {
    reportPhase("player", RINGS, "mounting");
    leavePhase("player", RINGS);
    expect(useFrameCache.getState().phases).toEqual({});
    reportPhase("player", RINGS, "dropped");
    leavePhase("player", RINGS);
    expect(phaseOf("player", RINGS)).toBe("dropped");
  });

  it("clears a given-up phase on the surface's first aim, so aiming again retries", () => {
    reportPhase("player", RINGS, "dropped");
    reportPhase("ambient", RINGS, "dropped");
    const release = wantFrame("player", RINGS);
    expect(phaseOf("player", RINGS)).toBeUndefined();
    expect(phaseOf("ambient", RINGS)).toBe("dropped");
    expect(isFrameWanted("player", RINGS)).toBe(true);
    expect(isFrameWanted("ambient", RINGS)).toBe(false);
    reportPhase("player", RINGS, "failed");
    const second = wantFrame("player", RINGS);
    expect(phaseOf("player", RINGS)).toBe("failed");
    release();
    release();
    expect(isFrameWanted("player", RINGS)).toBe(true);
    second();
    expect(isFrameWanted("player", RINGS)).toBe(false);
  });

  it("reads an installed plugin kind as loading until its frame draws or ends", () => {
    expect(pluginLoading(RINGS, undefined)).toBe(true);
    expect(pluginLoading(RINGS, "slow")).toBe(true);
    expect(pluginLoading(RINGS, "ready")).toBe(false);
    expect(pluginLoading(RINGS, "dropped")).toBe(false);
    expect(pluginLoading(WAVES, undefined)).toBe(false);
    expect(pluginLoading("nebula", undefined)).toBe(false);
  });
});

describe("kept frames", () => {
  it("lists the shown plugin kind first, then the aimed ones, minus ended ones", () => {
    expect(liveFrames(RINGS, [WAVES, RINGS], never)).toEqual([RINGS, WAVES]);
    expect(liveFrames("nebula", [WAVES], never)).toEqual([WAVES]);
    expect(liveFrames(RINGS, [], (kind) => kind === RINGS)).toEqual([]);
  });

  it("keeps the frame that left for the keep time", () => {
    const start: FrameKeep = { live: [RINGS], kept: null };
    const after = keepStep(start, [], 1000, never);
    expect(after.kept).toEqual({ kind: RINGS, until: 1000 + FRAME_KEEP_MS });
    expect(keptFrames(after, never)).toEqual([RINGS]);
    expect(keepStep(after, [RINGS], 2000, never)).toEqual({ live: [RINGS], kept: null });
  });

  it("keeps only the last frame to leave, the shown one first", () => {
    const start: FrameKeep = { live: [RINGS, WAVES], kept: null };
    expect(keepStep(start, [], 0, never).kept?.kind).toBe(RINGS);
    const one = keepStep({ live: [RINGS], kept: null }, [WAVES], 0, never);
    const two = keepStep(one, [], 5, never);
    expect(two.kept?.kind).toBe(WAVES);
  });

  it("never keeps an ended frame", () => {
    const gone = (kind: PluginKindId) => kind === RINGS;
    expect(keepStep({ live: [RINGS], kept: null }, [], 0, gone).kept).toBeNull();
    const kept: FrameKeep = { live: [], kept: { kind: RINGS, until: 99 } };
    expect(keptFrames(kept, gone)).toEqual([]);
  });
});

describe("previewDwellMs", () => {
  it("gives plugin tiles the longer dwell and leaves built-ins alone", () => {
    expect(previewDwellMs("nebula", 120)).toBe(120);
    expect(previewDwellMs(null, 120)).toBe(120);
    expect(previewDwellMs(RINGS, 120)).toBe(PLUGIN_PREVIEW_DWELL_MS);
  });
});
