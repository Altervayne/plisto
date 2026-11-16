/*
 * Tests for the stream half of plisto-sdk.js: the `plisto.stream` helpers, `plisto.onStream`, and
 * `pushFrom`'s back-pressure from the host's `room` answers and events. A fake host answers each posted call
 * from a script, so no browser runs. Run: node --test plugin-kit/tests/stream-sdk.mjs. The file name avoids
 * the .test suffix so the app's Vitest run does not collect it.
 */

// -- Library Imports --
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

// -- SDK load --
const posted = [];
let listener = null;
// Set by a test: gets each posted call and returns the answer, or undefined to leave it unanswered.
let script = null;
const parent = {
  postMessage(msg) {
    posted.push(msg);
    if (msg.type !== "plisto:call" || !script) return;
    const answer = script(msg.method, JSON.parse(msg.args), msg);
    if (answer !== undefined) queueMicrotask(() => reply(msg.id, answer));
  },
};
globalThis.window = {
  parent,
  addEventListener(type, fn) {
    if (type === "message") listener = fn;
  },
};
globalThis.document = { documentElement: { dataset: {} } };
const sdk = new URL("../sdk/plisto-sdk.js", import.meta.url);
vm.runInThisContext(readFileSync(sdk, "utf8"), { filename: "plisto-sdk.js" });
const plisto = globalThis.window.plisto;

/** Delivers a host message to the SDK as the bridge would. */
function host(data) {
  listener({ source: parent, data: { plisto: 1, ...data } });
}

/** Answers a call: `{ ok, result }` or `{ error }`. */
function reply(id, answer) {
  if (answer.error) host({ type: "plisto:result", id, ok: false, error: answer.error });
  else host({ type: "plisto:result", id, ok: true, result: answer.result ?? {} });
}

function event(data) {
  host({ type: "plisto:plugin-event", topic: "stream", data });
}

const calls = (method) => posted.filter((m) => m.type === "plisto:call" && m.method === method);
const args = (call) => JSON.parse(call.args);
// A call's own timeout is 10 s by default; the delays under test are the others.
const notCallTimer = (ms) => ms !== 10_000;
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** A ReadableStream that hands out `chunks`, then closes; with `open` it stays open after them. */
function source(chunks, open = false) {
  let i = 0;
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else if (!open) controller.close();
      else return new Promise(() => {});
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, cancelled: () => cancelled };
}

const busy = { error: { code: "busy", message: "full" } };

test.beforeEach(() => {
  posted.length = 0;
  script = null;
});

// -- Calls --

test("each helper sends its method with the item", async () => {
  script = () => ({ result: {} });
  await plisto.stream.end(-3);
  await plisto.stream.pause(-3);
  await plisto.stream.resume(-3);
  await plisto.stream.stop(-3);
  await plisto.stream.state();
  const sent = posted.filter((m) => m.type === "plisto:call").map((m) => [m.method, args(m)]);
  assert.deepEqual(sent, [
    ["stream.end", { item: -3 }],
    ["stream.pause", { item: -3 }],
    ["stream.resume", { item: -3 }],
    ["stream.stop", { item: -3 }],
    ["stream.state", {}],
  ]);
});

test("play sends its arguments as they are and resolves the item", async () => {
  script = () => ({ result: { item: -7, state: "connecting" } });
  const play = { source: { url: "https://radio.example.com/live" }, title: "Radio", skip: { next: true } };
  assert.deepEqual(await plisto.stream.play(play), { item: -7, state: "connecting" });
  assert.deepEqual(args(calls("stream.play")[0]), play);
});

test("update puts the item beside the fields and leaves the caller's object alone", async () => {
  script = () => ({ result: {} });
  const fields = { now: "Song - Band", artist: null };
  await plisto.stream.update(-7, fields);
  assert.deepEqual(args(calls("stream.update")[0]), { now: "Song - Band", artist: null, item: -7 });
  assert.deepEqual(fields, { now: "Song - Band", artist: null });
});

test("push sends base64 of the bytes it was given, whatever view holds them", async () => {
  script = () => ({ result: { buffered_ms: 10, room: 900 } });
  const bytes = Uint8Array.from([1, 2, 3, 250]);
  const result = await plisto.stream.push(-7, bytes);
  assert.deepEqual(result, { buffered_ms: 10, room: 900 });
  const b64 = Buffer.from(bytes).toString("base64");
  await plisto.stream.push(-7, bytes.buffer);
  await plisto.stream.push(-7, new DataView(bytes.buffer, 1, 2));
  const sent = calls("stream.push").map((c) => args(c).data_b64);
  assert.deepEqual(sent, [b64, b64, Buffer.from([2, 3]).toString("base64")]);
});

test("push of something that is not bytes rejects invalid_args without posting", async () => {
  await assert.rejects(plisto.stream.push(-7, "text"), (e) => e.code === "invalid_args");
  assert.equal(calls("stream.push").length, 0);
});

// -- onStream --

test("onStream hears the stream topic only, and unsubscribes", () => {
  const seen = [];
  const off = plisto.onStream((e) => seen.push(e));
  event({ item: -1, kind: "state", state: "playing" });
  host({ type: "plisto:plugin-event", topic: "levels", data: { peak_db: [-6] } });
  off();
  event({ item: -1, kind: "ended", reason: "user", detail: null });
  assert.deepEqual(seen, [{ item: -1, kind: "state", state: "playing" }]);
});

test("onStream and onPluginEvent('stream') share one stream of events", () => {
  const a = [];
  const b = [];
  const offA = plisto.onStream((e) => a.push(e));
  const offB = plisto.onPluginEvent("stream", (e) => b.push(e));
  event({ item: -1, kind: "skip", direction: "next" });
  offA();
  offB();
  assert.deepEqual(a, b);
  assert.equal(a.length, 1);
});

test("a throwing onStream listener does not stop the others", () => {
  const seen = [];
  const offThrow = plisto.onStream(() => {
    throw new Error("boom");
  });
  const off = plisto.onStream((e) => seen.push(e.kind));
  event({ item: -1, kind: "room", room: 5 });
  offThrow();
  off();
  assert.deepEqual(seen, ["room"]);
});

test("onStream without a function throws TypeError", () => {
  assert.throws(() => plisto.onStream("x"), TypeError);
  assert.throws(() => plisto.onStream(), TypeError);
});

// -- pushFrom --

test("pushFrom cuts a chunk into slices of at most 64 KiB and ends the item", async () => {
  script = (method) =>
    method === "stream.push" ? { result: { buffered_ms: 0, room: 1_000_000 } } : { result: {} };
  const chunk = new Uint8Array(150_000).fill(7);
  const { stream } = source([chunk, new Uint8Array(10)]);
  const done = await plisto.stream.pushFrom(-5, stream);
  assert.deepEqual(done, { bytes: 150_010 });
  const sizes = calls("stream.push").map((c) => Buffer.from(args(c).data_b64, "base64").length);
  assert.deepEqual(sizes, [65_536, 65_536, 18_928, 10]);
  assert.deepEqual(posted.filter((m) => m.type === "plisto:call").at(-1).method, "stream.end");
  assert.deepEqual(args(calls("stream.end")[0]), { item: -5 });
});

test("pushFrom with end false leaves the item open", async () => {
  script = () => ({ result: { buffered_ms: 0, room: 1_000_000 } });
  const { stream } = source([new Uint8Array(4)]);
  await plisto.stream.pushFrom(-5, stream, { end: false });
  assert.equal(calls("stream.end").length, 0);
});

test("pushFrom skips empty chunks and rejects a chunk that is not bytes", async () => {
  script = () => ({ result: { buffered_ms: 0, room: 1_000_000 } });
  const ok = source([new Uint8Array(0), new Uint8Array(3)]);
  assert.deepEqual(await plisto.stream.pushFrom(-5, ok.stream, { end: false }), { bytes: 3 });
  assert.equal(calls("stream.push").length, 1);
  const bad = source(["text"], true);
  await assert.rejects(plisto.stream.pushFrom(-5, bad.stream), (e) => e.code === "invalid_args");
  await tick();
  assert.equal(bad.cancelled(), true);
  await assert.rejects(plisto.stream.pushFrom(-5, {}), (e) => e.code === "invalid_args");
});

test("pushFrom shrinks a slice to the room the last answer reported", async () => {
  const rooms = [10_000, 1_000_000, 1_000_000];
  script = () => ({ result: { buffered_ms: 0, room: rooms.shift() } });
  const { stream } = source([new Uint8Array(30_000), new Uint8Array(25_000)]);
  await plisto.stream.pushFrom(-5, stream, { end: false });
  const sizes = calls("stream.push").map((c) => Buffer.from(args(c).data_b64, "base64").length);
  // The first slice has no room figure yet; the second takes the 10,000 the host then reported.
  assert.deepEqual(sizes, [30_000, 10_000, 15_000]);
});

test("a room under 4 KiB does not shrink the slice: the host's refusal arms the room event", async () => {
  const rooms = [100, 1_000_000];
  script = () => ({ result: { buffered_ms: 0, room: rooms.shift() } });
  const { stream } = source([new Uint8Array(5_000), new Uint8Array(5_000)]);
  await plisto.stream.pushFrom(-5, stream, { end: false });
  const sizes = calls("stream.push").map((c) => Buffer.from(args(c).data_b64, "base64").length);
  assert.deepEqual(sizes, [5_000, 5_000]);
});

test("pushFrom waits for the room event after busy, then goes on", async () => {
  let pushes = 0;
  const received = [];
  script = (method, a) => {
    if (method !== "stream.push") return { result: {} };
    pushes += 1;
    if (pushes === 1) return busy;
    received.push(...Buffer.from(a.data_b64, "base64"));
    return { result: { buffered_ms: 0, room: 500_000 } };
  };
  const sent = Uint8Array.from({ length: 1_000 }, (_, i) => i % 251);
  const { stream } = source([sent]);
  const done = plisto.stream.pushFrom(-5, stream);
  await tick();
  await tick();
  assert.equal(calls("stream.push").length, 1, "waits instead of retrying at once");
  // Another item's room event and an event of another kind do not wake it.
  event({ item: -9, kind: "room", room: 600_000 });
  event({ item: -5, kind: "state", state: "playing" });
  await tick();
  assert.equal(calls("stream.push").length, 1);
  event({ item: -5, kind: "room", room: 600_000 });
  assert.deepEqual(await done, { bytes: 1_000 });
  assert.equal(calls("stream.push").length, 2);
  // The refused push wrote nothing; the retry carries every byte once, in order.
  assert.deepEqual(received, [...sent]);
});

test("a lost room event is covered by a retry timer", async () => {
  let pushes = 0;
  script = (method) => {
    if (method !== "stream.push") return { result: {} };
    pushes += 1;
    return pushes === 1 ? busy : { result: { buffered_ms: 0, room: 500_000 } };
  };
  const real = globalThis.setTimeout;
  const delays = [];
  globalThis.setTimeout = (fn, ms) => {
    delays.push(ms);
    return real(fn, 0);
  };
  try {
    const { stream } = source([new Uint8Array(100)]);
    assert.deepEqual(await plisto.stream.pushFrom(-5, stream), { bytes: 100 });
  } finally {
    globalThis.setTimeout = real;
  }
  assert.deepEqual(delays.filter(notCallTimer), [2000]);
});

test("pushFrom waits out rate_limited for retryAfterMs", async () => {
  let pushes = 0;
  script = (method) => {
    if (method !== "stream.push") return { result: {} };
    pushes += 1;
    if (pushes === 1) return { error: { code: "rate_limited", message: "slow", retry_after_ms: 40 } };
    return { result: { buffered_ms: 0, room: 500_000 } };
  };
  const real = globalThis.setTimeout;
  const delays = [];
  globalThis.setTimeout = (fn, ms) => {
    delays.push(ms);
    return real(fn, 0);
  };
  try {
    const { stream } = source([new Uint8Array(100)]);
    assert.deepEqual(await plisto.stream.pushFrom(-5, stream), { bytes: 100 });
  } finally {
    globalThis.setTimeout = real;
  }
  assert.deepEqual(delays.filter(notCallTimer), [40]);
  assert.equal(calls("stream.push").length, 2);
});

test("an item that ends while pushFrom waits rejects not_found and cancels the stream", async () => {
  script = (method) => (method === "stream.push" ? busy : { result: {} });
  const { stream, cancelled } = source([new Uint8Array(1_000)], true);
  const done = plisto.stream.pushFrom(-5, stream);
  await tick();
  event({ item: -5, kind: "ended", reason: "user", detail: null });
  await assert.rejects(done, (e) => e.code === "not_found" && /user/.test(e.message));
  await tick();
  assert.equal(cancelled(), true);
  assert.equal(calls("stream.end").length, 0);
});

test("an item that ends while the source is idle stops pushFrom at once", async () => {
  script = () => ({ result: { buffered_ms: 0, room: 500_000 } });
  // A source that never gives a chunk until it is cancelled.
  const idle = new ReadableStream({ pull: () => new Promise(() => {}) });
  const done = plisto.stream.pushFrom(-5, idle);
  await tick();
  event({ item: -5, kind: "ended", reason: "stopped", detail: null });
  await assert.rejects(done, (e) => e.code === "not_found");
});

test("a push error that is not busy or rate_limited ends pushFrom with it", async () => {
  script = (method) =>
    method === "stream.push" ? { error: { code: "not_found", message: "gone" } } : { result: {} };
  const { stream, cancelled } = source([new Uint8Array(10), new Uint8Array(10)], true);
  await assert.rejects(plisto.stream.pushFrom(-5, stream), (e) => e.code === "not_found");
  await tick();
  assert.equal(cancelled(), true);
  assert.equal(calls("stream.push").length, 1);
});

test("pushFrom stops listening once it is done", async () => {
  script = () => ({ result: { buffered_ms: 0, room: 500_000 } });
  // Count the listeners pushFrom adds and the ones it removes.
  const real = plisto.onPluginEvent;
  let live = 0;
  plisto.onPluginEvent = (topic, callback) => {
    live += 1;
    const off = real(topic, callback);
    return () => {
      live -= 1;
      off();
    };
  };
  try {
    const ok = source([new Uint8Array(4)]);
    await plisto.stream.pushFrom(-5, ok.stream);
    assert.equal(live, 0, "a finished push leaves no listener");
    script = (method) => (method === "stream.push" ? { error: { code: "not_found", message: "gone" } } : {});
    const bad = source([new Uint8Array(4)], true);
    await assert.rejects(plisto.stream.pushFrom(-5, bad.stream), (e) => e.code === "not_found");
    assert.equal(live, 0, "a failed push leaves no listener");
  } finally {
    plisto.onPluginEvent = real;
  }
});
