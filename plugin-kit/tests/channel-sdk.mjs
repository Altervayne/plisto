/*
 * Tests for the visualizer channel of plisto-sdk.js: `plisto.visualizers.send` and `onMessage`, and the
 * mock host's side of it. A fake host answers each posted call, so no browser runs. Run:
 * node --test plugin-kit/tests/channel-sdk.mjs. The file name avoids the .test suffix so the app's Vitest run
 * does not collect it.
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
  postMessage(msg) {
    posted.push(msg);
    if (msg.type === "plisto:call") {
      queueMicrotask(() => host({ type: "plisto:result", id: msg.id, ok: true, result: null }));
    }
  },
};
globalThis.window = {
  parent,
  addEventListener(type, fn) {
    if (type === "message") listener = fn;
  },
};
globalThis.document = { documentElement: { dataset: {} } };
vm.runInThisContext(readFileSync(new URL("../sdk/plisto-sdk.js", import.meta.url), "utf8"), {
  filename: "plisto-sdk.js",
});
const { visualizers } = globalThis.window.plisto;
const MAX = 16384;

/** Delivers a host message to the SDK as the bridge would. */
function host(data) {
  listener({ source: parent, data: { plisto: 1, ...data } });
}

const sent = () => posted.filter((m) => m.type === "plisto:call" && m.method === "channel.send");

test.beforeEach(() => {
  posted.length = 0;
});

test("send posts one channel.send call carrying the data", () => {
  visualizers.send({ level: 3 });
  const [call] = sent();
  assert.deepEqual(JSON.parse(call.args), { data: { level: 3 } });
});

test("send names the kind when one is given, and rejects a kind that is not a string", () => {
  visualizers.send("hi", "aurora");
  assert.deepEqual(JSON.parse(sent()[0].args), { data: "hi", kind: "aurora" });
  assert.throws(() => visualizers.send("hi", 4), TypeError);
  assert.equal(sent().length, 1);
});

test("send throws a RangeError over 16384 UTF-8 bytes and passes a message at the limit", () => {
  assert.throws(() => visualizers.send("x".repeat(MAX - 1)), RangeError);
  assert.throws(() => visualizers.send("\u00e9".repeat(MAX / 2)), RangeError);
  assert.equal(sent().length, 0);
  visualizers.send("x".repeat(MAX - 2));
  visualizers.send("\u00e9".repeat(MAX / 2 - 1));
  assert.equal(sent().length, 2);
});

test("send throws a TypeError for data that cannot be serialized", () => {
  const loop = {};
  loop.self = loop;
  for (const bad of [loop, undefined, () => 1, Symbol("s"), 10n]) {
    assert.throws(() => visualizers.send(bad), TypeError);
  }
  assert.equal(sent().length, 0);
});

test("onMessage hands the data and the sending kind to each subscriber, until it unsubscribes", () => {
  const a = [];
  const b = [];
  const off = visualizers.onMessage((data, from) => a.push([data, from]));
  visualizers.onMessage((data) => b.push(data));
  host({ type: "plisto:channel", data: { n: 1 }, from: { kind: "aurora" } });
  off();
  host({ type: "plisto:channel", data: { n: 2 }, from: { kind: "halo" } });
  assert.deepEqual(a, [[{ n: 1 }, { kind: "aurora" }]]);
  assert.deepEqual(b, [{ n: 1 }, { n: 2 }]);
});

test("a throwing subscriber does not stop the others, and onMessage refuses a non-function", () => {
  const got = [];
  visualizers.onMessage(() => {
    throw new Error("boom");
  });
  visualizers.onMessage((data) => got.push(data));
  host({ type: "plisto:channel", data: 7, from: { kind: "k" } });
  assert.deepEqual(got.slice(-1), [7]);
  assert.throws(() => visualizers.onMessage("no"), TypeError);
});

test("the mock host models the channel's limits and plays a visualizer frame", () => {
  const mock = readFileSync(new URL("../sdk/mock-host.html", import.meta.url), "utf8");
  assert.match(mock, /var CHANNEL_MAX_BYTES = 16384;/);
  assert.match(mock, /var CHANNEL_PER_SEC = 20;/);
  assert.match(mock, /h\("channel\.send"/);
  assert.match(mock, /type: "plisto:channel"/);
});
