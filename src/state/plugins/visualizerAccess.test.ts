// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { screenCall, visualizerMay } from "./visualizerAccess";

// -- Type Imports --
import type { Action, FrameRecord, FrameRole } from "./bridge";

const rec = (role?: FrameRole): FrameRecord<string> => ({
  mountKey: "k",
  pluginId: "plug-a",
  source: "w",
  ...(role ? { role } : {}),
  loads: 1,
  pending: 0,
  dead: false,
});

const callOf = (method: string, role?: FrameRole): Action<string> => ({
  kind: "call",
  rec: rec(role),
  callId: 9,
  method,
  args: "{}",
  body: null,
});

describe("visualizerMay", () => {
  it("allows the log, playback state and library reads", () => {
    for (const method of ["log.write", "playback.state", "library.tracks", "library.cover"]) {
      expect(visualizerMay(method, [])).toBe(true);
    }
  });

  it("matches exact names, never a namespace", () => {
    for (const method of ["log.other", "channel.post", "storage.other", "library.tracks.extra"]) {
      expect(visualizerMay(method, ["storage"])).toBe(false);
    }
  });

  it("allows storage only with the storage grant", () => {
    expect(visualizerMay("storage.get", [])).toBe(false);
    expect(visualizerMay("storage.set", ["library.read"])).toBe(false);
    expect(visualizerMay("storage.get", ["storage"])).toBe(true);
    expect(visualizerMay("storage.clear", ["storage"])).toBe(true);
  });

  it("refuses everything that needs a delivery target, controls playback or reaches the network", () => {
    const refused = [
      "events.subscribe",
      "net.fetch",
      "net.abort",
      "stream.play",
      "stream.push",
      "ui.toast",
      "ui.confirm",
      "ui.open_page",
      "ui.chips",
      "playback.queue",
      "playback.toggle",
      "playback.seek",
      "queue.add",
      "app.info",
      "library.write",
    ];
    for (const method of refused) expect(visualizerMay(method, ["storage", "library.read"])).toBe(false);
  });
});

describe("screenCall", () => {
  const all = () => ["storage"];

  it("passes every call of a page or an unroled record", () => {
    for (const role of ["page", undefined] as const) {
      const action = callOf("net.fetch", role);
      expect(screenCall(action, all)).toBe(action);
    }
  });

  it("passes an allowed call of a visualizer record unchanged", () => {
    const action = callOf("storage.get", "visualizer");
    expect(screenCall(action, all)).toBe(action);
  });

  it("answers a refused visualizer call denied, to that call only", () => {
    const action = callOf("events.subscribe", "visualizer");
    const out = screenCall(action, all);
    expect(out).toEqual({
      kind: "reply",
      rec: action.kind === "call" ? action.rec : null,
      msg: {
        plisto: 1,
        type: "plisto:result",
        id: 9,
        ok: false,
        error: { code: "denied", message: "A visualizer frame cannot call this method." },
      },
    });
  });

  it("refuses storage when the grants lookup throws", () => {
    const out = screenCall(callOf("storage.get", "visualizer"), () => {
      throw new Error("store gone");
    });
    expect(out.kind).toBe("reply");
  });

  it("leaves drops, replies and pongs alone", () => {
    const drop: Action<string> = { kind: "drop" };
    const pong: Action<string> = { kind: "pong", rec: rec("visualizer"), seq: 1 };
    expect(screenCall(drop, all)).toBe(drop);
    expect(screenCall(pong, all)).toBe(pong);
  });
});
