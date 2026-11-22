import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  baseName,
  createFeedControl,
  IDLE_FEED,
  type FeedControl,
  type FeedDeps,
  type FeedState,
} from "./feedControl";
import {
  feedRecording,
  NO_RECORDING,
  publishFeedRecording,
  RESULT_MS,
  subscribeFeedRecording,
} from "./feedRecording";
import { FeedRecordError } from "./recordFeed";

const KIND = "com.example.rings/aurora";

function setup() {
  const clock = { now: 1000 };
  const rejects: ((e: unknown) => void)[] = [];
  const deps: FeedDeps = {
    start: vi.fn(() => new Promise<{ path: string }>((_, reject) => rejects.push(reject))),
    stop: vi.fn(),
    now: () => clock.now,
    read: feedRecording,
    subscribe: subscribeFeedRecording,
  };
  const mount = () => {
    const states: FeedState[] = [];
    const control: FeedControl = createFeedControl(KIND, (s) => states.push(s), deps);
    return { control, last: () => states[states.length - 1] ?? IDLE_FEED, states };
  };
  return { clock, deps, rejects, mount };
}

beforeEach(() => {
  vi.useFakeTimers();
  publishFeedRecording(NO_RECORDING);
});
afterEach(() => {
  publishFeedRecording(NO_RECORDING);
  vi.useRealTimers();
});

describe("the Record feed control", () => {
  it("starts on a press and counts seconds, capped at thirty", () => {
    const s = setup();
    const chip = s.mount();
    chip.control.press();
    expect(s.deps.start).toHaveBeenCalledWith(KIND);
    publishFeedRecording({ kind: KIND, phase: "recording", startedAt: s.clock.now, outcome: null });
    expect(chip.last()).toEqual({ phase: "recording", secs: 0, outcome: null });
    s.clock.now += 3200;
    vi.advanceTimersByTime(250);
    expect(chip.last().secs).toBe(3);
    s.clock.now += 60_000;
    vi.advanceTimersByTime(250);
    expect(chip.last().secs).toBe(30);
  });

  it("ends the running recording early on a second press", () => {
    const s = setup();
    const chip = s.mount();
    publishFeedRecording({ kind: KIND, phase: "recording", startedAt: s.clock.now, outcome: null });
    chip.control.press();
    expect(s.deps.stop).toHaveBeenCalledTimes(1);
    expect(s.deps.start).not.toHaveBeenCalled();
  });

  it("shows Stop on a chip mounted mid-recording", () => {
    const s = setup();
    const first = s.mount();
    publishFeedRecording({ kind: KIND, phase: "recording", startedAt: s.clock.now - 5000, outcome: null });
    first.control.dispose();
    const second = s.mount();
    expect(second.last()).toEqual({ phase: "recording", secs: 5, outcome: null });
    second.control.press();
    expect(s.deps.stop).toHaveBeenCalledTimes(1);
  });

  it("shows Saving, and ignores a press, until the save settles", () => {
    const s = setup();
    const chip = s.mount();
    publishFeedRecording({ kind: KIND, phase: "saving", startedAt: 0, outcome: null });
    expect(chip.last().phase).toBe("saving");
    chip.control.press();
    expect(s.deps.start).not.toHaveBeenCalled();
    expect(s.deps.stop).not.toHaveBeenCalled();
  });

  it("gives the saved file name to a chip mounted after the save, until it fades", async () => {
    const s = setup();
    publishFeedRecording({
      kind: KIND,
      phase: "idle",
      startedAt: 0,
      outcome: { ok: true, path: "C:\\data\\feeds\\feed-1.json" },
    });
    const chip = s.mount();
    expect(chip.last().outcome).toEqual({ ok: true, file: "feed-1.json" });
    await vi.advanceTimersByTimeAsync(RESULT_MS);
    expect(chip.last()).toEqual(IDLE_FEED);
  });

  it("carries a typed failure from the recorder", () => {
    const s = setup();
    const chip = s.mount();
    const outcome = { ok: false, reason: "too_short", detail: null } as const;
    publishFeedRecording({ kind: KIND, phase: "idle", startedAt: 0, outcome });
    expect(chip.last().outcome).toEqual(outcome);
  });

  it("ignores another kind's recording", () => {
    const s = setup();
    const chip = s.mount();
    publishFeedRecording({
      kind: "other.plugin/kind",
      phase: "recording",
      startedAt: s.clock.now,
      outcome: null,
    });
    expect(chip.last()).toEqual(IDLE_FEED);
  });

  it("shows a busy refusal, which the recorder does not publish, then clears it", async () => {
    const s = setup();
    const chip = s.mount();
    chip.control.press();
    s.rejects[0](new FeedRecordError("busy"));
    await vi.advanceTimersByTimeAsync(0);
    expect(chip.last().outcome).toEqual({ ok: false, reason: "busy", detail: null });
    await vi.advanceTimersByTimeAsync(RESULT_MS);
    expect(chip.last().outcome).toBeNull();
  });

  it("stops its clocks and reports nothing more once disposed", () => {
    const s = setup();
    const chip = s.mount();
    publishFeedRecording({ kind: KIND, phase: "recording", startedAt: s.clock.now, outcome: null });
    chip.control.dispose();
    const seen = chip.states.length;
    publishFeedRecording({ kind: KIND, phase: "saving", startedAt: 0, outcome: null });
    vi.advanceTimersByTime(RESULT_MS);
    expect(chip.states).toHaveLength(seen);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("baseName", () => {
  it("keeps the last segment of either separator", () => {
    expect(baseName("C:\\a\\b.json")).toBe("b.json");
    expect(baseName("/a/b.json")).toBe("b.json");
    expect(baseName("b.json")).toBe("b.json");
  });
});
