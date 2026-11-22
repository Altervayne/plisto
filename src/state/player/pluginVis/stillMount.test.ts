// -- Test Imports --
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { ANSWER_MS, NONE_GRACE_MS, renderPluginStill, type StillEnv, type StillOutcome } from "./stillMount";
import { GIVE_UP_MS, SLOW_MS } from "./stageMount";

// -- State Imports --
import { pluginVisualizer } from "../pluginVisualizers";
import { stageHandles, useFrameCache } from "./frameCache";
import { usePluginsStore } from "../../plugins/store";
import { visualizerDecl as decl, visualizerRow as visRow } from "../../plugins/fixtures";
import { VIS_INIT_TYPE, type VisContext } from "../../../visRuntime/protocol";

const ipc = vi.hoisted(() => ({
  begin: vi.fn(() => Promise.resolve(true)),
  end: vi.fn(() => Promise.resolve()),
  shown: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../../lib/ipc", async (orig) => ({
  ...(await orig<typeof import("../../../lib/ipc")>()),
  pluginVisTrialBegin: ipc.begin,
  pluginVisTrialEnd: ipc.end,
  pluginVisShown: ipc.shown,
}));

const KIND = "com.example.rings/aurora-rings";

const context = (): VisContext => ({
  layout: { width: 680, height: 424, cover: [0, 0, 1, 1], radius: 0, mask: null, floor: null, hush: [] },
  palette: new Float32Array(9),
  cover: null,
  colors: { ground: [0, 0, 0], backing: [0, 0, 0], ink: [1, 1, 1] },
  light: false,
  reactivity: "balanced",
  ambient: true,
  reducedMotion: true,
  settings: {},
});

interface Fake {
  env: StillEnv;
  // What the frame's window received: the init and the port it carried.
  received: { init: { type: string }; port: MessagePort }[];
  removed: () => number;
  watches: { begun: number; released: number };
  load: () => void;
  loadedAs: { value: "first" | "again" };
}

function fake(): Fake {
  const received: Fake["received"] = [];
  let onLoad: () => void = () => {};
  let removed = 0;
  const loadedAs = { value: "first" as "first" | "again" };
  const watches = { begun: 0, released: 0 };
  const env: StillEnv = {
    url: () => Promise.resolve("http://pv-1.invalid/vis/rings.html"),
    frame: () => ({
      window: {
        postMessage: (message, _origin, transfer) =>
          void received.push({ init: message as { type: string }, port: transfer![0] as MessagePort }),
      },
      load: (_url, cb) => {
        onLoad = cb;
      },
      remove: () => {
        removed += 1;
      },
    }),
    attach: vi.fn(),
    detach: vi.fn(),
    loaded: () => loadedAs.value,
    watch: () => {
      watches.begun += 1;
      return () => void (watches.released += 1);
    },
  };
  return { env, received, removed: () => removed, watches, load: () => onLoad(), loadedAs };
}

const READY = { type: "ready", metered: false };
const EMPTY = { type: "still", id: 1, bitmap: null };
const ERROR = { type: "error", stage: "compile", message: "bad shader" };

/** Posts the frame's messages in order, as the runtime does. */
const answer = (port: MessagePort, ...messages: object[]) => {
  for (const message of messages) port.postMessage(message);
};

/** Starts a mount up to its still request; the frame's port answers each request with `messages`. */
async function started(...messages: object[]) {
  const f = fake();
  const phases: string[] = [];
  const render = renderPluginStill(pluginVisualizer(KIND)!, context(), {
    env: f.env,
    onPhase: (p) => void phases.push(p),
  });
  await vi.waitFor(() => expect(f.env.attach).toHaveBeenCalled());
  f.load();
  const port = f.received[0].port;
  port.onmessage = (event) => {
    if ((event.data as { type: string }).type === "still") answer(port, ...messages);
  };
  let outcome: StillOutcome | null = null;
  void render.result.then((o) => (outcome = o));
  return { f, port, phases, render, outcome: () => outcome };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits one message task, which no fake timer holds back. */
const nextTask = () =>
  new Promise<void>((resolve) => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = () => {
      port1.close();
      resolve();
    };
    port2.postMessage(null);
  });

beforeEach(() => {
  vi.clearAllMocks();
  useFrameCache.setState({ wants: {}, phases: {} });
  usePluginsStore.setState({ rows: [visRow("com.example.rings", "Rings", [decl()])] });
});

describe("still mount", () => {
  it("asks once for a still, never ticks, and removes the frame with the answer", async () => {
    const f = fake();
    const messages: unknown[] = [];
    const render = renderPluginStill(pluginVisualizer(KIND)!, context(), { env: f.env });
    await vi.waitFor(() => expect(f.env.attach).toHaveBeenCalled());
    f.load();
    expect(f.received).toHaveLength(1);
    expect(f.received[0].init.type).toBe(VIS_INIT_TYPE);
    const port = f.received[0].port;
    port.onmessage = (event) => {
      messages.push(event.data);
      if ((event.data as { type: string }).type === "still") {
        port.postMessage({ type: "still", id: 1, bitmap: { width: 2, height: 2 } });
      }
    };
    const outcome = await render.result;
    expect(outcome).toMatchObject({ type: "still", bitmap: { width: 2, height: 2 } });
    expect(messages[0]).toEqual({ type: "still", id: 1 });
    expect(messages.some((m) => (m as { type: string }).type === "tick")).toBe(false);
    expect(f.env.detach).toHaveBeenCalledTimes(1);
    expect(f.removed()).toBe(1);
  });

  it("never reports shown, never takes part in the stage and never writes a trial itself", async () => {
    const f = fake();
    const render = renderPluginStill(pluginVisualizer(KIND)!, context(), { env: f.env });
    await vi.waitFor(() => expect(f.env.attach).toHaveBeenCalled());
    f.load();
    expect(stageHandles()).toHaveLength(0);
    const port = f.received[0].port;
    port.onmessage = () => answer(port, READY, EMPTY);
    await render.result;
    expect(stageHandles()).toHaveLength(0);
    expect(useFrameCache.getState().phases).toEqual({});
    expect(ipc.begin).not.toHaveBeenCalled();
    expect(ipc.end).not.toHaveBeenCalled();
    expect(ipc.shown).not.toHaveBeenCalled();
  });


  it("settles failed for a frame error, with the fault phase", async () => {
    const f = fake();
    const render = renderPluginStill(pluginVisualizer(KIND)!, context(), { env: f.env });
    await vi.waitFor(() => expect(f.env.attach).toHaveBeenCalled());
    f.load();
    const port = f.received[0].port;
    port.onmessage = () => port.postMessage({ type: "error", stage: "still", message: "boom" });
    expect(await render.result).toEqual({ type: "failed", phase: "failed" });
    expect(f.removed()).toBe(1);
  });

  it("settles failed at the time limit", async () => {
    vi.useFakeTimers();
    try {
      const f = fake();
      const render = renderPluginStill(pluginVisualizer(KIND)!, context(), { env: f.env });
      await vi.advanceTimersByTimeAsync(GIVE_UP_MS + 10);
      expect(await render.result).toEqual({ type: "failed", phase: "dropped" });
      expect(f.removed()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is watched for a graphics reset while it lives, released once", async () => {
    const f = fake();
    const render = renderPluginStill(pluginVisualizer(KIND)!, context(), { env: f.env });
    expect(f.watches).toEqual({ begun: 1, released: 0 });
    await vi.waitFor(() => expect(f.env.attach).toHaveBeenCalled());
    render.cancel();
    await render.result;
    render.cancel();
    expect(f.watches).toEqual({ begun: 1, released: 1 });
  });

  it("settles failed for a refused still", async () => {
    const f = fake();
    const render = renderPluginStill(pluginVisualizer(KIND)!, context(), { env: f.env });
    await vi.waitFor(() => expect(f.env.attach).toHaveBeenCalled());
    f.load();
    const port = f.received[0].port;
    port.onmessage = () => port.postMessage({ type: "still", id: 1, bitmap: null, error: "refused" });
    expect(await render.result).toEqual({ type: "failed", phase: "dropped" });
    expect(f.removed()).toBe(1);
  });

  it("settles failed on a second load and on a failed url, removing what it opened", async () => {
    const again = fake();
    again.loadedAs.value = "again";
    const first = renderPluginStill(pluginVisualizer(KIND)!, context(), { env: again.env });
    await vi.waitFor(() => expect(again.env.attach).toHaveBeenCalled());
    again.load();
    expect(await first.result).toEqual({ type: "failed", phase: "dropped" });
    expect(again.received).toHaveLength(0);
    expect(again.removed()).toBe(1);

    const refused = fake();
    refused.env.url = () => Promise.reject(new Error("no frames"));
    const second = renderPluginStill(pluginVisualizer(KIND)!, context(), { env: refused.env });
    expect(await second.result).toEqual({ type: "failed", phase: "dropped" });
    expect(refused.env.attach).not.toHaveBeenCalled();
  });

  it("ends early on cancel", async () => {
    const f = fake();
    const render = renderPluginStill(pluginVisualizer(KIND)!, context(), { env: f.env });
    await vi.waitFor(() => expect(f.env.attach).toHaveBeenCalled());
    render.cancel();
    expect(await render.result).toEqual({ type: "cancelled" });
    expect(f.removed()).toBe(1);
  });

  it("opens nothing when cancelled before the url answers", async () => {
    const f = fake();
    let answer: (url: string) => void = () => {};
    f.env.url = () => new Promise<string>((resolve) => (answer = resolve));
    const render = renderPluginStill(pluginVisualizer(KIND)!, context(), { env: f.env });
    render.cancel();
    answer("http://pv-1.invalid/vis/rings.html");
    expect(await render.result).toEqual({ type: "cancelled" });
    await Promise.resolve();
    expect(f.env.attach).not.toHaveBeenCalled();
  });
});

describe("still mount outcome", () => {
  it("reads an empty still followed by an error as failed", async () => {
    const m = await started(EMPTY, ERROR);
    expect(await m.render.result).toEqual({ type: "failed", phase: "failed" });
    expect(m.f.removed()).toBe(1);
  });

  it("reads an empty still after ready as failed when an error follows inside the grace", async () => {
    const m = await started(READY, EMPTY, ERROR);
    expect(await m.render.result).toEqual({ type: "failed", phase: "failed" });
  });

  it("reads an empty still after ready as none once the grace passes without an error", async () => {
    const m = await started(READY, EMPTY);
    await vi.waitFor(() => expect(m.phases).toContain("ready"));
    expect(m.outcome()).toBeNull();
    expect(m.f.removed()).toBe(0);
    expect(await m.render.result).toEqual({ type: "none" });
    expect(m.f.removed()).toBe(1);
  });

  it("keeps waiting on an empty still before ready, and lets the error that follows decide", async () => {
    const m = await started(EMPTY);
    await pause(NONE_GRACE_MS * 2);
    expect(m.outcome()).toBeNull();
    expect(m.f.removed()).toBe(0);
    answer(m.port, ERROR);
    expect(await m.render.result).toEqual({ type: "failed", phase: "failed" });
  });

  it("lets a ready that follows an empty still decide none", async () => {
    const m = await started(EMPTY);
    await pause(NONE_GRACE_MS * 2);
    expect(m.outcome()).toBeNull();
    answer(m.port, READY);
    expect(await m.render.result).toEqual({ type: "none" });
  });

  it("fails a ready frame that never answers the still request within the answer limit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const m = await started(READY);
      // Polled on message tasks: a fake-timer wait would move the clock under test.
      for (let i = 0; i < 100 && !m.phases.includes("ready"); i++) await nextTask();
      expect(m.phases).toContain("ready");
      vi.advanceTimersByTime(ANSWER_MS - 1);
      await Promise.resolve();
      expect(m.outcome()).toBeNull();
      vi.advanceTimersByTime(1);
      expect(await m.render.result).toEqual({ type: "failed", phase: "dropped" });
      expect(m.f.removed()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("still mount clocks and exits", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("settles failed for a still that is not an image bitmap", async () => {
    vi.stubGlobal("ImageBitmap", class {});
    const m = await started(READY, { type: "still", id: 1, bitmap: { width: 2, height: 2 } });
    expect(await m.render.result).toEqual({ type: "failed", phase: "failed" });
    expect(m.f.removed()).toBe(1);
  });

  it("runs the slow mark from the start until the outcome, even past ready", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const m = await started(READY);
    for (let i = 0; i < 100 && !m.phases.includes("ready"); i++) await nextTask();
    expect(m.phases).toEqual(["ready"]);
    vi.advanceTimersByTime(SLOW_MS);
    expect(m.phases).toEqual(["ready", "slow"]);
    m.render.cancel();
    await m.render.result;
  });

  it("ends a mount whose url request never settles at the time limit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fake();
    f.env.url = () => new Promise<string>(() => {});
    const render = renderPluginStill(pluginVisualizer(KIND)!, context(), { env: f.env });
    vi.advanceTimersByTime(GIVE_UP_MS);
    expect(await render.result).toEqual({ type: "failed", phase: "dropped" });
    expect(f.watches).toEqual({ begun: 1, released: 1 });
    expect(f.env.attach).not.toHaveBeenCalled();
  });

  it("releases its watch exactly once on every kind of exit", async () => {
    const exits: object[][] = [
      [READY, { type: "still", id: 1, bitmap: { width: 2, height: 2 } }],
      [READY, EMPTY],
      [ERROR],
      [{ type: "still", id: 1, bitmap: null, error: "refused" }],
      [],
    ];
    for (const messages of exits) {
      const m = await started(...messages);
      if (messages.length === 0) m.render.cancel();
      await m.render.result;
      m.render.cancel();
      expect(m.f.watches).toEqual({ begun: 1, released: 1 });
    }
  });
});
