/*
 * Tests for the visualizer harness: how the controls map onto the frame's context, the host tick loop
 * (credit window, folding while hidden, change-only updates), the feeds, the readout's "no reading", and the
 * mock server that serves the page, the frame origin and the watch stream. The server tests start
 * mock-serve on an ephemeral port as a child process and stop it; no browser starts. Run:
 * node --test plugin-kit/tests/harness.mjs. The file name avoids the .test suffix so the app's Vitest run
 * does not collect it.
 */

// -- Library Imports --
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// -- Local Imports --
import { createOnsetTracker, levelOfRms, logBands, waveWindow } from "../visualizers/harness/audioFeed.js";
import {
  blendOf,
  buildContext,
  buildInit,
  createContextTracker,
  defaultSettings,
} from "../visualizers/harness/context.js";
import { GAIN, createRecordedFeed, parseRecording, shapeTick } from "../visualizers/harness/feeds.js";
import { createTransport } from "../visualizers/harness/transport.js";
import { createFeed } from "../visualizers/lib/check/feed.js";
import { checkManifest } from "../visualizers/lib/check/manifest.mjs";
import { readInit } from "../visualizers/lib/protocol.js";

const KIT = fileURLToPath(new URL("..", import.meta.url));
const HARNESS = join(KIT, "visualizers", "harness");
const EXAMPLES = join(KIT, "visualizers", "examples");
const declOf = (example) => checkManifest(join(EXAMPLES, example)).decls[0];

const controls = (over = {}) => ({
  theme: "dark",
  layout: "player",
  reactivity: "balanced",
  reducedMotion: false,
  settings: {},
  ...over,
});

// -- Context --

test("theme, reactivity, reduced motion, layout and settings land on the VisContext fields", () => {
  const decl = declOf("level-glow");
  const settings = { ...defaultSettings(decl), reach: 1.3 };
  const ctx = buildContext(
    decl,
    controls({ theme: "light", reactivity: "calm", reducedMotion: true, layout: "ambient", settings }),
    null,
  );
  assert.equal(ctx.light, true);
  assert.equal(ctx.reactivity, "calm");
  assert.equal(ctx.reducedMotion, true);
  assert.equal(ctx.ambient, true);
  assert.equal(ctx.layout.mask, null);
  assert.deepEqual(ctx.settings, { tint: "cover", reach: 1.3 });
  assert.ok(ctx.colors.ground[0] > 0.9, "a light stage has a light ground");
  assert.equal(buildContext(decl, controls(), null).ambient, false);
});

test("the cover reaches a kind only when it needs one", () => {
  const cover = { close() {} };
  assert.equal(buildContext(declOf("lake"), controls(), cover).cover, cover);
  assert.equal(buildContext(declOf("level-glow"), controls(), cover).cover, null);
});

test("a dark-only kind draws dark in a light theme", () => {
  const decl = { ...declOf("level-glow"), darkOnly: true };
  const ctx = buildContext(decl, controls({ theme: "light" }), null);
  assert.equal(ctx.light, false);
  assert.ok(ctx.colors.ground[0] < 0.2);
  assert.equal(blendOf(decl, "light"), "screen");
});

test("the slot blend is the kind's own: screen, multiply or normal", () => {
  const glow = declOf("level-glow");
  assert.equal(blendOf(glow, "dark"), "screen");
  assert.equal(blendOf(glow, "light"), "multiply");
  const image = declOf("lake");
  assert.equal(blendOf(image, "dark"), "normal");
  assert.equal(blendOf(image, "light"), "normal");
});

test("the init message is one the runtime accepts", () => {
  const decl = declOf("level-glow");
  const init = buildInit(decl, buildContext(decl, controls(), null), true);
  assert.ok(readInit(init));
  assert.deepEqual(init.composite, { light: "ink", dark: "light" });
  assert.deepEqual(init.settingShapes.map((s) => s.id), ["tint", "reach"]);
});

test("an update carries only the fields that changed", () => {
  const decl = declOf("level-glow");
  const ctx = (over) => buildContext(decl, controls(over), null);
  const tracker = createContextTracker(ctx({ settings: defaultSettings(decl) }));
  assert.equal(tracker.diff(ctx({ settings: defaultSettings(decl) })), null);
  const same = { settings: defaultSettings(decl) };
  assert.deepEqual(Object.keys(tracker.diff(ctx({ reactivity: "lively", ...same }))), ["reactivity"]);
  assert.equal(tracker.diff(ctx({ reactivity: "lively", ...same })), null);
  const lit = tracker.diff(ctx({ theme: "light", reactivity: "lively", ...same }));
  assert.deepEqual(Object.keys(lit).sort(), ["colors", "light"]);
  const moved = tracker.diff(ctx({ layout: "compact", theme: "light", reactivity: "lively" }));
  assert.ok("layout" in moved && "settings" in moved);
});

// -- Transport --

function fakePort() {
  const port = { sent: [], closed: false, onmessage: null };
  port.postMessage = (m) => port.sent.push(m);
  port.close = () => (port.closed = true);
  port.hear = (data) => port.onmessage({ data });
  return port;
}

const tick = (seq, dt, beats = 0) => ({
  seq,
  t: seq * dt,
  dt,
  nBeats: beats,
  sig: { ...createFeed({}).next(1, dt).sig, beat: beats ? 0.8 : 0 },
});
const ticksOf = (port) => port.sent.filter((m) => m.type === "tick");

test("at most two ticks are in flight and an ack frees a credit", () => {
  const port = fakePort();
  const transport = createTransport({ port, isVisible: () => true });
  for (let i = 1; i <= 5; i++) transport.offer(tick(i, 0.016));
  assert.equal(ticksOf(port).length, 2);
  assert.equal(transport.stats().outstanding, 2);
  port.hear({ type: "ack", seq: 1, ms: 1.5 });
  assert.equal(ticksOf(port).length, 3);
  assert.equal(transport.stats().lastAckMs, 1.5);
  assert.equal(transport.stats().acked, 1);
});

test("a hidden slot gets no ticks and the first visible one carries the sum", () => {
  const port = fakePort();
  let visible = false;
  const transport = createTransport({ port, isVisible: () => visible });
  transport.offer(tick(1, 0.5, 1));
  transport.offer(tick(2, 0.25, 1));
  assert.equal(ticksOf(port).length, 0);
  assert.equal(transport.stats().withheld, 2);
  visible = true;
  transport.offer(tick(3, 0.25, 0));
  const [sent] = ticksOf(port);
  assert.equal(sent.dt, 1);
  assert.equal(sent.nBeats, 2);
  assert.equal(sent.sig.beat, 0.8, "a one-frame event keeps its max");
});

test("frame messages reach the caller and a dispose closes the port", () => {
  const port = fakePort();
  const heard = [];
  const onFrameMessage = (m) => heard.push(m.type);
  const transport = createTransport({ port, isVisible: () => true, onFrameMessage });
  port.hear({ type: "ready", metered: true });
  port.hear({ type: "nonsense" });
  port.hear({ type: "ack", seq: 1, ms: null });
  assert.deepEqual(heard, ["ready", "ack"]);
  transport.dispose();
  assert.deepEqual(port.sent.at(-1), { type: "dispose" });
  assert.equal(port.closed, true);
  transport.offer(tick(9, 0.01));
  assert.equal(ticksOf(port).length, 0);
});

// -- Feeds --

test("reactivity shapes a feed: Calm zeroes the motion channel, Lively raises it", () => {
  const raw = createFeed({}).next(0, 0.016);
  assert.ok(raw.sig.bassHit > 0 && raw.nBeats === 1);
  const calm = shapeTick(raw, "calm");
  assert.equal(calm.sig.drive, 0);
  assert.equal(calm.sig.beat, 0);
  assert.equal(calm.sig.bassHit, 0);
  assert.equal(calm.nBeats, 0);
  assert.ok(calm.sig.level > 0, "the slow eased level stays");
  const lively = shapeTick(raw, "lively");
  assert.equal(lively.sig.drive, GAIN.lively);
  assert.ok(Math.abs(lively.sig.bassHit - raw.sig.bassHit * 1.6) < 1e-9);
  assert.equal(shapeTick(raw, "balanced").sig.beat, raw.sig.beat);
});

const recorded = (n) =>
  Array.from({ length: n }, (_, i) => {
    const t = createFeed({}).next(0.1 + i * 0.1, 0.1);
    return { ...t, nBeats: i % 2 === 0 ? 1 : 0, sig: { ...t.sig, bands: Array.from(t.sig.bands) } };
  });

test("a recording is read from an array or a ticks object and refused when it is not ticks", () => {
  assert.equal(parseRecording(recorded(3)).length, 3);
  assert.equal(parseRecording({ ticks: recorded(2) }).length, 2);
  assert.throws(() => parseRecording({}), /array of ticks/);
  assert.throws(() => parseRecording([]), /no ticks/);
  assert.throws(() => parseRecording([{ t: 1 }]), /tick 1 needs/);
});

test("a recorded feed folds the ticks a slow frame skips and repeats no event", () => {
  const feed = createRecordedFeed(parseRecording(recorded(8)));
  const first = feed.next(0.15, 0.15);
  assert.equal(first.nBeats, 1, "the tick at 0.1 s fires a beat");
  const same = feed.next(0.16, 0.01);
  assert.equal(same.nBeats, 0);
  assert.equal(same.sig.beat, 0);
  const skipped = feed.next(0.55, 0.39);
  assert.equal(skipped.nBeats, 2, "ticks at 0.3 and 0.5 are both counted");
  assert.equal(skipped.dt, 0.39);
  assert.ok(skipped.seq > first.seq);
});

test("a recorded feed loops", () => {
  const feed = createRecordedFeed(parseRecording(recorded(4)));
  feed.next(0.35, 0.35);
  const wrapped = feed.next(feed.length + 0.15, 0.1);
  assert.ok(wrapped.nBeats >= 1, "the wrap folds the tail and the head");
});

// -- Approximate feed helpers --

test("the audio helpers: bands, level, beats and the wave window", () => {
  const bytes = new Uint8Array(1024).fill(255);
  const bands = logBands(bytes, 44100, 24);
  assert.ok(bands.length === 24 && bands.every((v) => v === 1));
  assert.deepEqual([levelOfRms(0), levelOfRms(1)], [0, 1]);
  const onsets = createOnsetTracker();
  assert.equal(onsets.step(0.5, 1), true);
  assert.equal(onsets.step(0.9, 1.1), false, "at most three beats a second");
  const samples = Float32Array.from({ length: 2048 }, (_, i) => 0.25 * Math.sin(i / 7));
  const wave = waveWindow(samples);
  assert.equal(wave.length, 256);
  assert.ok(Math.abs(Math.max(...wave.map(Math.abs)) - 1) < 1e-6);
});

// -- Server --

/** Starts mock-serve on an ephemeral port; resolves with its base URL, the process and its output. */
function startServe(dir, ...flags) {
  const script = join(KIT, "sdk", "mock-serve.mjs");
  const child = spawn(process.execPath, [script, "0", dir, ...flags], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.stderr.on("data", (d) => (out += d));
    child.stdout.on("data", (d) => {
      out += d;
      const m = out.match(/Mock host: (http:\/\/127\.0\.0\.1:\d+)\//);
      if (m && /\n/.test(out.slice(out.indexOf("Mock host:")))) {
        setTimeout(() => resolve({ base: m[1], child, output: () => out }), 100);
      }
    });
    setTimeout(() => reject(new Error(`mock-serve did not start: ${out}`)), 8000);
  });
}

const stop = (child) => new Promise((done) => (child.once("exit", done), child.kill()));
const fetchStatus = async (url) => {
  const res = await fetch(url);
  return { status: res.status, type: res.headers.get("content-type") ?? "", text: await res.text() };
};

test("the harness page, its modules, the frame origin and the plugin files all answer 200", async () => {
  const { base, child } = await startServe(join(EXAMPLES, "level-glow"));
  try {
    // Every file in the harness folder and every module reachable from it, resolved as the browser would.
    const urls = new Set(readdirSync(HARNESS).map((name) => `${base}/visualizers/harness/${name}`));
    for (const url of urls) {
      if (!/\.m?js$/.test(url)) continue;
      const source = readFileSync(join(KIT, new URL(url).pathname), "utf8");
      for (const m of source.matchAll(/from "(\.[^"]+)"/g)) urls.add(new URL(m[1], url).href);
    }
    for (const url of urls) {
      const res = await fetchStatus(url);
      assert.equal(res.status, 200, url);
      if (/\.m?js$/.test(url)) assert.match(res.type, /text\/javascript/, url);
    }
    const config = JSON.parse((await fetchStatus(`${base}/_plisto/harness.json`)).text);
    assert.deepEqual([config.ok, config.watch], [true, false]);
    assert.equal(config.kinds[0].decl.id, "level-glow");
    assert.notEqual(new URL(config.frameBase).origin, base, "frames live on their own origin");
    const frame = await fetchStatus(config.kinds[0].src);
    assert.equal(frame.status, 200, config.kinds[0].src);
    assert.equal((await fetchStatus(`${config.frameBase}/_plisto/vis/1/plisto-vis.js`)).status, 200);
    assert.equal((await fetchStatus(`${config.frameBase}/vis/glow.frag`)).status, 200);
    assert.equal((await fetchStatus(`${base}/_plisto/watch`)).status, 404, "off unless asked for");
  } finally {
    await stop(child);
  }
});

test("a plugin with no visualizers gets no harness", async () => {
  const { base, child, output } = await startServe(join(KIT, "examples", "hello-ui"));
  try {
    assert.equal((await fetchStatus(`${base}/_plisto/harness.json`)).status, 404);
    assert.doesNotMatch(output(), /Visualizer harness/);
  } finally {
    await stop(child);
  }
});

/** Opens the watch stream and collects the reload events it sends. */
function listen(base) {
  const events = [];
  const req = get(`${base}/_plisto/watch`, (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk) => events.push(...chunk.split("\n\n").filter((e) => e.startsWith("data:"))));
  });
  req.on("error", () => {});
  return { events, close: () => req.destroy() };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("--watch reloads on a change in the plugin folder only, once per burst", async () => {
  const work = mkdtempSync(join(tmpdir(), "plisto-harness-"));
  const plugin = join(work, "plugin");
  cpSync(join(EXAMPLES, "level-glow"), plugin, { recursive: true });
  const { base, child, output } = await startServe(plugin, "--watch");
  const stream = listen(base);
  try {
    assert.match(output(), /Watching/);
    assert.equal(JSON.parse((await fetchStatus(`${base}/_plisto/harness.json`)).text).watch, true);
    await sleep(300);
    writeFileSync(join(work, "outside.txt"), "not the plugin");
    await sleep(700);
    assert.equal(stream.events.length, 0, "a file beside the folder does not reload");
    for (let i = 0; i < 3; i++) writeFileSync(join(plugin, "vis", "glow.frag"), `// edit ${i}\n`);
    await sleep(900);
    assert.equal(stream.events.length, 1, "a burst of writes is one reload");
    assert.equal(stream.events[0], "data: reload");
    writeFileSync(join(plugin, ".hidden-note"), "ignored");
    await sleep(500);
    assert.equal(stream.events.length, 1, "dotfiles do not reload");
  } finally {
    stream.close();
    await stop(child);
    rmSync(work, { recursive: true, force: true });
  }
});

test("the harness files stay within the kit's house limits", () => {
  for (const name of readdirSync(HARNESS)) {
    const text = readFileSync(join(HARNESS, name), "utf8");
    const lines = text.split("\n");
    assert.ok(lines.length <= 400, `${name} has ${lines.length} lines`);
    assert.ok(!text.includes("\r"), `${name} has CRLF`);
    assert.ok(!/[^\x00-\x7F]/.test(text), `${name} has a non-ASCII character`);
  }
});
