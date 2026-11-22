// -- Test Imports --
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import {
  REPAINT_DELAY_MS,
  createStillSession,
  stillGate,
  type StillGate,
  type StillPhase,
} from "./stillSession";

// -- State Imports --
import { pluginVisualizer } from "../pluginVisualizers";
import { phaseOf, useFrameCache } from "./frameCache";
import { usePluginsStore } from "../../plugins/store";
import { visualizerDecl as decl, visualizerRow as visRow } from "../../plugins/fixtures";
import type { StillOutcome, StillRender } from "./stillMount";
import type { VisContext } from "../../../visRuntime/protocol";

const KIND = "com.example.rings/aurora-rings";
const bitmap = (): ImageBitmap => ({ width: 2, height: 2, close: vi.fn() }) as unknown as ImageBitmap;

interface Pending {
  settle: (outcome: StillOutcome) => void;
  cancel: ReturnType<typeof vi.fn>;
  onPhase?: (phase: string) => void;
}

function setup(initial: StillGate = "open") {
  const gate = { value: initial };
  const size = { width: 100 };
  const pending: Pending[] = [];
  const render = vi.fn((_d?: unknown, _c?: unknown, o?: { onPhase?: (p: string) => void }): StillRender => {
    let settle!: (outcome: StillOutcome) => void;
    const result = new Promise<StillOutcome>((resolve) => (settle = resolve));
    const cancel = vi.fn(() => settle({ type: "cancelled" }));
    pending.push({ settle, cancel, onPhase: o?.onPhase });
    return { result, cancel };
  });
  const paint = vi.fn();
  const phases: StillPhase[] = [];
  const onFail = vi.fn();
  const make = () =>
    createStillSession({
      descriptor: pluginVisualizer(KIND)!,
      surface: "player",
      context: () => ({ layout: { width: size.width, height: 50 } }) as unknown as VisContext,
      paint,
      setPhase: (p) => void phases.push(p),
      onFail,
      gate: () => gate.value,
      render: render as never,
    });
  return { session: make(), make, gate, size, pending, render, paint, phases, onFail };
}

const last = <T,>(list: T[]): T | undefined => list[list.length - 1];
const flush = () => vi.advanceTimersByTimeAsync(0);
const quiet = () => vi.advanceTimersByTimeAsync(REPAINT_DELAY_MS + 10);

/** A session whose first render answered with a still. */
async function painted() {
  const s = setup();
  s.session.open();
  await flush();
  s.pending[0].settle({ type: "still", bitmap: bitmap() });
  await flush();
  return s;
}

beforeEach(() => {
  vi.useFakeTimers();
  useFrameCache.setState({ wants: {}, phases: {} });
  usePluginsStore.setState({ rows: [visRow("com.example.rings", "Rings", [decl()])] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("still gate", () => {
  it("opens on a running runtime with marks read, waits otherwise, blocks on held, safe or stopped", () => {
    expect(stillGate("running", true, false)).toBe("open");
    expect(stillGate("running", false, true)).toBe("wait");
    expect(stillGate(null, true, false)).toBe("wait");
    expect(stillGate("held", true, false)).toBe("blocked");
    expect(stillGate("safe", false, false)).toBe("blocked");
    expect(stillGate("running", true, true)).toBe("blocked");
  });
});

describe("still session first outcome", () => {
  it("paints a still and reports ready", async () => {
    const s = setup();
    s.session.open();
    await flush();
    const shot = bitmap();
    s.pending[0].settle({ type: "still", bitmap: shot });
    await flush();
    expect(s.paint).toHaveBeenCalledWith(shot);
    expect(s.phases).toEqual(["ready"]);
    expect(phaseOf("player", KIND)).toBe("ready");
  });

  it("answers ready with an empty canvas for a kind that gives no still", async () => {
    const s = setup();
    s.session.open();
    await flush();
    s.pending[0].settle({ type: "none" });
    await flush();
    expect(s.paint).toHaveBeenCalledWith(null);
    expect(phaseOf("player", KIND)).toBe("ready");
    expect(s.onFail).not.toHaveBeenCalled();
  });

  it("fails the stage on a failed first render and renders nothing after, as a live mount", async () => {
    const s = setup();
    s.session.open();
    await flush();
    s.pending[0].settle({ type: "failed", phase: "failed" });
    await flush();
    expect(s.onFail).toHaveBeenCalledTimes(1);
    expect(s.paint).not.toHaveBeenCalled();
    expect(s.phases).toEqual(["ended"]);
    expect(phaseOf("player", KIND)).toBe("failed");
    s.session.trigger();
    s.session.open();
    await quiet();
    expect(s.render).toHaveBeenCalledTimes(1);
  });

  it("gives up without a fault for a dropped first render", async () => {
    const s = setup();
    s.session.open();
    await flush();
    s.pending[0].settle({ type: "failed", phase: "dropped" });
    await flush();
    expect(s.onFail).not.toHaveBeenCalled();
    expect(phaseOf("player", KIND)).toBe("dropped");
  });

  it("reports slow only before the first outcome", async () => {
    const s = setup();
    s.session.open();
    await flush();
    s.pending[0].onPhase?.("slow");
    expect(s.phases).toEqual(["slow"]);
    s.pending[0].settle({ type: "still", bitmap: bitmap() });
    await flush();
    s.session.trigger();
    await quiet();
    s.pending[1].onPhase?.("slow");
    expect(s.phases).toEqual(["slow", "ready"]);
  });

  it("changes nothing on a cancelled outcome", async () => {
    const s = setup();
    s.session.open();
    await flush();
    s.pending[0].settle({ type: "cancelled" });
    await flush();
    expect(s.paint).not.toHaveBeenCalled();
    expect(s.phases).toEqual([]);
    expect(s.onFail).not.toHaveBeenCalled();
    expect(phaseOf("player", KIND)).toBe("mounting");
    s.session.open();
    await flush();
    expect(s.render).toHaveBeenCalledTimes(1);
  });

  it("fails the stage when the first still does not paint, without a rejection", async () => {
    const s = setup();
    s.paint.mockImplementation(() => {
      throw new Error("detached");
    });
    s.session.open();
    await flush();
    s.pending[0].settle({ type: "still", bitmap: bitmap() });
    await flush();
    expect(s.phases).toEqual(["ended"]);
    expect(phaseOf("player", KIND)).toBe("failed");
    expect(s.onFail).toHaveBeenCalledTimes(1);
  });

  it("neither renders nor settles at zero size, and renders once a size triggers it", async () => {
    const s = setup();
    s.size.width = 0;
    s.session.open();
    await quiet();
    expect(s.render).not.toHaveBeenCalled();
    expect(s.phases).toEqual([]);
    expect(phaseOf("player", KIND)).toBe("mounting");
    s.size.width = 100;
    s.session.trigger();
    await quiet();
    expect(s.render).toHaveBeenCalledTimes(1);
  });
});

describe("still session repaints", () => {
  it("still repaints after a trigger that cancelled the first render", async () => {
    const s = setup();
    s.session.open();
    await flush();
    s.session.trigger();
    expect(s.pending[0].cancel).toHaveBeenCalledTimes(1);
    await quiet();
    expect(s.render).toHaveBeenCalledTimes(2);
    s.pending[1].settle({ type: "still", bitmap: bitmap() });
    await flush();
    expect(s.paint).toHaveBeenCalledTimes(1);
    s.session.trigger();
    await quiet();
    expect(s.render).toHaveBeenCalledTimes(3);
  });

  it("renders once for a burst of changes, after the quiet period", async () => {
    const s = await painted();
    for (let i = 0; i < 5; i++) {
      s.session.trigger();
      await vi.advanceTimersByTimeAsync(REPAINT_DELAY_MS - 100);
    }
    expect(s.render).toHaveBeenCalledTimes(1);
    await quiet();
    expect(s.render).toHaveBeenCalledTimes(2);
  });

  it("replaces the painted still with a new one", async () => {
    const s = await painted();
    s.session.trigger();
    await quiet();
    const next = bitmap();
    s.pending[1].settle({ type: "still", bitmap: next });
    await flush();
    expect(last(s.paint.mock.calls)).toEqual([next]);
    expect(s.phases).toEqual(["ready"]);
  });

  it("keeps the painted still and the phase when a repaint fails, gives none or is dropped", async () => {
    const s = await painted();
    const outcomes: StillOutcome[] = [
      { type: "failed", phase: "failed" },
      { type: "none" },
      { type: "failed", phase: "dropped" },
    ];
    for (const [i, outcome] of outcomes.entries()) {
      s.session.trigger();
      await quiet();
      s.pending[i + 1].settle(outcome);
      await flush();
    }
    expect(s.paint).toHaveBeenCalledTimes(1);
    expect(s.onFail).not.toHaveBeenCalled();
    expect(s.phases).toEqual(["ready"]);
    expect(phaseOf("player", KIND)).toBe("ready");
    s.session.trigger();
    await quiet();
    expect(s.render).toHaveBeenCalledTimes(5);
  });

  it("keeps the painted still and the phase when a repaint does not paint", async () => {
    const s = await painted();
    s.paint.mockImplementation(() => {
      throw new Error("detached");
    });
    s.session.trigger();
    await quiet();
    s.pending[1].settle({ type: "still", bitmap: bitmap() });
    await flush();
    expect(s.onFail).not.toHaveBeenCalled();
    expect(s.phases).toEqual(["ready"]);
    s.paint.mockReset();
    s.session.trigger();
    await quiet();
    s.pending[2].settle({ type: "still", bitmap: bitmap() });
    await flush();
    expect(s.paint).toHaveBeenCalledTimes(1);
  });

  it("clears an empty canvas again for none after a first none", async () => {
    const s = setup();
    s.session.open();
    await flush();
    s.pending[0].settle({ type: "none" });
    await flush();
    s.session.trigger();
    await quiet();
    s.pending[1].settle({ type: "none" });
    await flush();
    expect(s.paint.mock.calls).toEqual([[null], [null]]);
  });

  it("cancels the render in flight on dispose and releases its late still", async () => {
    const s = setup();
    s.session.open();
    await flush();
    s.pending[0].cancel.mockImplementation(() => {});
    s.session.dispose();
    expect(s.pending[0].cancel).toHaveBeenCalledTimes(1);
    const late = bitmap();
    s.pending[0].settle({ type: "still", bitmap: late });
    await flush();
    expect(s.paint).not.toHaveBeenCalled();
    expect(late.close).toHaveBeenCalled();
  });

  it("never runs two renders at once when a cancel is slow to settle", async () => {
    const s = await painted();
    s.session.trigger();
    await quiet();
    s.pending[1].cancel.mockImplementation(() => {});
    s.session.trigger();
    await quiet();
    expect(s.render).toHaveBeenCalledTimes(2);
    s.pending[1].settle({ type: "cancelled" });
    await flush();
    expect(s.render).toHaveBeenCalledTimes(3);
  });

  it("renders once when a session is made, opened and disposed, then made again", async () => {
    const s = setup();
    s.session.open();
    s.session.dispose();
    const again = s.make();
    again.open();
    await flush();
    expect(s.render).toHaveBeenCalledTimes(1);
  });
});

describe("still session gate", () => {
  it("does not render before the gate opens, and renders when it does", async () => {
    const s = setup("wait");
    s.session.open();
    s.session.trigger();
    await quiet();
    expect(s.render).not.toHaveBeenCalled();
    s.gate.value = "open";
    s.session.open();
    await flush();
    expect(s.render).toHaveBeenCalledTimes(1);
  });

  it("gives up on a blocked gate before the first outcome, and renders again when it opens", async () => {
    const s = setup();
    s.session.open();
    await flush();
    s.gate.value = "blocked";
    s.session.block();
    await flush();
    expect(s.pending[0].cancel).toHaveBeenCalled();
    expect(last(s.phases)).toBe("ended");
    expect(phaseOf("player", KIND)).toBe("dropped");
    s.gate.value = "open";
    s.session.open();
    await flush();
    expect(s.render).toHaveBeenCalledTimes(2);
    expect(last(s.phases)).toBe("mounting");
  });

  it("settles nothing for a render that failed only because the gate closed, and runs it again", async () => {
    const s = setup();
    s.session.open();
    await flush();
    s.gate.value = "wait";
    s.pending[0].settle({ type: "failed", phase: "dropped" });
    await flush();
    expect(s.onFail).not.toHaveBeenCalled();
    expect(s.phases).toEqual([]);
    expect(phaseOf("player", KIND)).toBe("mounting");
    s.gate.value = "open";
    s.session.open();
    await flush();
    expect(s.render).toHaveBeenCalledTimes(2);
  });

  it("keeps a painted still when the gate blocks later, and repaints once it opens", async () => {
    const s = await painted();
    s.session.trigger();
    await quiet();
    s.gate.value = "blocked";
    s.session.block();
    await flush();
    expect(last(s.phases)).toBe("ready");
    expect(s.paint).toHaveBeenCalledTimes(1);
    s.gate.value = "open";
    s.session.open();
    await flush();
    expect(s.render).toHaveBeenCalledTimes(3);
  });
});
