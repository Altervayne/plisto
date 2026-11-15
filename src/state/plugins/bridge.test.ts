// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import {
  ARGS_MAX_CHARS,
  BODY_MAX_BYTES,
  FrameMap,
  MAX_PENDING_PER_FRAME,
  initMsg,
  pingMsg,
  pluginEventMsg,
  resultMsg,
  route,
  routeMsg,
  sidebarMsg,
  socketMsg,
  streamMsg,
  themeMsg,
  visibilityMsg,
} from "./bridge";

// -- Type Imports --
import type { AppInfo, FrameRecord } from "./bridge";

type Win = { name: string };

const win = (name: string): Win => ({ name });

function rec(source: Win, over: Partial<FrameRecord<Win>> = {}): FrameRecord<Win> {
  return { mountKey: `k-${source.name}`, pluginId: `plug-${source.name}`, source, loads: 1, pending: 0, dead: false, ...over };
}

const call = (over: Record<string, unknown> = {}) => ({
  plisto: 1,
  type: "plisto:call",
  id: 1,
  method: "storage.get",
  args: "{}",
  ...over,
});

function setup() {
  const map = new FrameMap<Win>();
  const source = win("a");
  const record = rec(source);
  map.attach(source, record);
  const send = (data: unknown, over: { origin?: string; source?: Win | null } = {}) =>
    route(map, { origin: "null", source, data, ...over });
  return { map, source, record, send };
}

describe("route: who sent it", () => {
  it("drops a non-null origin", () => {
    const { send } = setup();
    expect(send(call(), { origin: "http://localhost" })).toEqual({ kind: "drop" });
    expect(send(call(), { origin: "" })).toEqual({ kind: "drop" });
  });

  it("drops a source that is not in the map", () => {
    const { send } = setup();
    expect(send(call(), { source: win("forger") })).toEqual({ kind: "drop" });
    expect(send(call(), { source: null })).toEqual({ kind: "drop" });
  });

  it("drops a dead record and a detached one", () => {
    const { map, record, send } = setup();
    record.dead = true;
    expect(send(call())).toEqual({ kind: "drop" });
    record.dead = false;
    map.detach(record.mountKey);
    expect(send(call())).toEqual({ kind: "drop" });
  });

  it("takes the plugin id from the record, never from the message", () => {
    const { record, send } = setup();
    const action = send(call({ pluginId: "evil", plugin_id: "evil", id: 7 }));
    expect(action).toEqual({
      kind: "call",
      rec: record,
      callId: 7,
      method: "storage.get",
      args: "{}",
      body: null,
    });
    if (action.kind === "call") expect(action.rec.pluginId).toBe("plug-a");
  });

  it("drops a call whose id is a string, even beside a pluginId", () => {
    const { send } = setup();
    expect(send(call({ id: "evil", pluginId: "evil" }))).toEqual({ kind: "drop" });
  });
});

describe("route: hostile data", () => {
  it("drops every non-plain value", () => {
    const { send } = setup();
    const nullProto = Object.assign(Object.create(null), call());
    class Custom {
      plisto = 1;
      type = "plisto:call";
      id = 1;
      method = "a.b";
      args = "{}";
    }
    const values: unknown[] = [
      null,
      undefined,
      42,
      "plisto:call",
      true,
      [call()],
      new Blob(["x"]),
      new ArrayBuffer(4),
      new Custom(),
      nullProto,
      () => call(),
    ];
    for (const value of values) expect(send(value)).toEqual({ kind: "drop" });
  });

  it("never runs a getter on the message", () => {
    const { send } = setup();
    let ran = 0;
    const data = {
      plisto: 1,
      type: "plisto:call",
      id: 1,
      method: "a.b",
      get args() {
        ran++;
        return "{}";
      },
    };
    expect(send(data)).toEqual({ kind: "reply", rec: expect.anything(), msg: expect.anything() });
    expect(ran).toBe(0);
    const typeGetter = {
      plisto: 1,
      get type() {
        ran++;
        return "plisto:pong";
      },
      seq: 1,
    };
    expect(send(typeGetter)).toEqual({ kind: "drop" });
    expect(ran).toBe(0);
  });

  it("drops a proxy that throws", () => {
    const { send } = setup();
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("trap");
        },
      },
    );
    expect(send(hostile)).toEqual({ kind: "drop" });
  });

  it("drops a wrong protocol number, a string protocol and an unknown type", () => {
    const { send } = setup();
    expect(send(call({ plisto: 2 }))).toEqual({ kind: "drop" });
    expect(send(call({ plisto: "1" }))).toEqual({ kind: "drop" });
    expect(send(call({ type: "plisto:init" }))).toEqual({ kind: "drop" });
    expect(send(call({ type: "plisto:ping" }))).toEqual({ kind: "drop" });
    expect(send(call({ type: 5 }))).toEqual({ kind: "drop" });
    expect(send({ type: "plisto:call" })).toEqual({ kind: "drop" });
  });

  it("drops a frame that sends the host-only sidebar and route messages", () => {
    const { send } = setup();
    const sidebar = { plisto: 1, type: "plisto:sidebar", item_id: "auto", value: true, gesture: "g1.x" };
    const routeMessage = { plisto: 1, type: "plisto:route", route: "settings" };
    expect(send(sidebar)).toEqual({ kind: "drop" });
    expect(send(routeMessage)).toEqual({ kind: "drop" });
    expect(send(call({ type: "plisto:sidebar" }))).toEqual({ kind: "drop" });
    expect(send(call({ type: "plisto:route" }))).toEqual({ kind: "drop" });
  });
});

describe("route: pong", () => {
  it("accepts a safe integer seq of at least 1", () => {
    const { record, send } = setup();
    expect(send({ plisto: 1, type: "plisto:pong", seq: 3 })).toEqual({ kind: "pong", rec: record, seq: 3 });
  });

  it("drops a bad seq", () => {
    const { send } = setup();
    for (const seq of [0, -1, 1.5, NaN, Infinity, "1", null, undefined, 2 ** 53]) {
      expect(send({ plisto: 1, type: "plisto:pong", seq })).toEqual({ kind: "drop" });
    }
  });
});

describe("route: host-to-frame only types", () => {
  it("drops a plugin event sent by a frame", () => {
    const { send } = setup();
    expect(send({ plisto: 1, type: "plisto:plugin-event", topic: "level", data: 1 })).toEqual({ kind: "drop" });
  });

  it("drops an app event topic sent by a frame", () => {
    const { send } = setup();
    expect(send({ plisto: 1, type: "plisto:event", topic: "theme", data: 1 })).toEqual({ kind: "drop" });
  });
});

describe("route: call", () => {
  it("forwards a well-formed call", () => {
    const { record, send } = setup();
    expect(send(call({ id: 5, method: "storage.set", args: '{"key":"a","value":1}' }))).toEqual({
      kind: "call",
      rec: record,
      callId: 5,
      method: "storage.set",
      args: '{"key":"a","value":1}',
      body: null,
    });
  });

  it("drops a call with no usable id, with nothing to answer", () => {
    const { send } = setup();
    for (const id of [0, -3, 1.5, NaN, Infinity, 2 ** 53, null, undefined, {}, [1]]) {
      expect(send(call({ id }))).toEqual({ kind: "drop" });
    }
  });

  const code = (action: ReturnType<typeof route<Win>>) =>
    action.kind === "reply" && action.msg.type === "plisto:result" && !action.msg.ok
      ? { id: action.msg.id, code: action.msg.error.code }
      : null;

  it("answers invalid_args for a bad method or args", () => {
    const { send } = setup();
    const bad = [
      { method: 5 },
      { method: undefined },
      { method: "" },
      { method: "nodot" },
      { method: "Upper.case" },
      { method: "a.b.c.d.e" },
      { method: "a..b" },
      { method: "1a.b" },
      { method: "a.b-c" },
      { method: `a.${"b".repeat(63)}` },
      { args: 5 },
      { args: undefined },
      { args: { key: "a" } },
    ];
    for (const over of bad) expect(code(send(call({ id: 9, ...over })))).toEqual({ id: 9, code: "invalid_args" });
  });

  it("accepts a method of exactly 64 characters", () => {
    const { send } = setup();
    const method = `a.${"b".repeat(62)}`;
    expect(method).toHaveLength(64);
    expect(send(call({ method })).kind).toBe("call");
  });

  it("answers too_large above the args cap and accepts the cap itself", () => {
    const { send } = setup();
    expect(send(call({ args: "x".repeat(ARGS_MAX_CHARS) })).kind).toBe("call");
    expect(code(send(call({ id: 4, args: "x".repeat(ARGS_MAX_CHARS + 1) })))).toEqual({
      id: 4,
      code: "too_large",
    });
  });

  it("answers busy at the pending cap and passes one below", () => {
    const { record, send } = setup();
    record.pending = MAX_PENDING_PER_FRAME - 1;
    expect(send(call()).kind).toBe("call");
    record.pending = MAX_PENDING_PER_FRAME;
    expect(code(send(call({ id: 2 })))).toEqual({ id: 2, code: "busy" });
  });

  it("checks the rules in order: shape before size before pending", () => {
    const { record, send } = setup();
    record.pending = MAX_PENDING_PER_FRAME;
    expect(code(send(call({ method: "bad", args: "x".repeat(ARGS_MAX_CHARS + 1) })))).toEqual({
      id: 1,
      code: "invalid_args",
    });
    expect(code(send(call({ args: "x".repeat(ARGS_MAX_CHARS + 1) })))).toEqual({
      id: 1,
      code: "too_large",
    });
  });

  it("does not change the record", () => {
    const { record, send } = setup();
    const before = { ...record };
    send(call());
    expect(record).toEqual(before);
  });
});

describe("route: body", () => {
  const fetchCall = (over: Record<string, unknown> = {}) => call({ method: "net.fetch", args: '{"url":"https://a.example"}', ...over });
  const code = (action: ReturnType<typeof route<Win>>) =>
    action.kind === "reply" && action.msg.type === "plisto:result" && !action.msg.ok ? action.msg.error.code : null;

  it("carries an ArrayBuffer body on net.fetch, up to the cap itself", () => {
    const { send } = setup();
    for (const size of [0, 3, BODY_MAX_BYTES]) {
      const body = new ArrayBuffer(size);
      const action = send(fetchCall({ body }));
      expect(action.kind).toBe("call");
      if (action.kind === "call") expect(action.body).toBe(body);
    }
    const plain = send(fetchCall());
    expect(plain.kind === "call" && plain.body).toBeNull();
  });

  it("refuses a body on any other method", () => {
    const { send } = setup();
    for (const body of [new ArrayBuffer(1), null, undefined]) {
      expect(code(send(call({ method: "storage.set", body })))).toBe("invalid_args");
    }
    expect(code(send(call({ method: "net.socket.send", body: new ArrayBuffer(1) })))).toBe("invalid_args");
  });

  it("refuses every body that is not a real ArrayBuffer", () => {
    const { send } = setup();
    const lookalike = { byteLength: 3, slice: () => new ArrayBuffer(3) };
    const tagged = { [Symbol.toStringTag]: "ArrayBuffer", byteLength: 3 };
    const values: unknown[] = [
      new Uint8Array(3),
      new DataView(new ArrayBuffer(3)),
      new Blob(["abc"]),
      new SharedArrayBuffer(3),
      lookalike,
      tagged,
      Object.create(ArrayBuffer.prototype),
      new Proxy(new ArrayBuffer(3), {}),
      [1, 2, 3],
      "abc",
      3,
      null,
      undefined,
    ];
    for (const body of values) expect(code(send(fetchCall({ body })))).toBe("invalid_args");
  });

  it("refuses an accessor body without running it, and reads a real buffer's length without its own getter", () => {
    const { send } = setup();
    let ran = 0;
    const data = fetchCall();
    Object.defineProperty(data, "body", {
      enumerable: true,
      get() {
        ran++;
        return new ArrayBuffer(1);
      },
    });
    expect(code(send(data))).toBe("invalid_args");

    const big = new ArrayBuffer(BODY_MAX_BYTES + 1);
    Object.defineProperty(big, "byteLength", {
      get() {
        ran++;
        return 1;
      },
    });
    expect(code(send(fetchCall({ body: big })))).toBe("too_large");
    expect(ran).toBe(0);
  });

  it("answers too_large above the cap, after the shape checks", () => {
    const { send } = setup();
    expect(code(send(fetchCall({ body: new ArrayBuffer(BODY_MAX_BYTES + 1) })))).toBe("too_large");
    expect(code(send(call({ body: new ArrayBuffer(BODY_MAX_BYTES + 1) })))).toBe("invalid_args");
    expect(code(send(fetchCall({ body: new Uint8Array(1), args: "x".repeat(ARGS_MAX_CHARS + 1) })))).toBe("invalid_args");
  });
});

describe("FrameMap", () => {
  it("attaches, finds by source and key, and lists live records", () => {
    const map = new FrameMap<Win>();
    const a = rec(win("a"));
    const b = rec(win("b"));
    map.attach(a.source, a);
    map.attach(b.source, b);
    expect(map.get(a.source)).toBe(a);
    expect(map.byKey(b.mountKey)).toBe(b);
    b.dead = true;
    expect(map.live()).toEqual([a]);
  });

  it("detaches and marks the record dead", () => {
    const map = new FrameMap<Win>();
    const a = rec(win("a"));
    map.attach(a.source, a);
    expect(map.detach(a.mountKey)).toBe(a);
    expect(a.dead).toBe(true);
    expect(map.get(a.source)).toBeUndefined();
    expect(map.byKey(a.mountKey)).toBeUndefined();
    expect(map.live()).toEqual([]);
    expect(map.detach("missing")).toBeUndefined();
  });

  it("lists only the live records of one plugin, oldest first", () => {
    const map = new FrameMap<Win>();
    const first = rec(win("a"), { mountKey: "k1", pluginId: "p" });
    const second = rec(win("b"), { mountKey: "k2", pluginId: "p" });
    const other = rec(win("c"), { mountKey: "k3", pluginId: "q" });
    const gone = rec(win("d"), { mountKey: "k4", pluginId: "p" });
    for (const r of [first, second, other, gone]) map.attach(r.source, r);
    map.detach("k4");
    expect(map.byPlugin("p")).toEqual([first, second]);
    expect(map.byPlugin("q")).toEqual([other]);
    second.dead = true;
    expect(map.byPlugin("p")).toEqual([first]);
    expect(map.byPlugin("none")).toEqual([]);
  });
});

describe("builders", () => {
  it("builds the host messages with the protocol number", () => {
    const info = { plugin_id: "x" } as AppInfo;
    expect(initMsg(info, ["app.info"], true, "/r")).toEqual({
      plisto: 1,
      type: "plisto:init",
      info,
      methods: ["app.info"],
      page_open: true,
      route: "/r",
    });
    expect(pingMsg(4)).toEqual({ plisto: 1, type: "plisto:ping", seq: 4 });
    expect(visibilityMsg(false)).toEqual({ plisto: 1, type: "plisto:visibility", page_open: false });
    expect(themeMsg("dark")).toEqual({ plisto: 1, type: "plisto:theme", theme: "dark" });
  });

  it("builds the plugin event message", () => {
    expect(pluginEventMsg("level", { db: -3 })).toEqual({
      plisto: 1,
      type: "plisto:plugin-event",
      topic: "level",
      data: { db: -3 },
    });
  });

  it("builds the stream and socket messages", () => {
    const data = new ArrayBuffer(2);
    expect(streamMsg({ stream: "t1", kind: "chunk", seq: 1, data })).toEqual({
      plisto: 1,
      type: "plisto:stream",
      stream: "t1",
      kind: "chunk",
      seq: 1,
      data,
    });
    expect(streamMsg({ stream: "t1", kind: "error", code: "network", reason: "protocol" })).toEqual({
      plisto: 1,
      type: "plisto:stream",
      stream: "t1",
      kind: "error",
      code: "network",
      reason: "protocol",
    });
    expect(socketMsg({ socket: "s1", kind: "text", data: "hi" })).toEqual({
      plisto: 1,
      type: "plisto:socket",
      socket: "s1",
      kind: "text",
      data: "hi",
    });
  });

  it("drops a frame that sends the host-only stream and socket messages", () => {
    const { send } = setup();
    expect(send({ plisto: 1, type: "plisto:stream", stream: "t1", kind: "end" })).toEqual({ kind: "drop" });
    expect(send({ plisto: 1, type: "plisto:socket", socket: "s1", kind: "text", data: "x" })).toEqual({ kind: "drop" });
  });

  it("builds the sidebar and route messages", () => {
    expect(sidebarMsg("auto", true, "g1.abc")).toEqual({
      plisto: 1,
      type: "plisto:sidebar",
      item_id: "auto",
      value: true,
      gesture: "g1.abc",
    });
    expect(sidebarMsg("ping", null, "g1.abc")).toMatchObject({ value: null });
    expect(routeMsg("settings")).toEqual({ plisto: 1, type: "plisto:route", route: "settings" });
    expect(routeMsg(null)).toEqual({ plisto: 1, type: "plisto:route", route: null });
  });

  it("builds a result from a reply, success or error", () => {
    expect(resultMsg(3, { ok: true, result: { a: 1 } })).toEqual({
      plisto: 1,
      type: "plisto:result",
      id: 3,
      ok: true,
      result: { a: 1 },
    });
    expect(resultMsg(3, { ok: true })).toMatchObject({ ok: true, result: null });
    const error = { code: "rate_limited" as const, message: "slow", retry_after_ms: 400 };
    expect(resultMsg(3, { ok: false, error })).toEqual({
      plisto: 1,
      type: "plisto:result",
      id: 3,
      ok: false,
      error,
    });
    expect(resultMsg(3, { ok: false })).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });
});
