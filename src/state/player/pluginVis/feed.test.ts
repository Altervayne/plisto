import { describe, expect, it, vi } from "vitest";
import { BAND_COUNT, type LevelFrame } from "../../../types";
import { SIGNAL_FOLD } from "../../../visRuntime/protocol";
import { createWaveHub } from "./waveform";
import { createFeed, type FeedSources } from "./feed";

const needsNone = { fine: false, cover: false, pointer: false, waveform: false };
const bandsOf = (v: number) => new Array(BAND_COUNT).fill(v);

function setup(needs = needsNone) {
  const state = {
    bands: bandsOf(0),
    level: { rms: 0.5, peak: 0.6, flux: 0 } as LevelFrame,
    fine: [0.2, 0.4] as number[] | null,
    pointer: null as { x: number; y: number; inside: boolean } | null,
    status: { playing: true, track_id: 1, start_seq: 1, position_secs: 30, duration_secs: 120 },
  };
  const releaseFine = vi.fn();
  const acquireFine = vi.fn(() => releaseFine);
  const setEmit = vi.fn((_on: boolean) => Promise.resolve());
  const waves = createWaveHub({ setEmit, follow: () => () => {} });
  const sources: FeedSources = {
    bands: () => state.bands,
    level: () => state.level,
    fine: () => state.fine,
    status: () => state.status,
    pointer: () => state.pointer,
    acquireFine,
    waves,
  };
  const feed = createFeed({ needs, reactivity: () => "balanced", sources });
  let now = 0;
  const step = () => feed.step((now += 33));
  return { state, feed, step, sources, acquireFine, releaseFine, setEmit, waves };
}

// A loud frame after quiet ones reads as an onset; the quiet run clears the refractory gap.
function fireBeat(s: ReturnType<typeof setup>, level: LevelFrame) {
  for (let i = 0; i < 14; i++) {
    s.state.bands = bandsOf(0);
    s.step();
  }
  s.state.bands = bandsOf(0.9);
  s.state.level = level;
  return s.step();
}

describe("feed ticks", () => {
  it("numbers ticks, reports the real gap and a snapshot of the signal", () => {
    const s = setup();
    const a = s.step();
    const b = s.step();
    expect(b.seq).toBe(a.seq + 1);
    expect(b.dt).toBeCloseTo(0.033);
    expect(Object.keys(b.sig).sort()).toEqual(Object.keys(SIGNAL_FOLD).sort());
    expect(b.sig.bands).not.toBe(a.sig.bands);
    expect(b.rawBands).toBe(s.state.bands);
  });

  it("reports playing and progress, and null progress without a duration", () => {
    const s = setup();
    expect(s.step()).toMatchObject({ playing: true, progress: 0.25 });
    s.state.status = { ...s.state.status, playing: false, duration_secs: 0 };
    expect(s.step()).toMatchObject({ playing: false, progress: null });
  });

  it("bumps trackSeq on a new item and not on a steady one", () => {
    const s = setup();
    const first = s.step().trackSeq;
    expect(s.step().trackSeq).toBe(first);
    s.state.status = { ...s.state.status, track_id: 2 };
    expect(s.step().trackSeq).toBe(first + 1);
    s.state.status = { ...s.state.status, start_seq: 2 };
    expect(s.step().trackSeq).toBe(first + 2);
  });

  it("stamps a beat with the level frame time and counts it", () => {
    const s = setup();
    expect(s.step().beatAt).toBeNull();
    const tick = fireBeat(s, { rms: 0.8, peak: 0.9, flux: 0.5, at: 12.5 });
    expect(tick.nBeats).toBe(1);
    expect(tick.beatAt).toBe(12.5);
    expect(s.step().beatAt).toBe(12.5);
  });

  it("gives no beatAt for a beat whose level frame has no time", () => {
    const s = setup();
    fireBeat(s, { rms: 0.8, peak: 0.9, flux: 0.5, at: 12.5 });
    const tick = fireBeat(s, { rms: 0.8, peak: 0.9, flux: 0.5 });
    expect(tick.nBeats).toBe(1);
    expect(tick.beatAt).toBeNull();
  });
});

describe("optional fields", () => {
  it("leaves fine, pointer and wave null for a kind that asks for none", () => {
    const s = setup();
    s.feed.setVisible(true);
    s.state.pointer = { x: 0.5, y: 0.5, inside: true };
    expect(s.step()).toMatchObject({ fine: null, pointer: null, wave: null });
    expect(s.acquireFine).not.toHaveBeenCalled();
    expect(s.setEmit).not.toHaveBeenCalled();
  });

  it("requests and reads the fine spectrum only for a needs.fine kind while visible", () => {
    const s = setup({ ...needsNone, fine: true });
    expect(s.step().fine).toBeNull();
    expect(s.acquireFine).not.toHaveBeenCalled();
    s.feed.setVisible(true);
    s.feed.setVisible(true);
    expect(s.acquireFine).toHaveBeenCalledTimes(1);
    expect(s.step().fine).not.toBeNull();
    s.feed.setVisible(false);
    expect(s.releaseFine).toHaveBeenCalledTimes(1);
    expect(s.step().fine).toBeNull();
  });

  it("passes the pointer only for a needs.pointer kind", () => {
    const s = setup({ ...needsNone, pointer: true });
    s.state.pointer = { x: 0.2, y: 0.9, inside: true };
    expect(s.step().pointer).toEqual({ x: 0.2, y: 0.9, inside: true });
  });

  it("holds the waveform emit only while a waveform kind is visible, across mounts", () => {
    const wave = { ...needsNone, waveform: true };
    const a = setup(wave);
    expect(a.step().wave).toBeNull();
    expect(a.setEmit).not.toHaveBeenCalled();
    a.feed.setVisible(true);
    expect(a.setEmit.mock.calls).toEqual([[true]]);
    // A second mount on the same hub keeps the emit on after the first goes.
    const other = createFeed({ needs: wave, reactivity: () => "balanced", sources: a.sources });
    other.setVisible(true);
    expect(a.waves.holders()).toBe(2);
    a.feed.setVisible(false);
    expect(a.setEmit).toHaveBeenCalledTimes(1);
    other.dispose();
    expect(a.setEmit.mock.calls).toEqual([[true], [false]]);
  });
});
