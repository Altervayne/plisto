// -- Test Imports --
import { afterEach, describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { FrameMap } from "./bridge";
import {
  attachFrame,
  detachFrame,
  frameLoaded,
  hasLiveFrame,
  sendInit,
  sendPlaybackStreamEvent,
  sendPluginEvent,
  sendSidebar,
  sendSocket,
  sendStream,
  sendTopicEvent,
  startPluginHost,
} from "./pluginHost";

// -- Type Imports --
import type { FrameRecord, FrameRole } from "./bridge";
import type { FrameTheme, FrameWindow, HostMessage } from "./pluginHost";
import type { PluginCallReply } from "../../types";

class FakeWindow implements FrameWindow {
  posted: Record<string, unknown>[] = [];
  postMessage(message: unknown): void {
    this.posted.push(message as Record<string, unknown>);
  }
  types(): unknown[] {
    return this.posted.map((msg) => msg.type);
  }
}

interface Pending {
  method: string;
  resolve: (reply: PluginCallReply) => void;
}

const INFO = { plugin_id: "plug-a", theme: "light", granted: [] };

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let stop: (() => void) | null = null;

afterEach(() => {
  stop?.();
  stop = null;
});

function setup(granted: string[] = []) {
  let listener: ((event: HostMessage) => void) | null = null;
  let themeListener: () => void = () => {};
  let theme: FrameTheme = "light";
  const calls: Pending[] = [];
  const invoke = vi.fn(
    (_id: string, method: string) => new Promise<PluginCallReply>((resolve) => calls.push({ method, resolve })),
  );
  const fetch = vi.fn(() => new Promise<ArrayBuffer>(() => {}));
  const gone = vi.fn();
  stop = startPluginHost({
    addListener: (fn) => {
      listener = fn;
      return () => {
        listener = null;
      };
    },
    invoke,
    fetch,
    frameGone: gone,
    granted: () => granted,
    theme: () => theme,
    subscribeTheme: (fn) => {
      themeListener = fn;
      return () => {};
    },
  });
  const call = (source: FakeWindow, id: number, method: string, args = "{}") =>
    listener?.({ origin: "null", source, data: { plisto: 1, type: "plisto:call", id, method, args } });
  const setTheme = (next: FrameTheme) => {
    theme = next;
    themeListener();
  };
  return { calls, invoke, fetch, gone, call, setTheme };
}

/** Attaches, loads and initialises one frame; resolves once its init is posted. */
async function liveFrame(calls: Pending[], mountKey: string, role?: FrameRole) {
  const win = new FakeWindow();
  attachFrame(mountKey, "plug-a", win, role);
  frameLoaded(mountKey);
  const from = calls.length;
  const done = sendInit(mountKey);
  calls[from].resolve({ ok: true, result: INFO });
  calls[from + 1].resolve({ ok: true, result: { methods: [] } });
  expect(await done).toBe(true);
  return win;
}

const deliverAll = () => {
  const chunk = new Uint8Array([1]).buffer;
  return [
    sendSidebar("plug-a", { item_id: "auto", value: true, gesture: "g1.x" }),
    sendPluginEvent("plug-a", "level", 1),
    sendPlaybackStreamEvent("plug-a", { item: -1, kind: "ended", reason: "network", detail: null }),
    sendTopicEvent("plug-a", "theme", 1, 2),
    sendStream("plug-a", { stream: "t1", kind: "chunk", seq: 1, data: chunk }),
    sendSocket("plug-a", { socket: "s1", kind: "text", data: "x" }),
  ];
};

describe("FrameMap role helpers", () => {
  const rec = (mountKey: string, role?: FrameRole): FrameRecord<string> => ({
    mountKey,
    pluginId: "p",
    source: mountKey,
    ...(role ? { role } : {}),
    loads: 1,
    pending: 0,
    dead: false,
  });

  it("leave visualizer records out of delivery and the page session", () => {
    const map = new FrameMap<string>();
    const unroled = rec("k1");
    const vis = rec("k2", "visualizer");
    const page = rec("k3", "page");
    for (const r of [unroled, vis, page]) map.attach(r.source, r);
    expect(map.byPlugin("p")).toEqual([unroled, vis, page]);
    expect(map.deliverable("p")).toEqual([unroled, page]);
    expect(map.sessionFrames("p")).toEqual([unroled, page]);
  });
});

describe("visualizer frames and the page session", () => {
  it("never report the plugin gone on mount or unmount", async () => {
    const { calls, gone } = setup();
    await liveFrame(calls, "k-vis", "visualizer");
    detachFrame("k-vis");
    attachFrame("k-vis2", "plug-a", new FakeWindow(), "visualizer");
    detachFrame("k-vis2");
    expect(gone).not.toHaveBeenCalled();
  });

  it("do not keep the session open once the page frame goes", async () => {
    const { calls, gone } = setup();
    await liveFrame(calls, "k-page");
    attachFrame("k-vis", "plug-a", new FakeWindow(), "visualizer");
    detachFrame("k-page");
    expect(gone.mock.calls).toEqual([["plug-a"]]);
    detachFrame("k-vis");
    expect(gone).toHaveBeenCalledTimes(1);
  });

  it("are not reported on stop", () => {
    const { gone } = setup();
    attachFrame("k-vis", "plug-a", new FakeWindow(), "visualizer");
    stop?.();
    stop = null;
    expect(gone).not.toHaveBeenCalled();
  });

  it("leave the page frame live and deliverable across a mount and an unmount", async () => {
    const { calls } = setup();
    const page = await liveFrame(calls, "k-page");
    await liveFrame(calls, "k-vis", "visualizer");
    expect(hasLiveFrame("plug-a")).toBe(true);
    detachFrame("k-vis");
    expect(hasLiveFrame("plug-a")).toBe(true);
    expect(sendPluginEvent("plug-a", "level", 1)).toBe(true);
    expect(page.types()).toEqual(["plisto:init", "plisto:plugin-event"]);
  });
});

describe("re-attach", () => {
  it("reports the plugin gone when a visualizer record takes its last page frame's key", async () => {
    const { calls, gone } = setup();
    await liveFrame(calls, "k-a");
    attachFrame("k-a", "plug-a", new FakeWindow(), "visualizer");
    expect(gone.mock.calls).toEqual([["plug-a"]]);
  });

  it("reports the plugin gone when a visualizer record takes its last page frame's window", async () => {
    const { calls, gone } = setup();
    const win = await liveFrame(calls, "k-a");
    attachFrame("k-vis", "plug-a", win, "visualizer");
    expect(gone.mock.calls).toEqual([["plug-a"]]);
  });

  it("keeps the session through a page remount of the same plugin, by key or by window", async () => {
    const { calls, gone } = setup();
    const win = await liveFrame(calls, "k-a");
    attachFrame("k-a2", "plug-a", win);
    attachFrame("k-a2", "plug-a", new FakeWindow());
    expect(gone).not.toHaveBeenCalled();
    detachFrame("k-a2");
    expect(gone.mock.calls).toEqual([["plug-a"]]);
  });

  it("reports nothing when a visualizer record is replaced", () => {
    const { gone } = setup();
    const win = new FakeWindow();
    attachFrame("k-vis", "plug-a", win, "visualizer");
    attachFrame("k-vis", "plug-a", new FakeWindow(), "visualizer");
    attachFrame("k-vis2", "plug-a", win, "visualizer");
    expect(gone).not.toHaveBeenCalled();
  });
});

describe("theme pushes", () => {
  it("reach an initialised visualizer frame as well as the page frame", async () => {
    const h = setup();
    const page = await liveFrame(h.calls, "k-page");
    const vis = await liveFrame(h.calls, "k-vis", "visualizer");
    h.setTheme("dark");
    expect(vis.types()).toEqual(["plisto:init", "plisto:theme"]);
    expect(vis.posted[1]).toEqual({ plisto: 1, type: "plisto:theme", theme: "dark" });
    expect(page.types()).toEqual(["plisto:init", "plisto:theme"]);
  });
});

describe("delivery to visualizer frames", () => {
  it("sends no event, topic, stream or socket to a lone visualizer frame", async () => {
    const h = setup(["storage"]);
    const vis = await liveFrame(h.calls, "k-vis", "visualizer");
    expect(deliverAll()).toEqual([false, false, false, false, false, false]);
    expect(hasLiveFrame("plug-a")).toBe(false);
    expect(vis.types()).toEqual(["plisto:init"]);
  });

  it("sends everything to the page frame, never to a newer visualizer frame", async () => {
    const h = setup(["storage"]);
    const page = await liveFrame(h.calls, "k-page");
    const at = h.calls.length;
    h.call(page, 1, "events.subscribe", '{"topics":["theme"]}');
    h.calls[at].resolve({ ok: true, result: { topics: ["theme"], current: {}, mark: 0 } });
    await flush();
    const vis = await liveFrame(h.calls, "k-vis", "visualizer");
    expect(deliverAll()).toEqual([true, true, true, true, true, true]);
    expect(vis.types()).toEqual(["plisto:init"]);
    expect(page.types()).toEqual([
      "plisto:init",
      "plisto:result",
      "plisto:sidebar",
      "plisto:plugin-event",
      "plisto:plugin-event",
      "plisto:event",
      "plisto:stream",
      "plisto:socket",
    ]);
  });
});

describe("calls from visualizer frames", () => {
  const denied = (id: number) => ({
    plisto: 1,
    type: "plisto:result",
    id,
    ok: false,
    error: { code: "denied", message: "A visualizer frame cannot call this method." },
  });

  it("refuses a disallowed call without reaching Rust", () => {
    const h = setup(["storage"]);
    const vis = new FakeWindow();
    attachFrame("k-vis", "plug-a", vis, "visualizer");
    h.call(vis, 1, "events.subscribe", '{"topics":["theme"]}');
    h.call(vis, 2, "net.fetch", '{"url":"https://example.com"}');
    h.call(vis, 3, "ui.toast");
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(vis.posted).toEqual([denied(1), denied(2), denied(3)]);
  });

  it("forwards an allowed call with the record's plugin id and answers it", async () => {
    const h = setup();
    const vis = new FakeWindow();
    attachFrame("k-vis", "plug-a", vis, "visualizer");
    h.call(vis, 1, "playback.state");
    expect(h.invoke).toHaveBeenCalledWith("plug-a", "playback.state", "{}");
    h.calls[0].resolve({ ok: true, result: { playing: false } });
    await flush();
    expect(vis.posted).toEqual([{ plisto: 1, type: "plisto:result", id: 1, ok: true, result: { playing: false } }]);
  });

  it("refuses storage without the grant and forwards it with the grant", () => {
    const without = setup();
    const a = new FakeWindow();
    attachFrame("k-vis", "plug-a", a, "visualizer");
    without.call(a, 1, "storage.get", '{"key":"x"}');
    expect(without.invoke).not.toHaveBeenCalled();
    expect(a.posted).toEqual([denied(1)]);

    const granted = setup(["storage"]);
    const b = new FakeWindow();
    attachFrame("k-vis", "plug-a", b, "visualizer");
    granted.call(b, 1, "storage.get", '{"key":"x"}');
    expect(granted.invoke).toHaveBeenCalledWith("plug-a", "storage.get", '{"key":"x"}');
  });

  it("leaves a page frame's calls unscreened", () => {
    const h = setup();
    const page = new FakeWindow();
    attachFrame("k-page", "plug-a", page);
    h.call(page, 1, "ui.toast");
    expect(h.invoke).toHaveBeenCalledWith("plug-a", "ui.toast", "{}");
  });
});
