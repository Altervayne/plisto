// -- Test Imports --
import { afterEach, describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { attachFrame, frameLoaded, sendInit, startPluginHost } from "./pluginHost";
import { registerStage, type StageHandle } from "../player/pluginVis/frameCache";

// -- Type Imports --
import type { FrameWindow, HostMessage } from "./pluginHost";
import type { PluginCallReply } from "../../types";

class FakeWindow implements FrameWindow {
  posted: Record<string, unknown>[] = [];
  postMessage(message: unknown): void {
    this.posted.push(message as Record<string, unknown>);
  }
  channel() {
    return this.posted.filter((m) => m.type === "plisto:channel");
  }
  results() {
    return this.posted.filter((m) => m.type === "plisto:result");
  }
}

const PLUGIN = "com.example.rings";
const STAGE_KEY = `vis|player|${PLUGIN}/aurora|1.0.0|hash|1`;
const STILL_KEY = `vis|still|${PLUGIN}/aurora|1.0.0|hash|2`;

const ANSWERS: Record<string, unknown> = {
  "app.info": { theme: "light" },
  "app.methods": { methods: ["log.write"] },
};

let stop: (() => void) | null = null;

let unregister: (() => void) | null = null;

afterEach(() => {
  stop?.();
  stop = null;
  unregister?.();
  unregister = null;
});

function setup(devMode = false) {
  let listener: ((event: HostMessage) => void) | null = null;
  const invoke = vi.fn((_id: string, method: string, _args: string) =>
    Promise.resolve<PluginCallReply>({
      ok: true,
      result: ANSWERS[method] ?? null,
    }),
  );
  unregister = registerStage({
    surface: "player",
    kind: `${PLUGIN}/aurora`,
    phase: () => "ready",
    shown: () => true,
  } as unknown as StageHandle);
  stop = startPluginHost({
    addListener: (fn) => {
      listener = fn;
      return () => {
        listener = null;
      };
    },
    invoke,
    fetch: () => new Promise<ArrayBuffer>(() => {}),
    theme: () => "light",
    subscribeTheme: () => () => {},
    devMode: () => devMode,
  });
  const page = new FakeWindow();
  const stage = new FakeWindow();
  const still = new FakeWindow();
  attachFrame("page-1", PLUGIN, page);
  attachFrame(STAGE_KEY, PLUGIN, stage, "visualizer");
  attachFrame(STILL_KEY, PLUGIN, still, "visualizer");
  const send = (from: FakeWindow, id: number, args: unknown) =>
    listener?.({
      origin: "null",
      source: from,
      data: { plisto: 1, type: "plisto:call", id, method: "channel.send", args: JSON.stringify(args) },
    });
  return { page, stage, still, send, invoke };
}

describe("the channel through the host", () => {
  it("lists channel.send among the methods a page is told at init", async () => {
    const s = setup();
    expect(frameLoaded("page-1")).toBe("first");
    await sendInit("page-1");
    const init = s.page.posted.find((m) => m.type === "plisto:init");
    expect(init?.methods).toEqual(["log.write", "channel.send"]);
  });

  it("relays a stage frame's message to the page and answers the call without forwarding it", () => {
    const s = setup();
    s.send(s.stage, 1, { data: { level: 0.5 } });
    expect(s.page.channel()).toEqual([
      { plisto: 1, type: "plisto:channel", data: { level: 0.5 }, from: { kind: "aurora" } },
    ]);
    expect(s.stage.results()).toEqual([{ plisto: 1, type: "plisto:result", id: 1, ok: true, result: null }]);
    expect(s.invoke).not.toHaveBeenCalled();
  });

  it("relays a page's message to the stage frame only, never to a still", () => {
    const s = setup();
    s.send(s.page, 1, { data: "tune" });
    expect(s.stage.channel()).toEqual([{ plisto: 1, type: "plisto:channel", data: "tune" }]);
    expect(s.still.channel()).toEqual([]);
    expect(s.page.results()).toHaveLength(1);
  });

  it("answers a dropped message like a delivered one and logs the drop only in developer mode", () => {
    const quiet = setup(false);
    quiet.send(quiet.still, 1, { data: 1 });
    const answer = { plisto: 1, type: "plisto:result", id: 1, ok: true, result: null };
    expect(quiet.still.results()).toEqual([answer]);
    expect(quiet.invoke).not.toHaveBeenCalled();
    stop?.();
    const loud = setup(true);
    loud.send(loud.still, 1, { data: 1 });
    expect(loud.invoke).toHaveBeenCalledTimes(1);
    const [id, method, args] = loud.invoke.mock.calls[0];
    expect([id, method]).toEqual([PLUGIN, "log.write"]);
    expect(JSON.parse(args)).toMatchObject({ level: "warn" });
  });
});
