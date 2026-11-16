/*
 * Keeps sdk/mock-host.html in step with plisto-sdk.js: every method name the SDK sends has a handler in the
 * mock, or is listed there as not implemented. Both files are read as text; no browser runs. Run:
 * node --test plugin-kit/tests/mock-host.mjs. The file name avoids the .test suffix so the app's Vitest run
 * does not collect it.
 */

// -- Library Imports --
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const sdk = readFileSync(new URL("../sdk/plisto-sdk.js", import.meta.url), "utf8");
const mock = readFileSync(new URL("../sdk/mock-host.html", import.meta.url), "utf8");

const METHOD = "[a-z][a-z0-9_]*(?:\\.[a-z][a-z0-9_]*){1,3}";

/** Every quoted string in the SDK shaped like a method name: dotted lowercase parts. */
function sdkMethods() {
  const found = new Set();
  for (const m of sdk.matchAll(new RegExp(`"(${METHOD})"`, "g"))) found.add(m[1]);
  return [...found].sort();
}

/** Names registered with h("name", ...) in the mock. */
function handled() {
  return new Set([...mock.matchAll(/\bh\(\s*"([^"]+)"/g)].map((m) => m[1]));
}

/** Names in the mock's NOT_IMPLEMENTED list. */
function notImplemented() {
  const block = mock.match(/var NOT_IMPLEMENTED = \[([^\]]*)\]/);
  assert.ok(block, "mock-host.html has no NOT_IMPLEMENTED list");
  return new Set([...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
}

test("the SDK exposes methods the test can see", () => {
  const names = sdkMethods();
  assert.ok(names.includes("storage.get") && names.includes("library.tracks"), "the SDK scan found no methods");
});

test("every SDK method has a handler in the mock or is listed as not implemented", () => {
  const have = handled();
  const skipped = notImplemented();
  const missing = sdkMethods().filter((name) => !have.has(name) && !skipped.has(name));
  assert.deepEqual(
    missing,
    [],
    `mock-host.html has no handler for: ${missing.join(", ")}. Add h("<name>", ...) or list it in NOT_IMPLEMENTED.`,
  );
});

test("a method is either handled or not implemented, never both", () => {
  const both = [...handled()].filter((name) => notImplemented().has(name));
  assert.deepEqual(both, []);
});

test("the mock answers no method the SDK does not send", () => {
  const known = new Set(sdkMethods());
  const stale = [...handled(), ...notImplemented()].filter((name) => !known.has(name));
  assert.deepEqual(stale, [], `mock-host.html names methods the SDK no longer has: ${stale.join(", ")}`);
});

const STREAM_METHODS = [
  "stream.play",
  "stream.update",
  "stream.push",
  "stream.end",
  "stream.pause",
  "stream.resume",
  "stream.stop",
  "stream.state",
];

/** The quoted words of the array literal that follows `marker` in the mock. */
function quotedList(marker) {
  const at = mock.indexOf(marker);
  assert.ok(at >= 0, `mock-host.html has no ${marker}`);
  const open = mock.indexOf("[", at);
  const close = mock.indexOf("]", open);
  return [...mock.slice(open, close).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

test("the mock handles every stream method and gates it on playback.stream", () => {
  const have = handled();
  for (const name of STREAM_METHODS) assert.ok(have.has(name), `no handler for ${name}`);
  assert.deepEqual(quotedList('needs("playback.stream"'), STREAM_METHODS);
});

test("the mock fires stream events at the page on the stream topic, with the end reasons the types name", () => {
  assert.match(mock, /type: "plisto:plugin-event", topic: "stream"/);
  const types = readFileSync(new URL("../sdk/plisto-sdk.d.ts", import.meta.url), "utf8");
  const union = types.match(/export type StreamEndReason =([^;]*);/);
  assert.ok(union, "plisto-sdk.d.ts has no StreamEndReason");
  const typed = [...union[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(quotedList("var STREAM_REASONS"), typed);
  for (const kind of ["state", "skip", "room", "ended"]) {
    assert.match(mock, new RegExp(`<option>${kind}</option>`), `the event picker lacks ${kind}`);
  }
});

/** The key and capability of each entry of the mock's TOPIC_NEEDS table. */
function topicNeeds() {
  const block = mock.match(/var TOPIC_NEEDS = \{([^}]*)\}/);
  assert.ok(block, "mock-host.html has no TOPIC_NEEDS table");
  return Object.fromEntries([...block[1].matchAll(/(\w+): (?:"([^"]+)"|null)/g)].map((m) => [m[1], m[2] ?? null]));
}

test("the mock's topics are the ones the types name, with the capabilities each needs", () => {
  const types = readFileSync(new URL("../sdk/plisto-sdk.d.ts", import.meta.url), "utf8");
  const map = types.match(/export interface PlistoTopics \{([^}]*)\}/);
  assert.ok(map, "plisto-sdk.d.ts has no PlistoTopics");
  const typed = [...map[1].matchAll(/^\s*(\w+):/gm)].map((m) => m[1]).sort();
  const needs = topicNeeds();
  assert.deepEqual(Object.keys(needs).sort(), typed);
  assert.deepEqual(needs, {
    now_playing: "playback.read",
    playback_state: "playback.read",
    queue: "playback.read",
    library_changed: "library.read",
    theme: null,
    locale: null,
    app_mode: null,
  });
  assert.match(mock, /topics: topicNames\(\)/, "app.methods does not list the topics");
});

test("the mock fires app events on plisto:event, apart from the stream channel, when its controls change", () => {
  assert.match(mock, /type: "plisto:event", topic: topic/);
  for (const topic of ["theme", "locale", "app_mode"]) {
    assert.match(mock, new RegExp(`fireTopic\\("${topic}"\\)`), `no ${topic} event on its control`);
  }
  // The transport and the stream both publish the player topics after every change.
  assert.equal(mock.match(/publishPlayer\(\);/g).length >= 3, true);
  assert.match(mock, /fireTopic\(topic\)/);
  assert.equal(/topic: "stream"/.test(mock.match(/function fireTopic[\s\S]*?\n  }\n/)[0]), false);
});

test("the mock refuses the reserved stream topic and starts each document with no subscription", () => {
  assert.match(mock, /t === "stream"\) fail\("invalid_args"/);
  assert.match(mock, /appSubs = \{\};\s+sentKey = \{\};\s+sendInit\(\)/);
});

test("the mock frames the page with the host's sandbox attribute and loads nothing remote", () => {
  assert.match(mock, /<iframe[^>]*sandbox="allow-scripts"/);
  assert.equal(/(?:src|href)="https?:/.test(mock), false, "the mock must not load remote files");
  assert.equal(/[^\x00-\x7f]/.test(mock), false, "the mock must be ASCII only");
});
