import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FeedRecordError,
  RECORD_KEEP_MIN_SECS,
  RECORD_MAX_BYTES,
  RECORD_ALIVE_MS,
  RECORD_MS,
  startFeedRecording,
  stopFeedRecording,
  type RecordDeps,
  type RecordRefusal,
} from "./recordFeed";
import { feedRecording, RESULT_MS } from "./feedRecording";
import { restSignal } from "../visualSignal";

import type { Tick } from "../../../visRuntime/protocol";
import type { StageHandle } from "./frameCache";

const KIND = "com.example.rings/aurora";
// The kit harness's own reader, imported as the harness runs it.
const FEEDS = "../../../../plugin-kit/visualizers/harness/feeds.js";
type Parsed = { t: number; dt: number; nBeats: number; sig: Record<string, unknown>; wave: unknown }[];
const parse = async (json: unknown) => {
  const mod = (await import(/* @vite-ignore */ FEEDS)) as { parseRecording: (j: unknown) => Parsed };
  return mod.parseRecording(json);
};

function tick(seq: number, over: Partial<Tick> = {}): Tick {
  const sig = restSignal();
  sig.bands = Float32Array.from({ length: 24 }, (_, i) => (i + seq) / 100);
  sig.beat = seq % 5 === 0 ? 0.8 : 0;
  return {
    seq,
    t: 100 + seq / 30,
    dt: 1 / 30,
    sig,
    nBeats: seq % 5 === 0 ? 1 : 0,
    beatAt: seq % 5 === 0 ? 100 + seq / 30 : null,
    rawBands: Array.from({ length: 24 }, (_, i) => i / 24),
    fine: null,
    playing: true,
    trackSeq: 2,
    progress: 0.25,
    pointer: null,
    wave: Float32Array.from([0.1, -0.2, 0.3]),
    ...over,
  };
}

function setup(over: Partial<RecordDeps> = {}) {
  const state = { dev: true, shown: true, listed: true, phase: "ready" };
  const handle = {
    kind: KIND,
    shown: () => state.shown,
    phase: () => state.phase,
    stats: () => null,
  } as unknown as StageHandle;
  let listener: ((t: Tick) => void) | null = null;
  const watchers = new Set<() => void>();
  const saved: { pluginId: string; kindId: string; json: string }[] = [];
  const deps: RecordDeps = {
    devMode: () => state.dev,
    stages: () => (state.listed ? [handle] : []),
    watch: (notify) => {
      watchers.add(notify);
      return () => watchers.delete(notify);
    },
    tapOf: () => (fn) => {
      listener = fn;
      return () => {
        listener = null;
      };
    },
    save: (pluginId, kindId, json) => {
      saved.push({ pluginId, kindId, json });
      return Promise.resolve("C:/data/feeds/feed-x.json");
    },
    ...over,
  };
  return {
    state,
    saved,
    start: () => startFeedRecording(KIND, deps),
    feed: (t: Tick) => listener?.(t),
    listening: () => listener !== null,
    leave: () => {
      state.listed = false;
      watchers.forEach((notify) => notify());
    },
  };
}

const reasonOf = async (p: Promise<unknown>): Promise<RecordRefusal | string> => {
  try {
    await p;
    return "resolved";
  } catch (e) {
    return e instanceof FeedRecordError ? e.reason : String(e);
  }
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("what is written", () => {
  it("is read by the harness's own parser, with time from zero and every field kept", async () => {
    const s = setup();
    const done = s.start();
    for (let i = 1; i <= 90; i++) s.feed(tick(i));
    await vi.advanceTimersByTimeAsync(RECORD_MS);
    await expect(done).resolves.toEqual({ path: "C:/data/feeds/feed-x.json" });
    expect(s.saved).toHaveLength(1);
    expect(s.saved[0].pluginId).toBe("com.example.rings");
    expect(s.saved[0].kindId).toBe("aurora");
    const parsed = await parse(JSON.parse(s.saved[0].json));
    expect(parsed).toHaveLength(90);
    expect(parsed[0].t).toBe(0);
    expect(parsed[89].t).toBeCloseTo(89 / 30, 5);
    expect(parsed[0].dt).toBeCloseTo(1 / 30, 5);
    expect(parsed[4].nBeats).toBe(1);
    expect(parsed[4].sig.beat).toBeCloseTo(0.8, 4);
    const bands = Array.from(parsed[0].sig.bands as Float32Array);
    expect(bands).toHaveLength(24);
    expect(bands[0]).toBeCloseTo(0.01, 4);
    expect(bands[1]).toBeCloseTo(0.02, 4);
    expect(Array.from(parsed[0].wave as Float32Array)).toHaveLength(3);
  });

  it("carries a folded tick as the frame received it", async () => {
    const s = setup();
    const done = s.start();
    s.feed(tick(1));
    s.feed(tick(2, { dt: 0.1, nBeats: 3 }));
    await vi.advanceTimersByTimeAsync(RECORD_MS);
    await done;
    const parsed = await parse(JSON.parse(s.saved[0].json));
    expect(parsed.map((p) => p.dt)).toEqual([expect.closeTo(1 / 30, 5), 0.1]);
    expect(parsed[1].nBeats).toBe(3);
  });
});

describe("refusals", () => {
  it("refuses while developer mode is off, touching nothing", async () => {
    const s = setup();
    s.state.dev = false;
    expect(await reasonOf(s.start())).toBe("dev_mode_off");
    expect(s.listening()).toBe(false);
  });

  it("refuses a kind with no live, shown stage frame", async () => {
    const s = setup();
    s.state.shown = false;
    expect(await reasonOf(s.start())).toBe("not_on_stage");
    s.state.shown = true;
    s.state.phase = "mounting";
    expect(await reasonOf(s.start())).toBe("not_on_stage");
    s.state.phase = "ready";
    s.state.listed = false;
    expect(await reasonOf(s.start())).toBe("not_on_stage");
    expect(await reasonOf(setup({ tapOf: () => null }).start())).toBe("not_on_stage");
  });

  it("refuses a second recording while one runs, and allows one after it ends", async () => {
    const s = setup();
    const first = s.start();
    expect(await reasonOf(s.start())).toBe("busy");
    s.feed(tick(1));
    await vi.advanceTimersByTimeAsync(RECORD_MS);
    await first;
    const again = reasonOf(s.start());
    expect(s.listening()).toBe(true);
    await vi.advanceTimersByTimeAsync(RECORD_MS);
    expect(await again).toBe("stage_left");
  });
});

describe("a frame that leaves mid-recording", () => {
  const feedSeconds = (s: ReturnType<typeof setup>, secs: number) => {
    for (let i = 1; i <= secs * 30; i++) s.feed(tick(i));
  };

  it("rejects with stage_left when under three seconds were recorded", async () => {
    const s = setup();
    const done = s.start();
    feedSeconds(s, RECORD_KEEP_MIN_SECS - 1);
    s.leave();
    expect(await reasonOf(done)).toBe("stage_left");
    expect(s.saved).toEqual([]);
    expect(s.listening()).toBe(false);
  });

  it("keeps what was recorded at three seconds or more", async () => {
    const s = setup();
    const done = s.start();
    feedSeconds(s, RECORD_KEEP_MIN_SECS + 1);
    s.leave();
    await expect(done).resolves.toEqual({ path: "C:/data/feeds/feed-x.json" });
    expect(await parse(JSON.parse(s.saved[0].json))).toHaveLength((RECORD_KEEP_MIN_SECS + 1) * 30);
  });

  it("ends early on a stop and keeps what was recorded at three seconds or more", async () => {
    const s = setup();
    const done = s.start();
    feedSeconds(s, RECORD_KEEP_MIN_SECS + 1);
    stopFeedRecording();
    await expect(done).resolves.toEqual({ path: "C:/data/feeds/feed-x.json" });
    expect(s.listening()).toBe(false);
  });

  it("rejects a stop under three seconds as too_short, and ignores an idle stop", async () => {
    stopFeedRecording();
    const s = setup();
    const done = s.start();
    feedSeconds(s, 1);
    stopFeedRecording();
    expect(await reasonOf(done)).toBe("too_short");
    expect(s.saved).toEqual([]);
  });

  it("rejects a stop before any tick as too_short", async () => {
    const s = setup();
    const done = s.start();
    stopFeedRecording();
    expect(await reasonOf(done)).toBe("too_short");
  });

  it("publishes recording, saving and the outcome for any chip to read", async () => {
    const s = setup();
    const done = s.start();
    expect(feedRecording()).toMatchObject({ kind: KIND, phase: "recording" });
    feedSeconds(s, RECORD_KEEP_MIN_SECS + 1);
    stopFeedRecording();
    expect(feedRecording().phase).toBe("saving");
    await done;
    expect(feedRecording()).toMatchObject({
      kind: KIND,
      phase: "idle",
      outcome: { ok: true, path: "C:/data/feeds/feed-x.json" },
    });
    await vi.advanceTimersByTimeAsync(RESULT_MS);
    expect(feedRecording().outcome).toBeNull();
  });

  it("publishes a lost stage as stage_left", async () => {
    const s = setup();
    const done = s.start();
    s.leave();
    await reasonOf(done);
    expect(feedRecording().outcome).toEqual({ ok: false, reason: "stage_left", detail: null });
  });

  it("ends on its own clock when the frame is hidden and ticks stop, keeping 3 s or more", async () => {
    const s = setup();
    const done = s.start();
    feedSeconds(s, 4);
    s.state.shown = false;
    await vi.advanceTimersByTimeAsync(RECORD_ALIVE_MS);
    await expect(done).resolves.toBeDefined();
    expect(s.saved).toHaveLength(1);
    expect(s.listening()).toBe(false);
    expect(await parse(JSON.parse(s.saved[0].json))).toHaveLength(120);
  });

  it("rejects when the frame is hidden with under three seconds recorded and no tick follows", async () => {
    const s = setup();
    const done = reasonOf(s.start());
    feedSeconds(s, 1);
    s.state.phase = "mounting";
    await vi.advanceTimersByTimeAsync(RECORD_ALIVE_MS);
    expect(await done).toBe("stage_left");
    expect(s.saved).toEqual([]);
  });

  it("rejects when nothing at all was recorded", async () => {
    const s = setup();
    const done = s.start();
    s.leave();
    expect(await reasonOf(done)).toBe("stage_left");
  });
});

describe("the end of a recording", () => {
  it("runs for the full time, then stops listening", async () => {
    const s = setup();
    const done = s.start();
    s.feed(tick(1));
    await vi.advanceTimersByTimeAsync(RECORD_MS - 1);
    expect(s.saved).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(s.saved).toHaveLength(1);
    expect(s.listening()).toBe(false);
  });

  it("ends early at the size limit and saves what it has", async () => {
    const s = setup();
    const done = s.start();
    const big = (seq: number) => tick(seq, { fine: Array.from({ length: 128 }, (_, i) => i / 128) });
    let fed = 0;
    while (s.listening() && fed < 100_000) s.feed(big(++fed));
    await done;
    expect(s.saved).toHaveLength(1);
    expect(s.saved[0].json.length).toBeLessThan(8 * 1024 * 1024);
    expect(s.saved[0].json.length).toBeGreaterThan(RECORD_MAX_BYTES - 64 * 1024);
  });

  it("types a failed save as save_failed with its message", async () => {
    const s = setup({ save: () => Promise.reject({ code: "io", detail: "disk full" }) });
    const done = s.start().catch((e: FeedRecordError) => e);
    s.feed(tick(1));
    await vi.advanceTimersByTimeAsync(RECORD_MS);
    const error = (await done) as FeedRecordError;
    expect([error.reason, error.detail]).toEqual(["save_failed", "disk full"]);
  });

  it("types the command's dev_mode_off refusal as dev_mode_off", async () => {
    const refusal = { code: "dev_mode_off", detail: "developer mode is off" };
    const s = setup({ save: () => Promise.reject(refusal) });
    const done = reasonOf(s.start());
    s.feed(tick(1));
    await vi.advanceTimersByTimeAsync(RECORD_MS);
    expect(await done).toBe("dev_mode_off");
  });

  it("saves nothing when developer mode went off mid-recording", async () => {
    const s = setup();
    const done = reasonOf(s.start());
    s.feed(tick(1));
    s.state.dev = false;
    await vi.advanceTimersByTimeAsync(RECORD_MS);
    expect(await done).toBe("dev_mode_off");
    expect(s.saved).toEqual([]);
  });
});
