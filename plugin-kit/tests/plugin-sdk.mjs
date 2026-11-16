/*
 * Tests for the native plugin half of plisto-sdk.js: calls to the plugin's own program through
 * `plisto.plugin.call`, its `plugin_error` code, and page events through `plisto.onPluginEvent`. Run:
 * node --test plugin-kit/tests/plugin-sdk.mjs. The file name avoids the .test suffix so the app's Vitest
 * run does not collect it.
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
  },
};
globalThis.window = {
  parent,
  addEventListener(type, fn) {
    if (type === "message") listener = fn;
  },
};
const existingLink = { tagName: "link" };
const head = {
  children: [existingLink],
  insertBefore(node, ref) {
    this.children.splice(this.children.indexOf(ref), 0, node);
  },
  get firstChild() {
    return this.children[0] || null;
  },
};
globalThis.document = {
  documentElement: { dataset: {} },
  head,
  createElement: (tagName) => ({ tagName }),
  getElementById: (id) => head.children.find((n) => n.id === id) || null,
};
const sdk = new URL("../sdk/plisto-sdk.js", import.meta.url);
const sdkSource = readFileSync(sdk, "utf8");
vm.runInThisContext(sdkSource, { filename: "plisto-sdk.js" });
const plisto = globalThis.window.plisto;

/** Delivers a host message to the SDK as the bridge would. */
function host(data) {
  listener({ source: parent, data: { plisto: 1, ...data } });
}

/** The last call posted. */
function lastCall() {
  const calls = posted.filter((m) => m.type === "plisto:call");
  return calls[calls.length - 1];
}

// -- Scrollbar style --

test("the scrollbar style is injected once, first in head, with a dark-theme rule", () => {
  const styles = head.children.filter((n) => n.tagName === "style");
  assert.equal(styles.length, 1);
  assert.equal(head.children[0], styles[0]);
  assert.match(styles[0].textContent, /::-webkit-scrollbar\{width:8px/);
  assert.match(styles[0].textContent, /:root\[data-theme="dark"\]\)\{--plisto-scroll-thumb:/);
  assert.doesNotMatch(styles[0].textContent, /scrollbar-(width|color)/);
});

test("loading the SDK a second time adds no second style", () => {
  const firstListener = listener;
  vm.runInThisContext(sdkSource, { filename: "plisto-sdk.js" });
  assert.equal(head.children.filter((n) => n.tagName === "style").length, 1);
  listener = firstListener;
  globalThis.window.plisto = plisto;
});

// -- plisto.plugin.call --

test("a relay call goes out as plugin.<name> with its arguments", async () => {
  const pending = plisto.plugin.call("ping", { n: 1 });
  const call = lastCall();
  assert.equal(call.method, "plugin.ping");
  assert.deepEqual(JSON.parse(call.args), { n: 1 });
  host({ type: "plisto:result", id: call.id, ok: true, result: { pong: true, seq: 3 } });
  assert.deepEqual(await pending, { pong: true, seq: 3 });
});

test("a relay call without arguments sends an empty object", async () => {
  const pending = plisto.plugin.call("ping");
  const call = lastCall();
  assert.equal(call.args, "{}");
  host({ type: "plisto:result", id: call.id, ok: true, result: null });
  assert.equal(await pending, null);
});

test("the program's error rejects plugin_error with its message", async () => {
  const pending = plisto.plugin.call("missing", {});
  const call = lastCall();
  host({
    type: "plisto:result",
    id: call.id,
    ok: false,
    error: { code: "plugin_error", message: "tap-meter has no method 'missing'", reason: null },
  });
  await assert.rejects(pending, (e) => {
    assert.ok(e instanceof plisto.PlistoError);
    assert.equal(e.code, "plugin_error");
    assert.equal(e.message, "tap-meter has no method 'missing'");
    assert.equal(e.reason, null);
    assert.equal(e.retryAfterMs, null);
    return true;
  });
});

test("the host's timeout and unavailable pass through as they are", async () => {
  for (const code of ["timeout", "unavailable", "busy", "unknown_method"]) {
    const pending = plisto.plugin.call("ping", {});
    host({ type: "plisto:result", id: lastCall().id, ok: false, error: { code, message: "x" } });
    await assert.rejects(pending, (e) => e.code === code);
  }
});

test("a relay call waits 12 s by default, longer than the host's 10 s", () => {
  const real = globalThis.setTimeout;
  const delays = [];
  // The calls below are never answered; their timers are replaced so they never fire.
  globalThis.setTimeout = (_fn, ms) => {
    delays.push(ms);
    return real(() => {}, 0);
  };
  try {
    plisto.plugin.call("ping", {});
    plisto.plugin.call("ping", {}, { timeoutMs: 3000 });
  } finally {
    globalThis.setTimeout = real;
  }
  assert.deepEqual(delays, [12000, 3000]);
});

test("a relay call times out on its own when the host never answers", async () => {
  await assert.rejects(plisto.plugin.call("ping", {}, { timeoutMs: 5 }), (e) => e.code === "timeout");
});

test("a name that is not a string rejects invalid_args without posting", async () => {
  const before = posted.length;
  await assert.rejects(plisto.plugin.call(5), (e) => e.code === "invalid_args");
  assert.equal(posted.length, before);
});

test("PlistoError takes the plugin_error code", () => {
  const e = new plisto.PlistoError("plugin_error", "said no");
  assert.equal(e.code, "plugin_error");
  assert.equal(e.name, "PlistoError");
});

// -- plisto.onPluginEvent --

test("a page event reaches the listeners of its topic only", () => {
  const levels = [];
  const other = [];
  const offLevels = plisto.onPluginEvent("levels", (data) => levels.push(data));
  const offOther = plisto.onPluginEvent("other.topic", (data) => other.push(data));
  host({ type: "plisto:plugin-event", topic: "levels", data: { peak_db: [-6, null] } });
  host({ type: "plisto:plugin-event", topic: "unheard", data: 1 });
  assert.deepEqual(levels, [{ peak_db: [-6, null] }]);
  assert.deepEqual(other, []);
  offLevels();
  offOther();
});

test("unsubscribing stops delivery and a throwing listener does not stop the others", () => {
  const seen = [];
  const offThrow = plisto.onPluginEvent("levels", () => {
    throw new Error("boom");
  });
  const off = plisto.onPluginEvent("levels", (data) => seen.push(data));
  host({ type: "plisto:plugin-event", topic: "levels", data: 1 });
  off();
  host({ type: "plisto:plugin-event", topic: "levels", data: 2 });
  assert.deepEqual(seen, [1]);
  offThrow();
  off();
});

test("a malformed page event is ignored", () => {
  const seen = [];
  const off = plisto.onPluginEvent("levels", (data) => seen.push(data));
  host({ type: "plisto:plugin-event", data: 1 });
  host({ type: "plisto:plugin-event", topic: 7, data: 1 });
  host({ type: "plisto:plugin-event", topic: "hasOwnProperty", data: 1 });
  host({ type: "plisto:plugin-event", topic: "__proto__", data: 1 });
  listener({ source: {}, data: { plisto: 1, type: "plisto:plugin-event", topic: "levels", data: 1 } });
  assert.deepEqual(seen, []);
  off();
});

test("a bad topic or callback throws TypeError", () => {
  for (const topic of ["", "Levels", "a b", "x".repeat(65), 5, null]) {
    assert.throws(() => plisto.onPluginEvent(topic, () => {}), TypeError);
  }
  assert.throws(() => plisto.onPluginEvent("levels", "not a function"), TypeError);
  assert.equal(typeof plisto.onPluginEvent("a-b_c.9", () => {}), "function");
});

test("a topic named like an object key is an ordinary topic", () => {
  const seen = [];
  const off = plisto.onPluginEvent("__proto__", (data) => seen.push(data));
  host({ type: "plisto:plugin-event", topic: "__proto__", data: 1 });
  host({ type: "plisto:plugin-event", topic: "constructor", data: 2 });
  assert.deepEqual(seen, [1]);
  off();
});
