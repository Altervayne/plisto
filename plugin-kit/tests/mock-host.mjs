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

test("the mock frames the page with the host's sandbox attribute and loads nothing remote", () => {
  assert.match(mock, /<iframe[^>]*sandbox="allow-scripts"/);
  assert.equal(/(?:src|href)="https?:/.test(mock), false, "the mock must not load remote files");
  assert.equal(/[^\x00-\x7f]/.test(mock), false, "the mock must be ASCII only");
});
