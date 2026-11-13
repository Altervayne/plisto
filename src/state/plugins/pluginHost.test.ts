// -- Test Imports --
import { afterEach, describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import {
  attachFrame,
  detachFrame,
  frameLoaded,
  isFrameLoaded,
  onPong,
  sendInit,
  sendPing,
  sendVisibility,
  startPluginHost,
} from "./pluginHost";

// -- Type Imports --
import type { FrameTheme, FrameWindow, HostMessage } from "./pluginHost";
import type { PluginCallReply } from "../../types";

class FakeWindow implements FrameWindow {
  posted: { msg: Record<string, unknown>; origin: string }[] = [];
  postMessage(message: unknown, targetOrigin: string): void {
    this.posted.push({ msg: message as Record<string, unknown>, origin: targetOrigin });
  }
  types(): unknown[] {
    return this.posted.map((p) => p.msg.type);
  }
}

interface Pending {
  id: string;
  method: string;
  args: string;
  resolve: (reply: PluginCallReply) => void;
  reject: (err: unknown) => void;
}

const INFO = {
  api_version: 1,
  plisto_version: "2.7.0",
  plugin_id: "plug-a",
  plugin_version: "1.0.0",
  locale: "en",
  theme: "light",
  app_mode: "both",
  tier: "ui",
  granted: ["storage"],
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let stop: (() => void) | null = null;

afterEach(() => {
  stop?.();
  stop = null;
});

function setup(sleep?: (ms: number) => Promise<void>) {
  let listener: ((event: HostMessage) => void) | null = null;
  let themeListener: (() => void) | null = null;
  let theme: FrameTheme = "light";
  const calls: Pending[] = [];
  const invoke = vi.fn(
    (id: string, method: string, args: string) =>
      new Promise<PluginCallReply>((resolve, reject) => calls.push({ id, method, args, resolve, reject })),
  );
  stop = startPluginHost({
    addListener: (fn) => {
      listener = fn;
      return () => {
        listener = null;
      };
    },
    invoke,
    sleep,
    theme: () => theme,
    subscribeTheme: (fn) => {
      themeListener = fn;
      return () => {
        themeListener = null;
      };
    },
  });
  const emit = (source: unknown, data: unknown, origin = "null") => listener?.({ origin, source, data });
  const call = (source: unknown, id: number, extra: Record<string, unknown> = {}) =>
    emit(source, { plisto: 1, type: "plisto:call", id, method: "storage.get", args: "{}", ...extra });
  const frame = (name: string) => {
    const win = new FakeWindow();
    attachFrame(`k-${name}`, `plug-${name}`, win);
    return win;
  };
  const setTheme = (next: FrameTheme) => {
    theme = next;
    themeListener?.();
  };
  return { calls, invoke, emit, call, frame, setTheme, hasListener: () => listener !== null };
}

/** Answers the host's init calls in order. */
function answerInit(calls: Pending[], from = 0) {
  calls[from].resolve({ ok: true, result: INFO });
  calls[from + 1].resolve({ ok: true, result: { api_version: 1, methods: ["app.info", "app.methods"] } });
}

describe("calls", () => {
  it("posts a result only to the calling record, with target origin *", async () => {
    const { calls, invoke, call, frame } = setup();
    const a = frame("a");
    const b = frame("b");
    call(a, 1);
    expect(invoke).toHaveBeenCalledWith("plug-a", "storage.get", "{}");
    calls[0].resolve({ ok: true, result: { found: false, value: null } });
    await flush();
    expect(a.posted).toEqual([
      { msg: { plisto: 1, type: "plisto:result", id: 1, ok: true, result: { found: false, value: null } }, origin: "*" },
    ]);
    expect(b.posted).toEqual([]);
  });

  it("invokes with the record's plugin id whatever the message carries", () => {
    const { invoke, call, frame } = setup();
    const a = frame("a");
    call(a, 1, { pluginId: "plug-b", plugin_id: "plug-b", plugin: "plug-b" });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0][0]).toBe("plug-a");
  });

  it("ignores a source that is not mapped: no invoke, no post", async () => {
    const { invoke, call, frame } = setup();
    const a = frame("a");
    const forger = new FakeWindow();
    call(forger, 1);
    call(forger, 2, { pluginId: "plug-a" });
    await flush();
    expect(invoke).not.toHaveBeenCalled();
    expect(forger.posted).toEqual([]);
    expect(a.posted).toEqual([]);
  });

  it("answers a duplicate pending id invalid_args without a second invoke", async () => {
    const { calls, invoke, call, frame } = setup();
    const a = frame("a");
    call(a, 7);
    call(a, 7);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(a.posted[0].msg).toMatchObject({ id: 7, ok: false, error: { code: "invalid_args" } });
    calls[0].resolve({ ok: true, result: 1 });
    await flush();
    expect(a.posted[1].msg).toMatchObject({ id: 7, ok: true, result: 1 });
    // Once answered, the id may be used again.
    call(a, 7);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("answers an invoke rejection unavailable", async () => {
    const { calls, call, frame } = setup();
    const a = frame("a");
    call(a, 1);
    calls[0].reject(new Error("ipc down"));
    await flush();
    expect(a.posted[0].msg).toEqual({
      plisto: 1,
      type: "plisto:result",
      id: 1,
      ok: false,
      error: { code: "unavailable", message: "The call could not reach Plisto." },
    });
  });

  it("returns pending to 0 after answers and rejections", async () => {
    const { calls, call, frame, emit } = setup();
    const a = frame("a");
    for (let id = 1; id <= 32; id += 1) call(a, id);
    // The 33rd waiting call is refused busy, which proves 32 are pending.
    call(a, 33);
    expect(a.posted[a.posted.length - 1].msg).toMatchObject({ id: 33, error: { code: "busy" } });
    calls.forEach((c, i) => (i % 2 ? c.reject(new Error("x")) : c.resolve({ ok: true, result: null })));
    await flush();
    // With pending back to 0, 32 fresh calls are all forwarded.
    for (let id = 100; id < 132; id += 1) call(a, id);
    expect(calls.length).toBe(64);
    emit(a, { plisto: 1, type: "plisto:call", id: 200, method: "storage.get", args: "{}" });
    expect(a.posted[a.posted.length - 1].msg).toMatchObject({ id: 200, error: { code: "busy" } });
  });

  it("posts nothing after detach and still settles the pending count", async () => {
    const { calls, call, frame } = setup();
    const a = frame("a");
    call(a, 1);
    detachFrame("k-a");
    calls[0].resolve({ ok: true, result: 1 });
    await flush();
    expect(a.posted).toEqual([]);
    // Reattached under a new key, the same window starts clean.
    attachFrame("k-a2", "plug-a", a);
    call(a, 1);
    expect(calls.length).toBe(2);
  });
});

describe("loads", () => {
  it("returns first, then again, and a second load kills the record", async () => {
    const { calls, invoke, call, frame } = setup();
    const a = frame("a");
    expect(frameLoaded("k-a")).toBe("first");
    call(a, 1);
    expect(frameLoaded("k-a")).toBe("again");
    expect(isFrameLoaded("k-a")).toBe(false);
    call(a, 2);
    expect(invoke).toHaveBeenCalledTimes(1);
    calls[0].resolve({ ok: true, result: 1 });
    await flush();
    expect(a.posted).toEqual([]);
    expect(sendPing("k-a", 1)).toBe(false);
  });

  it("reads again for an unknown key", () => {
    setup();
    expect(frameLoaded("missing")).toBe("again");
  });
});

describe("init", () => {
  it("posts init after the first load with app.info and app.methods", async () => {
    const { calls, frame } = setup();
    const a = frame("a");
    expect(await sendInit("k-a")).toBe(false);
    frameLoaded("k-a");
    sendVisibility("k-a", true);
    const done = sendInit("k-a", "/x");
    expect(calls.map((c) => [c.id, c.method, c.args])).toEqual([
      ["plug-a", "app.info", "{}"],
      ["plug-a", "app.methods", "{}"],
    ]);
    answerInit(calls);
    expect(await done).toBe(true);
    expect(a.posted).toEqual([
      {
        msg: {
          plisto: 1,
          type: "plisto:init",
          info: INFO,
          methods: ["app.info", "app.methods"],
          page_open: true,
          route: "/x",
        },
        origin: "*",
      },
    ]);
    expect(await sendInit("k-a")).toBe(false);
  });

  it("posts no init when a host call fails", async () => {
    const { calls, frame } = setup();
    const a = frame("a");
    frameLoaded("k-a");
    const done = sendInit("k-a");
    calls[0].resolve({ ok: true, result: INFO });
    calls[1].resolve({ ok: false, error: { code: "unavailable", message: "x" } });
    expect(await done).toBe(false);
    expect(a.posted).toEqual([]);
  });

  it("posts no init to a frame detached while it waited", async () => {
    const { calls, frame } = setup();
    const a = frame("a");
    frameLoaded("k-a");
    const done = sendInit("k-a");
    detachFrame("k-a");
    answerInit(calls);
    expect(await done).toBe(false);
    expect(a.posted).toEqual([]);
  });

  describe("rate limit", () => {
    const limited = (retry?: number): PluginCallReply => ({
      ok: false,
      error: { code: "rate_limited", message: "slow", ...(retry === undefined ? {} : { retry_after_ms: retry }) },
    });
    const sleeps = () => {
      const sleep = vi.fn((_ms: number) => Promise.resolve());
      return sleep;
    };

    it("retries a rate-limited app.info after the clamped hint, then posts init", async () => {
      const sleep = sleeps();
      const { calls, frame } = setup(sleep);
      const a = frame("a");
      frameLoaded("k-a");
      const done = sendInit("k-a");
      calls[0].resolve(limited(10));
      calls[1].resolve({ ok: true, result: { api_version: 1, methods: ["app.info"] } });
      await flush();
      expect(sleep).toHaveBeenCalledWith(50);
      expect(calls[2].method).toBe("app.info");
      calls[2].resolve({ ok: true, result: INFO });
      expect(await done).toBe(true);
      expect(a.types()).toEqual(["plisto:init"]);
    });

    it("clamps a long hint and defaults an absent one", async () => {
      const sleep = sleeps();
      const { calls, frame } = setup(sleep);
      frame("a");
      frameLoaded("k-a");
      void sendInit("k-a");
      calls[0].resolve(limited(9000));
      calls[1].resolve(limited());
      await flush();
      expect(sleep.mock.calls.map((c) => c[0]).sort((x, y) => x - y)).toEqual([500, 2000]);
    });

    it("gives up after five rate-limited answers and posts nothing", async () => {
      const sleep = sleeps();
      const { calls, frame } = setup(sleep);
      const a = frame("a");
      frameLoaded("k-a");
      const done = sendInit("k-a");
      calls[1].resolve({ ok: true, result: { api_version: 1, methods: [] } });
      for (let i = 0; i < 5; i += 1) {
        await flush();
        const info = calls.filter((c) => c.method === "app.info")[i];
        info.resolve(limited(100));
      }
      expect(await done).toBe(false);
      expect(calls.filter((c) => c.method === "app.info")).toHaveLength(5);
      expect(sleep).toHaveBeenCalledTimes(4);
      expect(a.posted).toEqual([]);
    });

    it("does not retry any other refusal", async () => {
      const sleep = sleeps();
      const { calls, frame } = setup(sleep);
      frame("a");
      frameLoaded("k-a");
      const done = sendInit("k-a");
      calls[0].resolve({ ok: false, error: { code: "unavailable", message: "x" } });
      calls[1].resolve({ ok: true, result: { api_version: 1, methods: [] } });
      expect(await done).toBe(false);
      expect(sleep).not.toHaveBeenCalled();
      expect(calls).toHaveLength(2);
    });

    it("sends nothing to a record detached during the wait", async () => {
      let wake: () => void = () => {};
      const sleep = vi.fn(() => new Promise<void>((resolve) => (wake = resolve)));
      const { calls, frame } = setup(sleep);
      const a = frame("a");
      frameLoaded("k-a");
      const done = sendInit("k-a");
      calls[0].resolve(limited(100));
      calls[1].resolve({ ok: true, result: { api_version: 1, methods: [] } });
      await flush();
      detachFrame("k-a");
      wake();
      expect(await done).toBe(false);
      expect(calls).toHaveLength(2);
      expect(a.posted).toEqual([]);
    });
  });

  it("holds visibility until init, then posts only changes", async () => {
    const { calls, frame } = setup();
    const a = frame("a");
    frameLoaded("k-a");
    sendVisibility("k-a", true);
    const done = sendInit("k-a");
    sendVisibility("k-a", false);
    answerInit(calls);
    await done;
    expect(a.posted[0].msg).toMatchObject({ type: "plisto:init", page_open: false });
    sendVisibility("k-a", false);
    sendVisibility("k-a", true);
    expect(a.types()).toEqual(["plisto:init", "plisto:visibility"]);
    expect(a.posted[1].msg).toEqual({ plisto: 1, type: "plisto:visibility", page_open: true });
  });
});

describe("theme", () => {
  it("pushes only to live, initialized records, once per value", async () => {
    const { calls, frame, setTheme } = setup();
    const a = frame("a");
    const b = frame("b");
    const c = frame("c");
    frameLoaded("k-a");
    const done = sendInit("k-a");
    answerInit(calls);
    await done;
    frameLoaded("k-c");
    detachFrame("k-c");

    setTheme("light");
    expect(a.types()).toEqual(["plisto:init"]);
    setTheme("dark");
    setTheme("dark");
    expect(a.types()).toEqual(["plisto:init", "plisto:theme"]);
    expect(a.posted[1].msg).toEqual({ plisto: 1, type: "plisto:theme", theme: "dark" });
    expect(b.posted).toEqual([]);
    expect(c.posted).toEqual([]);
  });

  it("follows up an init whose theme is already stale", async () => {
    const { calls, frame, setTheme } = setup();
    const a = frame("a");
    frameLoaded("k-a");
    const done = sendInit("k-a");
    setTheme("dark");
    answerInit(calls);
    await done;
    expect(a.types()).toEqual(["plisto:init", "plisto:theme"]);
  });
});

describe("heartbeat traffic", () => {
  it("pings only a loaded, live frame", () => {
    const { frame } = setup();
    const a = frame("a");
    expect(sendPing("k-a", 1)).toBe(false);
    frameLoaded("k-a");
    expect(isFrameLoaded("k-a")).toBe(true);
    expect(sendPing("k-a", 1)).toBe(true);
    expect(a.posted).toEqual([{ msg: { plisto: 1, type: "plisto:ping", seq: 1 }, origin: "*" }]);
  });

  it("routes a pong to listeners with the record's mount key", () => {
    const { emit, frame } = setup();
    const a = frame("a");
    const seen: [string, number][] = [];
    const off = onPong((key, seq) => seen.push([key, seq]));
    emit(a, { plisto: 1, type: "plisto:pong", seq: 3 });
    emit(new FakeWindow(), { plisto: 1, type: "plisto:pong", seq: 4 });
    off();
    emit(a, { plisto: 1, type: "plisto:pong", seq: 5 });
    expect(seen).toEqual([["k-a", 3]]);
  });
});

describe("teardown", () => {
  it("removes the listener and drops answers in flight", async () => {
    const { calls, call, frame, hasListener } = setup();
    const a = frame("a");
    call(a, 1);
    stop?.();
    stop = null;
    expect(hasListener()).toBe(false);
    calls[0].resolve({ ok: true, result: 1 });
    await flush();
    expect(a.posted).toEqual([]);
  });
});
