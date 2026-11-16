/*
 * Tests for the app event half of plisto-sdk.js: `plisto.events.subscribe`, `on` and `topics`, and the routing
 * of `plisto:event` apart from `plisto:plugin-event`. A fake host answers each posted call from a script, so no
 * browser runs. Run: node --test plugin-kit/tests/events-sdk.mjs. The file name avoids the .test suffix so the
 * app's Vitest run does not collect it.
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

/** Answers a call: `{ result }` or `{ error }`. */
function reply(id, answer) {
  if (answer.error) host({ type: "plisto:result", id, ok: false, error: answer.error });
  else host({ type: "plisto:result", id, ok: true, result: answer.result ?? {} });
}

const event = (topic, data) => host({ type: "plisto:event", topic, data });
const calls = (method) => posted.filter((m) => m.type === "plisto:call" && m.method === method);

const THEME = { theme: "dark" };
const LOCALE = { locale: "fr" };

test.beforeEach(() => {
  posted.length = 0;
  script = null;
});

test("subscribe sends the topics to events.subscribe and resolves the host's answer", async () => {
  const answer = { topics: ["locale", "theme"], current: { theme: THEME, locale: LOCALE } };
  script = () => ({ result: answer });
  const result = await plisto.events.subscribe(["theme", "locale"]);
  assert.deepEqual(result, answer);
  const [call] = calls("events.subscribe");
  assert.deepEqual(JSON.parse(call.args), { topics: ["theme", "locale"] });
});

test("subscribe hands current to the handlers before it resolves, for topics with a handler only", async () => {
  const seen = [];
  const offTheme = plisto.events.on("theme", (d) => seen.push(["theme", d]));
  const offLocale = plisto.events.on("locale", (d) => seen.push(["locale", d]));
  script = () => ({
    result: { topics: ["app_mode", "locale", "theme"], current: { theme: THEME, locale: LOCALE, app_mode: { app_mode: "both" } } },
  });
  await plisto.events.subscribe(["theme", "locale", "app_mode"]).then((r) => {
    seen.push(["resolved", r.topics.length]);
  });
  // The values arrive in the host's order; app_mode has no handler, so it is dropped.
  assert.deepEqual(seen, [["theme", THEME], ["locale", LOCALE], ["resolved", 3]]);
  offTheme();
  offLocale();
});

test("current may lack a topic whose read failed", async () => {
  const seen = [];
  const off = [
    plisto.events.on("queue", (d) => seen.push(["queue", d])),
    plisto.events.on("theme", (d) => seen.push(["theme", d])),
  ];
  script = () => ({ result: { topics: ["queue", "theme"], current: { theme: THEME } } });
  await plisto.events.subscribe(["queue", "theme"]);
  assert.deepEqual(seen, [["theme", THEME]]);
  off.forEach((f) => f());
});

test("subscribe without a current object resolves and dispatches nothing", async () => {
  const seen = [];
  const off = plisto.events.on("theme", (d) => seen.push(d));
  script = () => ({ result: { topics: [] } });
  assert.deepEqual(await plisto.events.subscribe([]), { topics: [] });
  script = () => ({ result: { topics: [], current: null } });
  await plisto.events.subscribe([]);
  assert.deepEqual(seen, []);
  off();
});

test("a refused subscribe rejects with the host's code and dispatches nothing", async () => {
  const seen = [];
  const off = plisto.events.on("queue", (d) => seen.push(d));
  script = () => ({ error: { code: "denied", message: "The 'queue' topic needs the playback.read permission." } });
  await assert.rejects(plisto.events.subscribe(["queue"]), (e) => e instanceof plisto.PlistoError && e.code === "denied");
  assert.deepEqual(seen, []);
  off();
});

test("two quick subscribes both resolve, each dispatching its own current", async () => {
  const seen = [];
  const off = plisto.events.on("locale", (d) => seen.push(d.locale));
  let n = 0;
  script = () => ({ result: { topics: ["locale"], current: { locale: { locale: ++n === 1 ? "en" : "fr" } } } });
  const [a, b] = await Promise.all([plisto.events.subscribe(["locale"]), plisto.events.subscribe(["locale"])]);
  assert.equal(a.current.locale.locale, "en");
  assert.equal(b.current.locale.locale, "fr");
  assert.deepEqual(seen, ["en", "fr"]);
  off();
});

test("a plisto:event reaches the handlers of its topic with its data, in order", () => {
  const seen = [];
  const off = plisto.events.on("playback_state", (d) => seen.push(d.seek_seq));
  event("playback_state", { seek_seq: 1 });
  event("playback_state", { seek_seq: 2 });
  assert.deepEqual(seen, [1, 2]);
  off();
});

test("an event for a topic with no handler is dropped without an error", () => {
  assert.doesNotThrow(() => event("queue", { index: 0, length: 0, rev: 1, parked: false }));
  assert.doesNotThrow(() => host({ type: "plisto:event", topic: 7, data: {} }));
  assert.doesNotThrow(() => host({ type: "plisto:event", data: {} }));
});

test("the unsubscribe function stops delivery and leaves the other handlers", () => {
  const a = [];
  const b = [];
  const offA = plisto.events.on("theme", (d) => a.push(d));
  const offB = plisto.events.on("theme", (d) => b.push(d));
  event("theme", THEME);
  offA();
  offA();
  event("theme", THEME);
  assert.equal(a.length, 1);
  assert.equal(b.length, 2);
  offB();
});

test("a throwing handler does not stop the others", () => {
  const seen = [];
  const offs = [
    plisto.events.on("theme", () => {
      throw new Error("boom");
    }),
    plisto.events.on("theme", (d) => seen.push(d)),
  ];
  assert.doesNotThrow(() => event("theme", THEME));
  assert.deepEqual(seen, [THEME]);
  offs.forEach((f) => f());
});

test("plisto:event never reaches onPluginEvent, and plisto:plugin-event never reaches events.on", () => {
  const app = [];
  const page = [];
  const offApp = plisto.events.on("theme", (d) => app.push(d));
  const offPage = plisto.onPluginEvent("theme", (d) => page.push(d));
  event("theme", THEME);
  assert.deepEqual([app.length, page.length], [1, 0]);
  host({ type: "plisto:plugin-event", topic: "theme", data: { from: "program" } });
  assert.deepEqual([app.length, page.length], [1, 1]);
  assert.deepEqual(page[0], { from: "program" });
  offApp();
  offPage();
});

test("the stream topic keeps arriving through onPluginEvent and never through plisto:event", () => {
  const stream = [];
  const offStream = plisto.onStream((d) => stream.push(d));
  host({ type: "plisto:plugin-event", topic: "stream", data: { item: -1, kind: "state", state: "playing" } });
  event("stream", { item: -1, kind: "ended", reason: "user", detail: null });
  assert.equal(stream.length, 1);
  assert.equal(stream[0].kind, "state");
  assert.throws(() => plisto.events.on("stream", () => {}), TypeError);
  offStream();
});

test("on rejects a bad topic or callback", () => {
  assert.throws(() => plisto.events.on("Theme", () => {}), TypeError);
  assert.throws(() => plisto.events.on("", () => {}), TypeError);
  assert.throws(() => plisto.events.on(3, () => {}), TypeError);
  assert.throws(() => plisto.events.on("x".repeat(65), () => {}), TypeError);
  assert.throws(() => plisto.events.on("theme"), TypeError);
  assert.throws(() => plisto.events.on("theme", "nope"), TypeError);
});

test("a topic named like an Object.prototype key is a plain key", () => {
  const seen = [];
  const off = plisto.events.on("__proto__", (d) => seen.push(d));
  event("__proto__", 1);
  event("constructor", 2);
  event("hasOwnProperty", 3);
  assert.deepEqual(seen, [1]);
  off();
});

test("topics reads the list from app.methods", async () => {
  script = (method) => {
    assert.equal(method, "app.methods");
    return { result: { api_version: 1, methods: ["events.subscribe"], topics: ["locale", "theme"] } };
  };
  const names = await plisto.events.topics();
  assert.deepEqual(names, ["locale", "theme"]);
  names.push("changed");
  assert.deepEqual(await plisto.events.topics(), ["locale", "theme"]);
});

test("topics is empty on a host that lists none", async () => {
  script = () => ({ result: { api_version: 1, methods: [] } });
  assert.deepEqual(await plisto.events.topics(), []);
});
