// -- Test Imports --
import { describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { EVENT_NET, TRACKED_MAX, createNetSync, startNetSync } from "./usePluginNet";
import { pluginRuntimeReady } from "./frameModel";

// -- Type Imports --
import type { SocketDelivery, StreamDelivery } from "./bridge";
import type { NetSyncDeps } from "./usePluginNet";

type Handler = (event: { payload: unknown }) => void;

function setup() {
  const off = vi.fn();
  let handler: Handler = () => {};
  let name = "";
  const listen = vi.fn((n: string, h: Handler) => {
    name = n;
    handler = h;
    return Promise.resolve(off);
  });
  const streams: [string, StreamDelivery][] = [];
  const sockets: [string, SocketDelivery][] = [];
  const cancelStream = vi.fn();
  const closeSocket = vi.fn();
  // Whether the plugin has a frame to take stream events.
  const frame = { live: true };
  const stop = createNetSync({
    listen,
    sendStream: (id, delivery) => {
      if (!frame.live) return false;
      streams.push([id, delivery]);
      return true;
    },
    sendSocket: (id, delivery) => {
      sockets.push([id, delivery]);
      return true;
    },
    cancelStream,
    closeSocket,
  });
  return {
    streams,
    sockets,
    cancelStream,
    closeSocket,
    frame,
    off,
    emit: (payload: unknown) => handler({ payload }),
    name: () => name,
    stop,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const text = (buffer: unknown) => new TextDecoder().decode(buffer as ArrayBuffer);

const chunk = (seq: unknown, data_b64 = "aGk=", stream = "t1", id = "plug-a") => ({
  id,
  stream,
  kind: "chunk",
  seq,
  data_b64,
});

describe("createNetSync: streams", () => {
  it("decodes chunks to ArrayBuffers and passes end and error on to the plugin", async () => {
    const { streams, emit, name } = setup();
    await flush();
    expect(name()).toBe(EVENT_NET);
    emit(chunk(1));
    emit(chunk(2, "IQ=="));
    emit({ id: "plug-a", stream: "t1", kind: "end" });
    emit({ id: "plug-a", stream: "t2", kind: "error", code: "timeout", reason: "idle" });
    expect(streams.map(([id, d]) => [id, d.kind])).toEqual([
      ["plug-a", "chunk"],
      ["plug-a", "chunk"],
      ["plug-a", "end"],
      ["plug-a", "error"],
    ]);
    const first = streams[0][1];
    expect(first).toMatchObject({ stream: "t1", seq: 1 });
    expect(first.kind === "chunk" && first.data instanceof ArrayBuffer).toBe(true);
    expect(first.kind === "chunk" && text(first.data)).toBe("hi");
    expect(streams[3][1]).toEqual({ stream: "t2", kind: "error", code: "timeout", reason: "idle" });
  });

  it("ends a stream with a seq gap as network / protocol and sends one cancel", async () => {
    const { streams, cancelStream, emit } = setup();
    await flush();
    emit(chunk(1));
    emit(chunk(3));
    emit(chunk(4));
    emit(chunk(2));
    expect(streams.map(([, d]) => d)).toEqual([
      expect.objectContaining({ kind: "chunk", seq: 1 }),
      { stream: "t1", kind: "error", code: "network", reason: "protocol" },
    ]);
    expect(cancelStream.mock.calls).toEqual([["plug-a", "t1"]]);
    // Rust's own end of the cancelled stream is not passed on: the page already has its error.
    emit({ id: "plug-a", stream: "t1", kind: "error", code: "aborted", reason: "abort" });
    expect(streams).toHaveLength(2);
  });

  it("treats a first chunk past 1, a bad seq and bad base64 as gaps", async () => {
    const { streams, cancelStream, emit } = setup();
    await flush();
    emit(chunk(5, "aGk=", "t1"));
    emit(chunk("1", "aGk=", "t2"));
    emit(chunk(1, "not base64!", "t3"));
    expect(streams.map(([, d]) => d.kind)).toEqual(["error", "error", "error"]);
    expect(cancelStream.mock.calls).toEqual([
      ["plug-a", "t1"],
      ["plug-a", "t2"],
      ["plug-a", "t3"],
    ]);
  });

  it("keeps seq per plugin and stream", async () => {
    const { streams, cancelStream, emit } = setup();
    await flush();
    emit(chunk(1, "aGk=", "t1", "plug-a"));
    emit(chunk(1, "aGk=", "t2", "plug-a"));
    emit(chunk(1, "aGk=", "t1", "plug-b"));
    emit(chunk(2, "aGk=", "t1", "plug-a"));
    expect(streams.every(([, d]) => d.kind === "chunk")).toBe(true);
    expect(cancelStream).not.toHaveBeenCalled();
  });

  it("treats a repeated, a fractional and a 2^53 seq as gaps", async () => {
    const { streams, cancelStream, emit } = setup();
    await flush();
    emit(chunk(1, "aGk=", "t1"));
    emit(chunk(1, "aGk=", "t1"));
    emit(chunk(1, "aGk=", "t2"));
    emit(chunk(1.5, "aGk=", "t2"));
    emit(chunk(2 ** 53, "aGk=", "t3"));
    expect(streams.map(([, d]) => [d.stream, d.kind])).toEqual([
      ["t1", "chunk"],
      ["t1", "error"],
      ["t2", "chunk"],
      ["t2", "error"],
      ["t3", "error"],
    ]);
    expect(cancelStream.mock.calls.map((c) => c[1])).toEqual(["t1", "t2", "t3"]);
  });

  it("drops a late chunk after the stream's end or error instead of starting it again", async () => {
    const { streams, cancelStream, emit } = setup();
    await flush();
    emit(chunk(1, "aGk=", "t1"));
    emit({ id: "plug-a", stream: "t1", kind: "end" });
    emit(chunk(1, "aGk=", "t1"));
    emit(chunk(2, "aGk=", "t1"));
    emit({ id: "plug-a", stream: "t2", kind: "error", code: "aborted", reason: "abort" });
    emit(chunk(1, "aGk=", "t2"));
    emit({ id: "plug-a", stream: "t2", kind: "end" });
    expect(streams.map(([, d]) => [d.stream, d.kind])).toEqual([
      ["t1", "chunk"],
      ["t1", "end"],
      ["t2", "error"],
    ]);
    expect(cancelStream).not.toHaveBeenCalled();
  });

  it("keeps nothing for a chunk no frame took", async () => {
    const { streams, cancelStream, frame, emit } = setup();
    await flush();
    frame.live = false;
    emit(chunk(1, "aGk=", "t1"));
    frame.live = true;
    // Nothing was recorded, so the stream reads as unseen rather than one chunk in.
    emit(chunk(1, "aGk=", "t1"));
    expect(streams.map(([, d]) => d.kind)).toEqual(["chunk"]);
    expect(cancelStream).not.toHaveBeenCalled();
  });

  it("holds at most the cap, evicting the oldest, and undelivered streams take no room", async () => {
    const { streams, cancelStream, frame, emit } = setup();
    await flush();
    for (let i = 0; i < TRACKED_MAX; i += 1) emit(chunk(1, "aGk=", `t${i}`));
    frame.live = false;
    for (let i = 0; i < 100000; i += 1) emit(chunk(1, "aGk=", `x${i}`));
    frame.live = true;
    for (let i = 0; i < TRACKED_MAX; i += 1) emit(chunk(2, "aGk=", `t${i}`));
    expect(cancelStream).not.toHaveBeenCalled();

    // One more stream pushes the least recent out; its next chunk then reads as a gap.
    emit(chunk(1, "aGk=", "new"));
    emit(chunk(3, "aGk=", "t1"));
    expect(streams[streams.length - 1][1]).toMatchObject({ stream: "t1", kind: "chunk", seq: 3 });
    emit(chunk(3, "aGk=", "t0"));
    expect(cancelStream.mock.calls).toEqual([["plug-a", "t0"]]);
  });
});

describe("createNetSync: sockets", () => {
  it("passes text, decoded binary and close on to the plugin", async () => {
    const { sockets, emit } = setup();
    await flush();
    emit({ id: "plug-a", socket: "s1", kind: "text", data: "hello" });
    emit({ id: "plug-a", socket: "s1", kind: "binary", data_b64: "AQID" });
    emit({ id: "plug-a", socket: "s1", kind: "close", code: 1008, reason: "plisto_limit", clean: true });
    expect(sockets[0]).toEqual(["plug-a", { socket: "s1", kind: "text", data: "hello" }]);
    const binary = sockets[1][1];
    expect(binary.kind === "binary" && [...new Uint8Array(binary.data)]).toEqual([1, 2, 3]);
    expect(sockets[2]).toEqual([
      "plug-a",
      { socket: "s1", kind: "close", code: 1008, reason: "plisto_limit", clean: true },
    ]);
  });

  it("always delivers a close, defaulting code 1006 and reason empty, then drops later events", async () => {
    const { sockets, emit } = setup();
    await flush();
    emit({ id: "plug-a", socket: "s1", kind: "close", code: "1000", reason: 4 });
    emit({ id: "plug-a", socket: "s1", kind: "text", data: "late" });
    expect(sockets).toEqual([["plug-a", { socket: "s1", kind: "close", code: 1006, reason: "", clean: false }]]);
  });

  it("closes the socket for the page and tells Rust once when a binary message is not valid base64", async () => {
    const { sockets, closeSocket, emit } = setup();
    await flush();
    emit({ id: "plug-a", socket: "s1", kind: "binary", data_b64: "@@" });
    emit({ id: "plug-a", socket: "s1", kind: "binary", data_b64: "@@" });
    emit({ id: "plug-a", socket: "s1", kind: "close", code: 1000, reason: "", clean: true });
    expect(sockets).toEqual([["plug-a", { socket: "s1", kind: "close", code: 1006, reason: "", clean: false }]]);
    expect(closeSocket.mock.calls).toEqual([["plug-a", "s1"]]);
  });
});

describe("createNetSync: shape and lifetime", () => {
  it("drops a payload that is not a net event", async () => {
    const { streams, sockets, emit } = setup();
    await flush();
    for (const payload of [null, "x", [], { stream: "t1", kind: "end" }, { id: 1, stream: "t1", kind: "end" }, { id: "a" }]) {
      emit(payload);
    }
    emit({ id: "plug-a", socket: "s1", kind: "text", data: 5 });
    emit({ id: "plug-a", socket: "s1", kind: "ping" });
    expect(streams).toEqual([]);
    expect(sockets).toEqual([]);
  });

  it("stops posting and unlistens on teardown", async () => {
    const { streams, off, emit, stop } = setup();
    await flush();
    stop();
    expect(off).toHaveBeenCalledTimes(1);
    emit(chunk(1));
    expect(streams).toEqual([]);
  });

  it("unlistens at once when torn down before the subscription resolves", async () => {
    const { off, stop } = setup();
    stop();
    expect(off).not.toHaveBeenCalled();
    await flush();
    expect(off).toHaveBeenCalledTimes(1);
  });

  const netDeps = (listen: NetSyncDeps["listen"]): NetSyncDeps => ({
    listen,
    sendStream: vi.fn(),
    sendSocket: vi.fn(),
    cancelStream: vi.fn(),
    closeSocket: vi.fn(),
  });

  it("retries a rejected listen", async () => {
    const listen = vi
      .fn<NetSyncDeps["listen"]>()
      .mockRejectedValueOnce(new Error("not ready"))
      .mockResolvedValue(() => {});
    createNetSync(netDeps(listen));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(listen).toHaveBeenCalledTimes(2);
  });

  it("removes a listener that resolves after teardown", async () => {
    const off = vi.fn();
    let resolve: (fn: () => void) => void = () => {};
    const stop = createNetSync(netDeps(() => new Promise<() => void>((r) => (resolve = r))));
    stop();
    resolve(off);
    await flush();
    expect(off).toHaveBeenCalledTimes(1);
  });
});

describe("startNetSync", () => {
  const deps = () => ({
    listen: vi.fn(() => Promise.resolve(() => {})),
    sendStream: vi.fn(),
    sendSocket: vi.fn(),
    cancelStream: vi.fn(),
    closeSocket: vi.fn(),
  });

  it("starts nothing while plugins are held, in safe mode or before boot is read", () => {
    for (const boot of [
      null,
      { runtime: "held", unclean: true, safe_flag: false } as const,
      { runtime: "safe", unclean: false, safe_flag: true } as const,
    ]) {
      const factory = vi.fn(deps);
      expect(startNetSync(pluginRuntimeReady(boot), factory)).toBeUndefined();
      expect(factory).not.toHaveBeenCalled();
    }
  });

  it("listens once the runtime runs", () => {
    const made = deps();
    const stop = startNetSync(pluginRuntimeReady({ runtime: "running", unclean: false, safe_flag: false }), () => made);
    expect(made.listen).toHaveBeenCalledWith(EVENT_NET, expect.any(Function));
    expect(typeof stop).toBe("function");
    stop?.();
  });
});
