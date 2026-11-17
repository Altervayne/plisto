// -- Test Imports --
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import {
  abortable,
  answeredAfter,
  longestGap,
  p3Verdict,
  pagePids,
  pidsServing,
  separation,
  sleep,
  startHeartbeat,
  terminablePids,
  waitFor,
} from "./p03Process";

// -- Type Imports --
import type { P3Facts } from "./p03Process";
import type { ProbeProcess } from "../ipc";

const list: ProbeProcess[] = [
  { pid: 1, kind: "browser", hosts: [] },
  { pid: 2, kind: "gpu", hosts: [] },
  { pid: 10, kind: "renderer", hosts: ["http://localhost"] },
  { pid: 20, kind: "renderer", hosts: ["https://probe-ui1.invalid"] },
  { pid: 30, kind: "renderer", hosts: ["https://probe-vis.invalid", "https://probe-vis.invalid"] },
  { pid: 40, kind: "renderer", hosts: ["https://probe-vis2.invalid"] },
  { pid: 50, kind: "renderer", hosts: ["https://probe-vis.invalid", "https://pp-abc.invalid"] },
  { pid: 60, kind: "renderer", hosts: [] },
  { pid: 70, kind: "utility", hosts: [] },
  { pid: 80, kind: "renderer", hosts: ["https://probe-vis.invalid", "https://probe-ui1.invalid"] },
  { pid: 90, kind: "renderer", hosts: ["https://probe-vis.invalid", "http://localhost"] },
];

const good: P3Facts = {
  hidden: false,
  workerNote: null,
  pagePids: [10],
  heartbeatPids: [20],
  busyPids: [30],
  pongMaxMs: 30,
  frameGapMaxMs: 40,
  pageFrames: 600,
  pingsSent: 160,
  pongsReceived: 160,
  stuck: [],
  remedyWorked: true,
};

describe("process lookup", () => {
  it("finds renderers by probe host and the page by the app host", () => {
    expect(pidsServing(list, "probe-vis")).toEqual([30, 50, 80, 90]);
    expect(pidsServing(list, "probe-ui1")).toEqual([20, 80]);
    expect(pagePids(list)).toEqual([10, 90]);
  });

  it("offers only probe-only renderers and seen frameless ones", () => {
    expect(terminablePids(list, new Set())).toEqual([30, 40]);
    expect(terminablePids(list, new Set([60, 70]))).toEqual([30, 40, 60]);
  });

  it("never offers a pid that also serves the heartbeat or the main document", () => {
    const offered = terminablePids(list, new Set([80, 90]));
    expect(offered).not.toContain(80);
    expect(offered).not.toContain(90);
    expect(offered).not.toContain(20);
    expect(offered).not.toContain(10);
  });
});

describe("separation", () => {
  it("is true for disjoint sets, false for any shared pid, null when a set is empty", () => {
    expect(separation([30], [20])).toBe(true);
    expect(separation([30, 80], [20, 80])).toBe(false);
    expect(separation([], [20])).toBeNull();
    expect(separation([30], [])).toBeNull();
  });
});

describe("p3Verdict", () => {
  it("passes separate processes, an answering page and no stuck process", () => {
    expect(p3Verdict(good)).toEqual({ state: "pass", reasons: [] });
  });

  it("fails when any busy pid is shared with the heartbeat or the page", () => {
    expect(p3Verdict({ ...good, busyPids: [30, 20] }).state).toBe("fail");
    expect(p3Verdict({ ...good, heartbeatPids: [20, 30] }).state).toBe("fail");
    expect(p3Verdict({ ...good, busyPids: [10] }).state).toBe("fail");
  });

  it("fails when the page stalls or the heartbeat goes quiet", () => {
    expect(p3Verdict({ ...good, pongMaxMs: 900 }).state).toBe("fail");
    expect(p3Verdict({ ...good, frameGapMaxMs: 900 }).state).toBe("fail");
    expect(p3Verdict({ ...good, pongsReceived: 10 }).state).toBe("fail");
  });

  it("treats a stuck process ended by the guarded terminate as a remedy that exists", () => {
    expect(p3Verdict({ ...good, stuck: [30], remedyWorked: true }).state).toBe("pass");
    expect(p3Verdict({ ...good, stuck: [30], remedyWorked: false }).state).toBe("fail");
  });

  it("is invalid without a frame-to-process mapping", () => {
    expect(p3Verdict({ ...good, busyPids: [] }).state).toBe("invalid");
    expect(p3Verdict({ ...good, heartbeatPids: [] }).state).toBe("invalid");
  });

  it("is invalid, naming the set, when the page's own process is not identified", () => {
    const v = p3Verdict({ ...good, pagePids: [] });
    expect(v.state).toBe("invalid");
    expect(v.reasons.join(" ")).toContain("the page's own process");
  });

  it("is invalid when no animation frame fired in the page", () => {
    expect(p3Verdict({ ...good, pageFrames: 0, frameGapMaxMs: 0 }).state).toBe("invalid");
  });

  it("cannot pass when the worker variant did not run", () => {
    const missing = p3Verdict({ ...good, workerNote: "worker refused: blocked" });
    expect(missing.state).toBe("invalid");
    expect(missing.reasons.join(" ")).toContain("worker variant not measured");
    expect(p3Verdict({ ...good, workerNote: "x", busyPids: [20] }).state).toBe("fail");
  });

  it("is invalid when the window was hidden, whatever the gaps read", () => {
    expect(p3Verdict({ ...good, hidden: true, frameGapMaxMs: 4000 }).state).toBe("invalid");
  });
});

describe("longestGap", () => {
  it("counts the interval still open at stop", () => {
    expect(longestGap(40, 1000, 1030)).toBe(40);
    expect(longestGap(40, 1000, 6000)).toBe(5000);
    expect(longestGap(0, 1000, 11_000)).toBe(10_000);
  });
});

describe("answeredAfter", () => {
  it("counts only pongs for pings sent at or after the stamp", () => {
    // A pong at 105 ms for a ping sent at 100 ms, before a terminate stamped at 110 ms.
    expect(answeredAfter([{ at: 105, ms: 5 }], 110)).toBe(false);
    expect(answeredAfter([{ at: 105, ms: 5 }, { at: 220, ms: 6 }], 110)).toBe(true);
  });
});

describe("abort", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function fakePort() {
    const listeners = new Set<unknown>();
    return {
      listeners,
      addEventListener: (_: string, fn: unknown) => listeners.add(fn),
      removeEventListener: (_: string, fn: unknown) => listeners.delete(fn),
      start: () => {},
      postMessage: () => {},
    };
  }

  it("ends a sleep, an abortable call and a message wait at once", async () => {
    const c = new AbortController();
    const port = fakePort();
    const waits = [
      sleep(60_000, c.signal),
      abortable(new Promise<void>(() => {}), c.signal),
      waitFor(port as unknown as MessagePort, "x", 60_000, c.signal),
    ].map((p) => expect(p).rejects.toThrow("aborted"));
    c.abort();
    await Promise.all(waits);
    expect(port.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops the heartbeat interval and its listener on stop", () => {
    const port = fakePort();
    const beat = startHeartbeat(port as unknown as MessagePort, 100);
    expect(vi.getTimerCount()).toBe(1);
    expect(port.listeners.size).toBe(1);
    beat.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(port.listeners.size).toBe(0);
  });
});
