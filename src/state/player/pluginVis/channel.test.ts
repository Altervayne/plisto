import { describe, expect, it } from "vitest";

import {
  CHANNEL_RATE_PER_SEC,
  CHANNEL_WINDOW_MS,
  DROP_LOG_GAP_MS,
  createChannelRelay,
  hasPageFrame,
  stageKindOf,
  type RelayFrame,
} from "./channel";
import { CHANNEL_MAX_BYTES } from "../../../visRuntime/protocol";

import type { HostToFrame } from "../../plugins/bridge";

const PLUGIN = "com.example.rings";
const KIND = `${PLUGIN}/aurora`;
const stage = (kind = KIND, surface = "player"): RelayFrame => ({
  mountKey: `vis|${surface}|${kind}|1.0.0|hash|1`,
  pluginId: kind.slice(0, kind.indexOf("/")),
  role: "visualizer",
});
const still: RelayFrame = {
  mountKey: `vis|still|${KIND}|1.0.0|hash|4`,
  pluginId: PLUGIN,
  role: "visualizer",
};
const page: RelayFrame = { mountKey: "page|1", pluginId: PLUGIN };
const background: RelayFrame = { mountKey: "bg|1", pluginId: PLUGIN };

function setup(frames: RelayFrame[], dev = true) {
  // Kinds a stage keeps hidden, as a kept frame or one still compiling under the dip is.
  const state = { clock: 0, dev, frames, hidden: new Set<string>() };
  const delivered: { to: RelayFrame; message: HostToFrame }[] = [];
  const logs: { pluginId: string; line: string }[] = [];
  const relay = createChannelRelay<RelayFrame>({
    now: () => state.clock,
    frames: (id) => state.frames.filter((f) => f.pluginId === id),
    deliver: (to, message) => delivered.push({ to, message }),
    devMode: () => state.dev,
    shown: (_surface, kind) => !state.hidden.has(kind),
    log: (pluginId, line) => logs.push({ pluginId, line }),
  }).relay;
  return { state, delivered, logs, relay };
}

const send = (data: unknown, kind?: string) => JSON.stringify(kind === undefined ? { data } : { data, kind });

describe("stageKindOf", () => {
  it("reads the kind of a player or ambient stage frame and nothing else", () => {
    expect(stageKindOf(stage().mountKey)).toBe(KIND);
    expect(stageKindOf(stage(KIND, "ambient").mountKey)).toBe(KIND);
    expect(stageKindOf(still.mountKey)).toBeNull();
    expect(stageKindOf("page|1")).toBeNull();
    expect(stageKindOf("vis|player|")).toBeNull();
  });
});

describe("a visualizer frame's message", () => {
  it("reaches the page and the background frame, naming the kind", () => {
    const s = setup([stage(), page, background]);
    s.relay(s.state.frames[0], send({ n: 1 }));
    expect(s.delivered.map((d) => d.to)).toEqual([page, background]);
    expect(s.delivered[0].message).toEqual({
      plisto: 1,
      type: "plisto:channel",
      data: { n: 1 },
      from: { kind: "aurora" },
    });
  });

  it("is dropped when the plugin has no page or background frame", () => {
    const s = setup([stage(), still]);
    s.relay(s.state.frames[0], send(1));
    expect(s.delivered).toEqual([]);
    expect(s.logs.map((l) => l.line)).toEqual([expect.stringContaining("no frame on the other side")]);
  });

  it("is refused from a still or a thumbnail mount, which are not stages", () => {
    const s = setup([still, page]);
    s.relay(still, send(1));
    expect(s.delivered).toEqual([]);
    expect(s.logs[0].line).toContain("not sent by");
  });

  it("is refused when the frame's kind belongs to another plugin", () => {
    const stray = stage("com.other.plug/x");
    const s = setup([stray, page]);
    s.relay({ ...stray, pluginId: PLUGIN }, send(1));
    expect(s.delivered).toEqual([]);
  });

  it("never reaches a page frame of another plugin", () => {
    const other: RelayFrame = { mountKey: "page|2", pluginId: "com.other.plug" };
    const s = setup([stage(), other]);
    s.relay(s.state.frames[0], send(1));
    expect(s.delivered).toEqual([]);
  });
});

describe("a page's message", () => {
  it("reaches every live stage frame of the plugin, without a from", () => {
    const ambient = stage(KIND, "ambient");
    const s = setup([page, stage(), ambient, still]);
    s.relay(page, send("hi"));
    expect(s.delivered.map((d) => d.to)).toEqual([s.state.frames[1], ambient]);
    expect(s.delivered[0].message).toEqual({ plisto: 1, type: "plisto:channel", data: "hi" });
  });

  it("reaches only frames of the named kind", () => {
    const other = stage(`${PLUGIN}/halo`);
    const s = setup([page, stage(), other]);
    s.relay(page, send(1, "halo"));
    expect(s.delivered.map((d) => d.to)).toEqual([other]);
  });

  it("is dropped when only stills are live, or the named kind is not live", () => {
    const s = setup([page, still]);
    s.relay(page, send(1));
    s.state.frames.push(stage());
    s.state.clock += 1000;
    s.relay(page, send(1, "halo"));
    expect(s.delivered).toEqual([]);
    expect(s.logs).toHaveLength(2);
  });

  it("never reaches a stage frame of another plugin", () => {
    const s = setup([page, stage("com.other.plug/x")]);
    s.relay(page, send(1));
    expect(s.delivered).toEqual([]);
  });
});

describe("only shown stage frames count", () => {
  it("sends nothing to a kept or compiling frame, and delivers to the shown one on the other surface", () => {
    const shownFrame = stage(KIND, "ambient");
    const kept = stage(`${PLUGIN}/halo`);
    const s = setup([page, shownFrame, kept]);
    s.state.hidden.add(`${PLUGIN}/halo`);
    s.relay(page, send("hi"));
    expect(s.delivered.map((d) => d.to)).toEqual([shownFrame]);
    s.state.clock += 1000;
    s.relay(page, send("hi", "halo"));
    expect(s.delivered).toHaveLength(1);
    expect(s.logs.map((l) => l.line)).toEqual([expect.stringContaining("no frame on the other side")]);
  });

  it("drops a message from a kept frame as not sent by a live frame", () => {
    const kept = stage();
    const s = setup([page, kept]);
    s.state.hidden.add(KIND);
    s.relay(kept, send(1));
    expect(s.delivered).toEqual([]);
    expect(s.logs[0].line).toContain("not sent by");
  });

  it("hears a kind shown on two surfaces once from each frame, and reaches both", () => {
    const a = stage(KIND, "player");
    const b = stage(KIND, "ambient");
    const s = setup([page, a, b]);
    s.relay(a, send(1));
    s.relay(b, send(1));
    expect(s.delivered.filter((d) => d.to === page)).toHaveLength(2);
    s.relay(page, send(3));
    expect(s.delivered.filter((d) => d.to === a || d.to === b)).toHaveLength(2);
  });
});

describe("limits", () => {
  it("passes at most the limit in any one-second window, whatever the timing", () => {
    const s = setup([stage(), page]);
    const sender = s.state.frames[0];
    const times: number[] = [];
    for (let ms = 0; ms < 5000; ms += 7) {
      s.state.clock = ms;
      const before = s.delivered.length;
      s.relay(sender, send(ms));
      if (s.delivered.length > before) times.push(ms);
    }
    for (const start of times) {
      const inWindow = times.filter((t) => t >= start && t < start + CHANNEL_WINDOW_MS);
      expect(inWindow.length).toBeLessThanOrEqual(CHANNEL_RATE_PER_SEC);
    }
    expect(times.length).toBeGreaterThan(CHANNEL_RATE_PER_SEC * 4);
  });

  it("does not let a burst at the end of one second and the start of the next double the limit", () => {
    const s = setup([stage(), page]);
    const sender = s.state.frames[0];
    s.state.clock = 0;
    for (let i = 0; i < 40; i++) s.relay(sender, send(i));
    expect(s.delivered).toHaveLength(CHANNEL_RATE_PER_SEC);
    s.state.clock = CHANNEL_WINDOW_MS - 1;
    for (let i = 0; i < 40; i++) s.relay(sender, send(i));
    expect(s.delivered).toHaveLength(CHANNEL_RATE_PER_SEC);
    s.state.clock = CHANNEL_WINDOW_MS;
    for (let i = 0; i < 40; i++) s.relay(sender, send(i));
    expect(s.delivered).toHaveLength(CHANNEL_RATE_PER_SEC * 2);
  });

  it("counts each sending frame on its own, and each direction on its own", () => {
    const player = stage();
    const ambient = stage(KIND, "ambient");
    const s = setup([player, ambient, page]);
    for (let i = 0; i < CHANNEL_RATE_PER_SEC; i++) s.relay(player, send(i));
    s.relay(player, send("over"));
    s.relay(ambient, send("ok"));
    s.relay(page, send("down"));
    expect(s.delivered).toHaveLength(CHANNEL_RATE_PER_SEC + 3);
  });

  it("drops a message over the byte limit and passes one at it", () => {
    const s = setup([stage(), page]);
    const sender = s.state.frames[0];
    s.relay(sender, send("x".repeat(CHANNEL_MAX_BYTES - 2)));
    s.relay(sender, send("x".repeat(CHANNEL_MAX_BYTES - 1)));
    s.relay(sender, send("\u00e9".repeat(CHANNEL_MAX_BYTES / 2)));
    expect(s.delivered).toHaveLength(1);
    expect(s.logs[0].line).toContain("over 16384 bytes");
  });

  it("drops arguments that are not a message", () => {
    const s = setup([stage(), page]);
    const sender = s.state.frames[0];
    for (const args of ["not json", "null", "7", "{}", '{"data":1,"kind":4}']) s.relay(sender, args);
    expect(s.delivered).toEqual([]);
  });
});

describe("the developer log", () => {
  it("writes nothing while developer mode is off", () => {
    const s = setup([stage()], false);
    s.relay(s.state.frames[0], send(1));
    expect(s.logs).toEqual([]);
  });

  it("writes one line per plugin and reason a second, and again after the gap", () => {
    const s = setup([stage()]);
    const sender = s.state.frames[0];
    for (let i = 0; i < 4; i++) s.relay(sender, send(i));
    expect(s.logs).toHaveLength(1);
    s.state.clock += DROP_LOG_GAP_MS;
    s.relay(sender, send(5));
    expect(s.logs).toHaveLength(2);
  });

  it("keeps a reason's gap apart from another's", () => {
    const s = setup([stage()]);
    const sender = s.state.frames[0];
    s.relay(sender, send(1));
    s.relay(sender, "not json");
    expect(s.logs.map((l) => l.line)).toEqual([
      expect.stringContaining("no frame"),
      expect.stringContaining("not a JSON message"),
    ]);
  });
});

describe("hasPageFrame", () => {
  const row = (tier: "ui" | "native", entry: string | null, pageFile: string | null) =>
    ({ tier, manifest: { entry, page: pageFile } }) as Parameters<typeof hasPageFrame>[0];

  it("is true for a UI plugin with an entry and a native plugin with a page", () => {
    expect(hasPageFrame(row("ui", "index.html", null))).toBe(true);
    expect(hasPageFrame(row("native", "bin/tool.exe", "ui/page.html"))).toBe(true);
  });

  it("is false without a page: visualizer-only, page-less native, unreadable manifest, no row", () => {
    expect(hasPageFrame(row("ui", null, null))).toBe(false);
    expect(hasPageFrame(row("native", "bin/tool.exe", null))).toBe(false);
    expect(hasPageFrame({ tier: "ui", manifest: null })).toBe(false);
    expect(hasPageFrame(undefined)).toBe(false);
  });
});
