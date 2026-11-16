/*
 * Tests for the network half of plisto-sdk.js: the event-stream parser, the streamed body and its
 * acknowledgements, and fetch, streams, event sources and sockets driven by posted messages. No request
 * leaves the process. Run: node --test plugin-kit/tests/net-sdk.mjs. The file name avoids the .test suffix
 * so the app's Vitest run does not collect it.
 */

// -- Library Imports --
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

// -- SDK load --
const posted = [];
let listener = null;
const parent = {
  postMessage(msg, _origin, transfer) {
    posted.push({ msg, transfer });
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
const { createEventParser, createStreamBody, toBase64 } = plisto.net.internals;

/** Delivers a host message to the SDK as the bridge would. */
function host(data) {
  listener({ source: parent, data: { plisto: 1, ...data } });
}

// The SDK's timers (call timeouts, acknowledgement retries) must not keep the process alive when a test
// leaves a socket open, so they are unref'd. The test's own waits use the real timer.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (...args) => {
  const handle = realSetTimeout(...args);
  if (handle && typeof handle.unref === "function") handle.unref();
  return handle;
};
const sleep = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms));

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Waits for the next call to `method`, answers it with `result` (or an error) and returns what was posted. */
async function answer(method, result, error) {
  let found;
  for (let i = 0; i < 400 && !found; i++) {
    found = posted.find((p) => p.msg.type === "plisto:call" && p.msg.method === method && !p.answered);
    if (!found) await sleep(10);
  }
  assert.ok(found, "no call to " + method);
  found.answered = true;
  if (error) host({ type: "plisto:result", id: found.msg.id, ok: false, error });
  else host({ type: "plisto:result", id: found.msg.id, ok: true, result });
  return found;
}

const bytes = (text) => new TextEncoder().encode(text);
const buf = (text) => bytes(text).buffer;

function parse(chunks, lastEventId) {
  const events = [];
  const extra = { retry: [], id: [] };
  const parser = createEventParser(
    {
      onEvent: (e) => events.push(e),
      onRetry: (ms) => extra.retry.push(ms),
      onId: (id) => extra.id.push(id),
    },
    lastEventId,
  );
  for (const c of chunks) parser.push(c);
  return { events, ...extra };
}

// -- Event-stream parser --

test("parser: a plain message", () => {
  const { events } = parse(["data: hello\n\n"]);
  assert.deepEqual(events, [{ type: "message", data: "hello", lastEventId: "" }]);
});

test("parser: several data lines join with a line feed", () => {
  const { events } = parse(["data: a\ndata:b\ndata\n\n"]);
  assert.equal(events[0].data, "a\nb\n");
});

test("parser: event type applies to one event only", () => {
  const { events } = parse(["event: tick\ndata: 1\n\ndata: 2\n\n"]);
  assert.deepEqual(
    events.map((e) => e.type),
    ["tick", "message"],
  );
});

test("parser: comments, unknown fields and empty events are ignored", () => {
  const { events } = parse([": keep-alive\nfoo: bar\n\nevent: x\n\ndata: y\n\n"]);
  assert.deepEqual(events, [{ type: "message", data: "y", lastEventId: "" }]);
});

test("parser: CRLF, CR and LF line ends, split anywhere", () => {
  const text = "data: a\r\n\r\ndata: b\r\rdata: c\n\n";
  for (let cut = 0; cut <= text.length; cut++) {
    const { events } = parse([text.slice(0, cut), text.slice(cut)]);
    assert.deepEqual(
      events.map((e) => e.data),
      ["a", "b", "c"],
      "cut at " + cut,
    );
  }
});

test("parser: a leading byte order mark is dropped once", () => {
  const { events } = parse(["\uFEFFdata: a\n\n", "\uFEFFdata: b\n\n"]);
  assert.equal(events.length, 1);
  assert.equal(events[0].data, "a");
});

test("parser: id persists across events; an id with NUL is ignored", () => {
  const { events, id } = parse(["id: 7\ndata: a\n\ndata: b\n\nid: x\u0000y\ndata: c\n\n"]);
  assert.deepEqual(
    events.map((e) => e.lastEventId),
    ["7", "7", "7"],
  );
  assert.deepEqual(id, ["7"]);
});

test("parser: the starting id seeds events", () => {
  const { events } = parse(["data: a\n\n"], "42");
  assert.equal(events[0].lastEventId, "42");
});

test("parser: retry takes digits only", () => {
  const { retry } = parse(["retry: 2500\nretry: 1e3\nretry: -5\nretry:\n"]);
  assert.deepEqual(retry, [2500]);
});

test("parser: an event cut off by the end is never dispatched", () => {
  const { events } = parse(["data: a\n\ndata: partial"]);
  assert.equal(events.length, 1);
});

// -- Streamed body --

function makeBody() {
  const log = { acks: [], cancels: 0, done: 0, timers: [] };
  const core = createStreamBody({
    ReadableStream,
    ack: (total) => log.acks.push(total),
    cancel: () => log.cancels++,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      log.timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
    onDone: () => log.done++,
  });
  return { core, log };
}

test("stream body: chunks read in order, then end", async () => {
  const { core } = makeBody();
  core.chunk(1, bytes("ab"));
  core.chunk(2, bytes("cd"));
  core.end();
  const reader = core.body.getReader();
  const out = [];
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    out.push(new TextDecoder().decode(r.value));
  }
  assert.deepEqual(out, ["ab", "cd"]);
});

test("stream body: small reads are acknowledged after the delay, big ones at once", async () => {
  const { core, log } = makeBody();
  const reader = core.body.getReader();
  core.chunk(1, bytes("abc"));
  await reader.read();
  await tick();
  assert.deepEqual(log.acks, []);
  const live = log.timers.filter((t) => !t.cleared);
  assert.equal(live.length, 1);
  assert.equal(live[0].ms, 250);
  live[0].fn();
  assert.deepEqual(log.acks, [3]);

  core.chunk(2, new Uint8Array(262144));
  await reader.read();
  await tick();
  assert.deepEqual(log.acks, [3, 3 + 262144]);
});

test("stream body: nothing read, nothing acknowledged", async () => {
  const { core, log } = makeBody();
  core.chunk(1, new Uint8Array(300000));
  await tick();
  assert.deepEqual(log.acks, []);
});

test("stream body: a gap errors the stream and cancels the host side", async () => {
  const { core, log } = makeBody();
  core.chunk(1, bytes("a"));
  core.chunk(3, bytes("c"));
  assert.equal(log.cancels, 1);
  const reader = core.body.getReader();
  await assert.rejects(
    async () => {
      for (;;) if ((await reader.read()).done) return;
    },
    (e) => e.code === "network" && e.reason === "protocol",
  );
});

test("stream body: cancelling tells the host once", async () => {
  const { core, log } = makeBody();
  await core.body.cancel();
  core.chunk(1, bytes("a"));
  core.end();
  assert.equal(log.cancels, 1);
  assert.equal(log.done, 1);
});

test("stream body: a host error reaches the reader", async () => {
  const { core } = makeBody();
  core.fail(new plisto.PlistoError("timeout", "idle", undefined, "idle"));
  await assert.rejects(core.body.getReader().read(), (e) => e.code === "timeout" && e.reason === "idle");
});

test("base64 matches Buffer for a large array", () => {
  const data = new Uint8Array(100000).map((_, i) => i % 251);
  assert.equal(toBase64(data), Buffer.from(data).toString("base64"));
});

// -- fetch --

test("fetch buffered: json body, content-type, transfer, call timeout", async () => {
  const pending = plisto.net.fetch("https://api.example.com/items", { method: "post", json: { a: 1 } });
  const call = await answer("net.fetch", {
    status: 201,
    url: "https://api.example.com/items",
    redirected: false,
    headers: [
      ["content-type", "application/json"],
      ["x-n", "1"],
    ],
    set_cookies: ["s=1"],
    body: buf('{"ok":true}'),
  });
  const args = JSON.parse(call.msg.args);
  assert.equal(args.method, "POST");
  assert.equal(args.headers["content-type"], "application/json");
  assert.equal(new TextDecoder().decode(call.msg.body), '{"a":1}');
  assert.deepEqual(call.transfer, [call.msg.body]);
  const res = await pending;
  assert.equal(res.status, 201);
  assert.equal(res.ok, true);
  assert.equal(res.headers.get("X-N"), "1");
  assert.deepEqual(res.setCookies, ["s=1"]);
  assert.equal(res.bodyUsed, false);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(res.bodyUsed, true);
  await assert.rejects(res.text(), TypeError);
});

test("fetch buffered: an author content-type is kept and the author's buffer is copied", async () => {
  const mine = bytes("xyz");
  const pending = plisto.net.fetch("https://api.example.com/up", {
    method: "PUT",
    headers: { "Content-Type": "text/csv" },
    body: mine,
  });
  const call = await answer("net.fetch", {
    status: 204,
    url: "https://api.example.com/up",
    redirected: false,
    headers: [],
    set_cookies: [],
    body: new ArrayBuffer(0),
  });
  assert.equal(JSON.parse(call.msg.args).headers["content-type"], "text/csv");
  assert.notEqual(call.msg.body, mine.buffer);
  assert.equal(mine.byteLength, 3);
  const res = await pending;
  assert.equal((await res.arrayBuffer()).byteLength, 0);
});

test("fetch: bad input rejects invalid_args before anything is sent", async () => {
  const before = posted.length;
  await assert.rejects(
    plisto.net.fetch("https://api.example.com", { body: "a", json: 1 }),
    (e) => e.code === "invalid_args",
  );
  await assert.rejects(plisto.net.fetch("https://api.example.com", { body: 5 }), (e) => e.code === "invalid_args");
  await assert.rejects(
    plisto.net.fetch("https://api.example.com", { headers: { "bad name": "x" } }),
    (e) => e.code === "invalid_args",
  );
  assert.equal(posted.length, before);
});

test("fetch: a host error rejects with its code and reason", async () => {
  const pending = plisto.net.fetch("https://other.example.com");
  await answer("net.fetch", null, { code: "denied", message: "no", reason: "origin_not_listed" });
  await assert.rejects(pending, (e) => e.code === "denied" && e.reason === "origin_not_listed");
});

test("fetch: an AbortSignal sends net.abort with the call's key", async () => {
  const ac = new AbortController();
  const outcome = assert.rejects(
    plisto.net.fetch("https://api.example.com/slow", { signal: ac.signal }),
    (e) => e.code === "aborted",
  );
  await tick();
  const call = posted.find((p) => p.msg.method === "net.fetch" && !p.answered);
  const key = JSON.parse(call.msg.args).abort_key;
  assert.match(key, /^[!-~]{1,64}$/);
  ac.abort();
  const abort = await answer("net.abort", { aborted: 1 });
  assert.equal(JSON.parse(abort.msg.args).abort_key, key);
  await answer("net.fetch", null, { code: "aborted", reason: "abort" });
  await outcome;
});

test("fetch: an already aborted signal never reaches the host", async () => {
  const before = posted.length;
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(plisto.net.fetch("https://api.example.com", { signal: ac.signal }), (e) => e.code === "aborted");
  assert.equal(posted.length, before);
});

test("fetch streamed: events that beat the result are replayed", async () => {
  const pending = plisto.net.fetch("https://api.example.com/live", { stream: true, idleMs: 5000 });
  const call = await answer("net.fetch", {
    status: 200,
    url: "https://api.example.com/live",
    redirected: false,
    headers: [["content-type", "text/plain"]],
    set_cookies: [],
    stream: "t1",
  });
  assert.equal(JSON.parse(call.msg.args).stream, true);
  host({ type: "plisto:stream", stream: "t1", kind: "chunk", seq: 1, data: buf("hel") });
  host({ type: "plisto:stream", stream: "t1", kind: "chunk", seq: 2, data: buf("lo") });
  host({ type: "plisto:stream", stream: "t1", kind: "end" });
  const res = await pending;
  assert.equal(await res.text(), "hello");
});

test("fetch streamed: a stream-less answer (204) has an empty closed body", async () => {
  const pending = plisto.net.fetch("https://api.example.com/none", { stream: true });
  await answer("net.fetch", {
    status: 204,
    url: "https://api.example.com/none",
    redirected: false,
    headers: [],
    set_cookies: [],
    stream: null,
  });
  const res = await pending;
  assert.equal((await res.bytes()).byteLength, 0);
});

test("fetch streamed: cancelling the body sends net.stream.cancel", async () => {
  const pending = plisto.net.fetch("https://api.example.com/live2", { stream: true });
  await answer("net.fetch", {
    status: 200,
    url: "https://api.example.com/live2",
    redirected: false,
    headers: [],
    set_cookies: [],
    stream: "t2",
  });
  const res = await pending;
  await res.body.cancel();
  const cancel = await answer("net.stream.cancel", {});
  assert.equal(JSON.parse(cancel.msg.args).stream, "t2");
  host({ type: "plisto:stream", stream: "t2", kind: "error", code: "aborted", reason: "abort" });
});

// -- Server-Sent Events --

test("eventSource: opens, parses, reports a retry and closes", async () => {
  const seen = [];
  const source = plisto.net.eventSource("https://api.example.com/events");
  source.onopen = () => seen.push("open");
  source.onmessage = (e) => seen.push("message:" + e.data + ":" + e.lastEventId);
  source.addEventListener("tick", (e) => seen.push("tick:" + e.data));
  const call = await answer("net.fetch", {
    status: 200,
    url: "https://api.example.com/events",
    redirected: false,
    headers: [["content-type", "text/event-stream; charset=utf-8"]],
    set_cookies: [],
    stream: "t3",
  });
  const args = JSON.parse(call.msg.args);
  assert.equal(args.stream, true);
  assert.equal(args.headers.accept, "text/event-stream");
  assert.ok(args.abort_key);
  await tick();
  host({ type: "plisto:stream", stream: "t3", kind: "chunk", seq: 1, data: buf("id: 5\ndata: hi\n\nevent: tick\ndata: t\n\n") });
  await tick();
  await tick();
  assert.deepEqual(seen, ["open", "message:hi:5", "tick:t"]);
  assert.equal(source.readyState, 1);
  source.close();
  assert.equal(source.readyState, 2);
  const abort = await answer("net.abort", { aborted: 1 });
  assert.equal(JSON.parse(abort.msg.args).abort_key, args.abort_key);
  host({ type: "plisto:stream", stream: "t3", kind: "error", code: "aborted", reason: "abort" });
});

test("eventSource: a reply that is not an event stream errors and closes", async () => {
  const source = plisto.net.eventSource("https://api.example.com/html");
  let errors = 0;
  source.onerror = () => errors++;
  await answer("net.fetch", {
    status: 200,
    url: "https://api.example.com/html",
    redirected: false,
    headers: [["content-type", "text/html"]],
    set_cookies: [],
    stream: null,
  });
  await tick();
  await tick();
  assert.equal(errors, 1);
  assert.equal(source.readyState, 2);
});

test("eventSource: a denied error closes without a retry", async () => {
  const source = plisto.net.eventSource("https://nope.example.com/events");
  let error = null;
  source.onerror = (e) => (error = e.error);
  await answer("net.fetch", null, { code: "denied", reason: "origin_not_listed" });
  await tick();
  assert.equal(error.code, "denied");
  assert.equal(source.readyState, 2);
});

// -- Sockets --

test("socket: opens, queues early messages until a handler is set, sends text and binary, closes", async () => {
  const pending = plisto.net.socket("wss://api.example.com/ws", { protocols: ["v1"] });
  const open = await answer("net.socket.open", { socket: "s1", protocol: "v1" });
  assert.deepEqual(JSON.parse(open.msg.args).protocols, ["v1"]);
  host({ type: "plisto:socket", socket: "s1", kind: "text", data: "early" });
  const socket = await pending;
  assert.equal(socket.id, "s1");
  assert.equal(socket.protocol, "v1");
  host({ type: "plisto:socket", socket: "s1", kind: "binary", data: buf("ab") });
  host({ type: "plisto:socket", socket: "s1", kind: "close", code: 1000, reason: "bye", clean: true });

  const got = [];
  socket.onmessage = (e) => got.push(typeof e.data === "string" ? e.data : "bin:" + e.data.byteLength);
  socket.onclose = (e) => got.push("close:" + e.code + ":" + e.reason + ":" + e.wasClean);
  assert.deepEqual(got, ["early", "bin:2", "close:1000:bye:true"]);

  const sentText = socket.send("hi");
  const text = await answer("net.socket.send", {});
  await sentText;
  assert.deepEqual(JSON.parse(text.msg.args), { socket: "s1", text: "hi" });
  const sentBin = socket.send(new Uint8Array([1, 2, 3]));
  const bin = await answer("net.socket.send", {});
  await sentBin;
  assert.equal(JSON.parse(bin.msg.args).data_b64, "AQID");
  await assert.rejects(socket.send(5), (e) => e.code === "invalid_args");

  const closed = socket.close(1000, "done");
  const close = await answer("net.socket.close", {});
  await closed;
  assert.deepEqual(JSON.parse(close.msg.args), { socket: "s1", code: 1000, reason: "done" });
});

test("sdk version is 1.5.0", () => {
  assert.equal(plisto.sdkVersion, "1.5.0");
});

// -- Review fixes --

const OPEN_SSE = (url, stream) => ({
  status: 200,
  url,
  redirected: false,
  headers: [["content-type", "text/event-stream"]],
  set_cookies: [],
  stream,
});

test("stream body: a rate-limited acknowledgement is sent again", async () => {
  const acks = [];
  const timers = [];
  let first = true;
  const core = createStreamBody({
    ReadableStream,
    ack: (total) => {
      acks.push(total);
      if (!first) return undefined;
      first = false;
      return Promise.reject(new plisto.PlistoError("rate_limited", "slow", 700));
    },
    cancel: () => {},
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
    onDone: () => {},
  });
  const reader = core.body.getReader();
  core.chunk(1, new Uint8Array(262144));
  await reader.read();
  await tick();
  await tick();
  assert.deepEqual(acks, [262144]);
  const retry = timers.filter((t) => !t.cleared).pop();
  assert.equal(retry.ms, 700);
  retry.fn();
  assert.deepEqual(acks, [262144, 262144]);
});

test("stream body: a refusal retrying cannot fix is not retried", async () => {
  const timers = [];
  const core = createStreamBody({
    ReadableStream,
    ack: () => Promise.reject(new plisto.PlistoError("invalid_args")),
    cancel: () => {},
    setTimer: (fn, ms) => timers.push({ fn, ms }),
    clearTimer: () => {},
    onDone: () => {},
  });
  const reader = core.body.getReader();
  core.chunk(1, new Uint8Array(262144));
  await reader.read();
  await tick();
  await tick();
  assert.equal(timers.length, 0);
});

test("parser: a line or event over the cap reports once and stops", () => {
  let overflows = 0;
  const events = [];
  const parser = createEventParser({ onEvent: (e) => events.push(e), onOverflow: () => overflows++ });
  parser.push("x".repeat(1048576 + 1));
  parser.push("data: late\n\n");
  assert.equal(overflows, 1);
  assert.equal(events.length, 0);

  overflows = 0;
  const second = createEventParser({ onEvent: () => {}, onOverflow: () => overflows++ });
  const row = "data: " + "y".repeat(65530) + "\n";
  for (let i = 0; i < 20; i++) second.push(row);
  assert.equal(overflows, 1);
});

test("fetch streamed: cancelling frees the registry and later host events are ignored", async () => {
  const before = plisto.net.internals.openStreams();
  const pending = plisto.net.fetch("https://api.example.com/c", { stream: true });
  await answer("net.fetch", { ...OPEN_SSE("https://api.example.com/c", "t20"), headers: [] });
  const res = await pending;
  assert.equal(plisto.net.internals.openStreams(), before + 1);
  await res.body.cancel();
  assert.equal(plisto.net.internals.openStreams(), before);
  await answer("net.stream.cancel", {});
  host({ type: "plisto:stream", stream: "t20", kind: "chunk", seq: 1, data: buf("late") });
  host({ type: "plisto:stream", stream: "t20", kind: "error", code: "aborted", reason: "abort" });
  assert.equal(plisto.net.internals.openStreams(), before);
});

test("fetch streamed: a sequence gap frees the registry too", async () => {
  const before = plisto.net.internals.openStreams();
  const pending = plisto.net.fetch("https://api.example.com/g", { stream: true });
  await answer("net.fetch", { ...OPEN_SSE("https://api.example.com/g", "t21"), headers: [] });
  const res = await pending;
  const outcome = assert.rejects(res.text(), (e) => e.reason === "protocol");
  host({ type: "plisto:stream", stream: "t21", kind: "chunk", seq: 2, data: buf("x") });
  await outcome;
  assert.equal(plisto.net.internals.openStreams(), before);
  await answer("net.stream.cancel", {});
});

test("fetch streamed: aborting after the stream opened sends net.abort and errors the body", async () => {
  const ac = new AbortController();
  const pending = plisto.net.fetch("https://api.example.com/a", { stream: true, signal: ac.signal });
  const call = await answer("net.fetch", { ...OPEN_SSE("https://api.example.com/a", "t22"), headers: [] });
  const res = await pending;
  const outcome = assert.rejects(res.text(), (e) => e.code === "aborted");
  ac.abort();
  const abort = await answer("net.abort", { aborted: 1 });
  assert.equal(JSON.parse(abort.msg.args).abort_key, JSON.parse(call.msg.args).abort_key);
  host({ type: "plisto:stream", stream: "t22", kind: "error", code: "aborted", reason: "abort" });
  await outcome;
});

test("fetch: the call waits the timeout plus 5 s", async () => {
  const delays = [];
  const real = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => {
    delays.push(ms);
    return real(fn, ms, ...rest);
  };
  try {
    const a = plisto.net.fetch("https://api.example.com/t1");
    const b = plisto.net.fetch("https://api.example.com/t2", { timeoutMs: 2000 });
    const empty = { status: 204, url: "u", redirected: false, headers: [], set_cookies: [], body: new ArrayBuffer(0) };
    await answer("net.fetch", empty);
    await answer("net.fetch", empty);
    await Promise.all([a, b]);
  } finally {
    globalThis.setTimeout = real;
  }
  assert.deepEqual(delays.slice(0, 2), [35000, 7000]);
});

test("eventSource: a server event named like an object member or like open or error breaks nothing", async () => {
  const seen = [];
  const source = plisto.net.eventSource("https://api.example.com/odd");
  source.onopen = () => seen.push("onopen");
  source.onerror = () => seen.push("onerror");
  source.addEventListener("constructor", (e) => seen.push("constructor:" + e.data));
  source.addEventListener("toString", (e) => seen.push("toString:" + e.data));
  await answer("net.fetch", OPEN_SSE("https://api.example.com/odd", "t23"));
  await tick();
  const frames =
    "event: constructor\ndata: 1\n\nevent: toString\ndata: 2\n\nevent: error\ndata: 3\n\n" +
    "event: open\ndata: 4\n\nevent: nobody\ndata: 5\n\n";
  host({ type: "plisto:stream", stream: "t23", kind: "chunk", seq: 1, data: buf(frames) });
  await tick();
  await tick();
  assert.deepEqual(seen, ["onopen", "constructor:1", "toString:2"]);
  assert.equal(source.readyState, 1);
  source.close();
  await answer("net.abort", { aborted: 1 });
  host({ type: "plisto:stream", stream: "t23", kind: "error", code: "aborted", reason: "abort" });
});

test("eventSource: a stream over the event cap fails with too_large and is cancelled", async () => {
  const source = plisto.net.eventSource("https://api.example.com/big");
  let error = null;
  source.onerror = (e) => (error = e.error);
  await answer("net.fetch", OPEN_SSE("https://api.example.com/big", "t24"));
  await tick();
  host({ type: "plisto:stream", stream: "t24", kind: "chunk", seq: 1, data: new Uint8Array(1048576 + 10).fill(120).buffer });
  await tick();
  await tick();
  assert.equal(error.code, "too_large");
  assert.equal(source.readyState, 2);
  const cancel = await answer("net.stream.cancel", {});
  assert.equal(JSON.parse(cancel.msg.args).stream, "t24");
});

test("eventSource: a reconnect sends last-event-id and waits the server's retry", async () => {
  const source = plisto.net.eventSource("https://api.example.com/re");
  const seen = [];
  source.onmessage = (e) => seen.push(e.data);
  await answer("net.fetch", OPEN_SSE("https://api.example.com/re", "t25"));
  await tick();
  host({ type: "plisto:stream", stream: "t25", kind: "chunk", seq: 1, data: buf("retry: 1000\nid: 9\ndata: x\n\n") });
  host({ type: "plisto:stream", stream: "t25", kind: "end" });
  await tick();
  await tick();
  assert.equal(source.readyState, 0);
  const again = await answer("net.fetch", OPEN_SSE("https://api.example.com/re", "t26"));
  assert.equal(JSON.parse(again.msg.args).headers["last-event-id"], "9");
  assert.deepEqual(seen, ["x"]);
  source.close();
  await answer("net.abort", { aborted: 1 });
  host({ type: "plisto:stream", stream: "t26", kind: "error", code: "aborted", reason: "abort" });
});

test("eventSource: network, timeout, busy and rate_limited errors retry; others stop", async () => {
  for (const code of ["network", "timeout", "busy", "rate_limited"]) {
    const source = plisto.net.eventSource("https://api.example.com/r-" + code);
    await answer("net.fetch", null, { code, reason: null });
    await tick();
    assert.equal(source.readyState, 0, code);
    source.close();
  }
  for (const code of ["denied", "invalid_args", "too_large", "unavailable", "aborted"]) {
    const source = plisto.net.eventSource("https://api.example.com/s-" + code);
    await answer("net.fetch", null, { code, reason: null });
    await tick();
    assert.equal(source.readyState, 2, code);
  }
});

test("imageUrl: a good image gives a blob URL, and a data URL when blobs fail", async () => {
  const png = { status: 200, url: "u", redirected: false, headers: [["content-type", "image/png"]], set_cookies: [] };
  const first = plisto.net.imageUrl("https://cdn.example.com/a.png");
  await answer("net.fetch", { ...png, body: new Uint8Array([1, 2, 3]).buffer });
  const url = await first;
  assert.match(url, /^blob:/);
  plisto.net.revoke(url);

  const real = URL.createObjectURL;
  URL.createObjectURL = () => {
    throw new Error("no blobs");
  };
  try {
    const second = plisto.net.imageUrl("https://cdn.example.com/b.png");
    await answer("net.fetch", { ...png, body: new Uint8Array([1, 2, 3]).buffer });
    assert.equal(await second, "data:image/png;base64,AQID");
  } finally {
    URL.createObjectURL = real;
  }
});

test("imageUrl: a non-2xx answer and a non-image reject with an Error carrying status", async () => {
  const base = { url: "u", redirected: false, set_cookies: [], body: new ArrayBuffer(1) };
  const missing = plisto.net.imageUrl("https://cdn.example.com/missing.png");
  const missingOutcome = assert.rejects(missing, (e) => e.status === 404 && !(e instanceof plisto.PlistoError));
  await answer("net.fetch", { ...base, status: 404, headers: [["content-type", "image/png"]] });
  await missingOutcome;

  const page = plisto.net.imageUrl("https://cdn.example.com/page");
  const pageOutcome = assert.rejects(page, (e) => e.status === 200 && /not an image/.test(e.message));
  await answer("net.fetch", { ...base, status: 200, headers: [["content-type", "text/html"]] });
  await pageOutcome;
});

async function openSocket(id) {
  const pending = plisto.net.socket("wss://api.example.com/" + id);
  await answer("net.socket.open", { socket: id, protocol: null });
  return pending;
}

test("socket: a page that sets only onclose still gets the close", async () => {
  const socket = await openSocket("s10");
  host({ type: "plisto:socket", socket: "s10", kind: "text", data: "dropped" });
  host({ type: "plisto:socket", socket: "s10", kind: "close", code: 1006, reason: "", clean: false });
  const got = [];
  socket.onclose = (e) => got.push(e.code + ":" + e.wasClean);
  assert.deepEqual(got, ["1006:false"]);
});

test("socket: the held queue keeps the newest 100 messages and the close", async () => {
  const socket = await openSocket("s11");
  for (let i = 0; i < 150; i++) host({ type: "plisto:socket", socket: "s11", kind: "text", data: "m" + i });
  host({ type: "plisto:socket", socket: "s11", kind: "close", code: 1000, reason: "", clean: true });
  const got = [];
  socket.onmessage = (e) => got.push(e.data);
  socket.onclose = () => got.push("close");
  assert.equal(got.length, 101);
  assert.equal(got[0], "m50");
  assert.equal(got[99], "m149");
  assert.equal(got[100], "close");
});

test("socket: the held queue is capped by bytes too", async () => {
  const socket = await openSocket("s12");
  const big = new Uint8Array(1048576).buffer;
  for (let i = 0; i < 6; i++) host({ type: "plisto:socket", socket: "s12", kind: "binary", data: big });
  let count = 0;
  socket.onmessage = () => count++;
  assert.equal(count, 4);
});

// -- Socket acknowledgements --

/** The net.socket.ack calls posted for socket `id`, in order, with their parsed arguments. */
function socketAcks(id) {
  return posted
    .filter((p) => p.msg.type === "plisto:call" && p.msg.method === "net.socket.ack")
    .map((p) => ({ call: p, args: JSON.parse(p.msg.args) }))
    .filter((a) => a.args.socket === id);
}

/** Waits until socket `id` has at least `n` acknowledgement calls, and returns them. */
async function waitForAcks(id, n) {
  for (let i = 0; i < 100 && socketAcks(id).length < n; i++) await sleep(10);
  return socketAcks(id);
}

function reply(call, error) {
  if (error) host({ type: "plisto:result", id: call.msg.id, ok: false, error });
  else host({ type: "plisto:result", id: call.msg.id, ok: true, result: {} });
}

test("socket ack: the running total counts UTF-8 bytes of text and the byte length of binary", async () => {
  const socket = await openSocket("a1");
  socket.onmessage = () => {};
  // "h", "e acute" (2 bytes), "l", "l", "o", "euro" (3 bytes): 9 bytes in 6 characters.
  const word = "h" + String.fromCharCode(0xe9) + "llo" + String.fromCharCode(0x20ac);
  host({ type: "plisto:socket", socket: "a1", kind: "text", data: word });
  host({ type: "plisto:socket", socket: "a1", kind: "binary", data: buf("12345") });
  assert.deepEqual(socketAcks("a1"), [], "small messages wait for the delay");
  const first = await waitForAcks("a1", 1);
  assert.equal(first.length, 1, "both messages go out in one acknowledgement");
  assert.equal(first[0].args.bytes, 14);
  reply(first[0].call);
  host({ type: "plisto:socket", socket: "a1", kind: "text", data: "ab" });
  const second = await waitForAcks("a1", 2);
  assert.equal(second[1].args.bytes, 16, "the total is running, not a delta");
  reply(second[1].call);
});

test("socket ack: a burst past 256 KiB is acknowledged at once", async () => {
  const socket = await openSocket("a2");
  socket.onmessage = () => {};
  host({ type: "plisto:socket", socket: "a2", kind: "binary", data: new Uint8Array(262144).buffer });
  const acks = socketAcks("a2");
  assert.equal(acks.length, 1);
  assert.equal(acks[0].args.bytes, 262144);
  reply(acks[0].call);
});

test("socket ack: a held message is acknowledged once handed over, and a dropped one at its drop", async () => {
  const socket = await openSocket("a3");
  for (let i = 0; i < 150; i++) host({ type: "plisto:socket", socket: "a3", kind: "text", data: "m" });
  // 50 of the 150 fell out of the held queue: they count, the 100 still held do not.
  const dropped = await waitForAcks("a3", 1);
  assert.equal(dropped[0].args.bytes, 50);
  reply(dropped[0].call);
  socket.onmessage = () => {};
  const handed = await waitForAcks("a3", 2);
  assert.equal(handed[1].args.bytes, 150);
  reply(handed[1].call);
});

test("socket ack: no message is acknowledged while no handler is set", async () => {
  await openSocket("a4");
  host({ type: "plisto:socket", socket: "a4", kind: "text", data: "waiting" });
  await sleep(400);
  assert.deepEqual(socketAcks("a4"), []);
});

test("socket ack: nothing is sent after the socket closed", async () => {
  const socket = await openSocket("a5");
  socket.onmessage = () => {};
  host({ type: "plisto:socket", socket: "a5", kind: "text", data: "last" });
  host({ type: "plisto:socket", socket: "a5", kind: "close", code: 1000, reason: "", clean: true });
  await sleep(400);
  assert.deepEqual(socketAcks("a5"), []);
});

test("socket ack: a retryable failure is sent again, a final one is not", async () => {
  const socket = await openSocket("a6");
  socket.onmessage = () => {};
  host({ type: "plisto:socket", socket: "a6", kind: "text", data: "abc" });
  const first = await waitForAcks("a6", 1);
  reply(first[0].call, { code: "busy", message: "busy" });
  const again = await waitForAcks("a6", 2);
  assert.equal(again[1].args.bytes, 3);
  reply(again[1].call, { code: "not_found", message: "gone" });
  await sleep(400);
  assert.equal(socketAcks("a6").length, 2, "not_found ends the retries");
});
