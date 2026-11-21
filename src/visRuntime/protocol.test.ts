import { describe, expect, it } from "vitest";

import {
  createTickSender,
  foldTick,
  MAX_CARRY,
  readFrameMessage,
  readHostMessage,
  readInit,
  SIGNAL_FOLD,
  VIS_INIT_TYPE,
} from "./protocol";
import { restSignal } from "../state/player/visualSignal";

import type { Tick } from "./protocol";
import type { VisualSignal } from "../state/player/visualSignal";

function tick(seq: number, over: Partial<Tick> = {}, sig: Partial<VisualSignal> = {}): Tick {
  return {
    seq,
    t: seq / 30,
    dt: 1 / 30,
    sig: { ...restSignal(), ...sig },
    nBeats: 0,
    beatAt: null,
    rawBands: [],
    fine: null,
    playing: true,
    trackSeq: 1,
    progress: null,
    pointer: null,
    wave: null,
    ...over,
  };
}

describe("signal folding", () => {
  it("classifies every signal field", () => {
    expect(Object.keys(SIGNAL_FOLD).sort()).toEqual(Object.keys(restSignal()).sort());
  });

  it("keeps the max of exactly the one-frame events", () => {
    expect([...MAX_CARRY].sort()).toEqual(
      ["beat", "beatWeight", "bassHit", "cut", "flux", "highHit", "kick", "midHit", "surge"].sort(),
    );
  });

  it("sums dt and beats, carries event maxima, and takes the latest of the rest", () => {
    const a = tick(1, { nBeats: 1, beatAt: 3.2 }, { beat: 0.9, kick: 0.2, level: 0.3, surge: 1 });
    const b = tick(2, { nBeats: 2, beatAt: 3.5 }, { beat: 0.1, kick: 0.6, level: 0.5, surge: 0 });
    const f = foldTick(a, b);
    expect(f.seq).toBe(2);
    expect(f.dt).toBeCloseTo(2 / 30);
    expect(f.nBeats).toBe(3);
    expect(f.beatAt).toBe(3.5);
    expect(f.sig.beat).toBe(0.9);
    expect(f.sig.kick).toBe(0.6);
    expect(f.sig.surge).toBe(1);
    expect(f.sig.level).toBe(0.5);
  });
});

describe("tick sender", () => {
  it("holds and folds past its credit, then sends the fold on an ack", () => {
    const sent: Tick[] = [];
    const sender = createTickSender((t) => sent.push(t));
    for (let i = 1; i <= 5; i++) sender.offer(tick(i, { nBeats: i === 4 ? 1 : 0 }));
    expect(sent.map((t) => t.seq)).toEqual([1, 2]);
    expect(sender.outstanding()).toBe(2);
    sender.ack(1);
    expect(sent.map((t) => t.seq)).toEqual([1, 2, 5]);
    expect(sent[2].dt).toBeCloseTo(3 / 30);
    expect(sent[2].nBeats).toBe(1);
    expect(sender.outstanding()).toBe(2);
  });

  it("frees every tick up to a cumulative ack", () => {
    const sender = createTickSender(() => {});
    sender.offer(tick(1));
    sender.offer(tick(2));
    sender.ack(2);
    expect(sender.outstanding()).toBe(0);
  });

  it("forgets everything on reset", () => {
    const sent: Tick[] = [];
    const sender = createTickSender((t) => sent.push(t));
    for (let i = 1; i <= 3; i++) sender.offer(tick(i));
    sender.reset();
    expect(sender.outstanding()).toBe(0);
    sender.ack(2);
    expect(sent).toHaveLength(2);
  });
});

describe("message reading", () => {
  it("reads an init and rejects anything short of one", () => {
    const init = {
      plisto: 1,
      type: VIS_INIT_TYPE,
      api: 1,
      kind: "p.k",
      composite: { light: "ink", dark: "light" },
      fillsStage: true,
      needs: { fine: false, cover: true, pointer: false, waveform: false },
      settingShapes: [],
      context: {},
    };
    expect(readInit(init)).toBe(init);
    expect(readInit({ ...init, plisto: 2 })).toBeNull();
    expect(readInit({ ...init, settingShapes: undefined })).toBeNull();
    expect(readInit("plisto:vis-init")).toBeNull();
  });

  it("reads host messages and drops malformed or unknown ones", () => {
    expect(readHostMessage({ type: "tick", ...tick(3) })).not.toBeNull();
    expect(readHostMessage({ type: "tick", ...tick(3), dt: -1 })).toBeNull();
    expect(readHostMessage({ type: "tick", ...tick(3), seq: 1.5 })).toBeNull();
    expect(readHostMessage({ type: "still", id: 4 })).toEqual({ type: "still", id: 4 });
    expect(readHostMessage({ type: "update" })).toBeNull();
    expect(readHostMessage({ type: "dispose", extra: 1 })).toEqual({ type: "dispose" });
    expect(readHostMessage({ type: "unknown" })).toBeNull();
    expect(readHostMessage(null)).toBeNull();
  });

  it("reads frame messages and drops malformed or unknown ones", () => {
    expect(readFrameMessage({ type: "ack", seq: 2, ms: null })).not.toBeNull();
    expect(readFrameMessage({ type: "ack", seq: 2, ms: 3.5 })).not.toBeNull();
    expect(readFrameMessage({ type: "ack", seq: 2 })).toBeNull();
    expect(readFrameMessage({ type: "ready", metered: true })).not.toBeNull();
    expect(readFrameMessage({ type: "ready" })).toBeNull();
    expect(readFrameMessage({ type: "lost" })).toEqual({ type: "lost" });
    expect(readFrameMessage({ type: "error", stage: "compile", message: "x" })).not.toBeNull();
    expect(readFrameMessage({ type: "log", level: "info" })).toBeNull();
    expect(readFrameMessage({ type: "ping" })).toBeNull();
  });
});
