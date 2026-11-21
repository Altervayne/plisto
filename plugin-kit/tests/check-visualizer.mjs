/*
 * Tests for the visualizer checker's pure parts: the manifest rules and their refusal wording, the listing
 * rule, the files a kind names, the judging of a run by Plisto's limits, the scripted feed and the command
 * line. No browser starts. Run: node --test plugin-kit/tests/check-visualizer.mjs. The file name avoids the
 * .test suffix so the app's Vitest run does not collect it.
 */

// -- Library Imports --
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// -- Local Imports --
import { parseArgs } from "../visualizers/check-visualizer.mjs";
import { BEAT_SECONDS, createFeed } from "../visualizers/lib/check/feed.js";
import { judgeFlash, judgeHang, judgeSlow, median } from "../visualizers/lib/check/judge.mjs";
import { listingOf } from "../visualizers/lib/check/listing.mjs";
import { checkManifest, readFacts } from "../visualizers/lib/check/manifest.mjs";
import { exitCodeFor } from "../visualizers/lib/check/report.mjs";
import {
  FLASHES_PER_SEC_LIMIT,
  HANG_LIMIT_MS,
  RED_FLASHES_LIMIT,
  SLOW_FRAME_LIMIT_MS,
  SLOW_SPAN_MS,
} from "../visualizers/lib/limits.js";

const kind = (over = {}) => ({
  id: "glow",
  name: "Glow",
  api: 1,
  shader: "vis/glow.frag",
  look: "glow",
  ...over,
});
const manifest = (over = {}) => ({
  manifest_version: 1,
  id: "dev.example.glow",
  name: "Glow",
  version: "1.0.0",
  tier: "ui",
  capabilities: ["visualizer"],
  min_plisto: "2.8.0",
  author: "Test",
  visualizers: [kind()],
  ...over,
});
const refusal = (json) => {
  try {
    readFacts(null, json);
  } catch (e) {
    return e.message;
  }
  return null;
};
const withKind = (over) => refusal(manifest({ visualizers: [kind(over)] }));

// -- Manifest rules --

test("a plain shader kind passes and its look expands", () => {
  const facts = readFacts(null, manifest());
  assert.equal(facts.decls.length, 1);
  assert.deepEqual(facts.decls[0].look.dark, { composite: "light", blend: "screen" });
  assert.deepEqual(facts.decls[0].look.light, { composite: "ink", blend: "multiply" });
});

test("the block and the capability come together", () => {
  assert.equal(
    refusal(manifest({ capabilities: ["storage"] })),
    "a 'visualizers' block requires the 'visualizer' capability",
  );
  const bare = manifest({ visualizers: undefined, entry: "index.html" });
  assert.equal(refusal(bare), "the 'visualizer' capability requires a 'visualizers' block");
  assert.equal(
    refusal(manifest({ capabilities: ["visualizer.waveform"] })),
    "the 'visualizer.waveform' capability requires the 'visualizer' capability",
  );
});

test("the count of kinds is 1 to 8", () => {
  assert.equal(refusal(manifest({ visualizers: [] })), "'visualizers' must list 1 to 8 visualizers, found 0");
  const nine = Array.from({ length: 9 }, (_, i) => kind({ id: `k${i}` }));
  assert.equal(
    refusal(manifest({ visualizers: nine })),
    "'visualizers' must list 1 to 8 visualizers, found 9",
  );
});

test("ids, names and api follow the installer's wording", () => {
  assert.equal(
    withKind({ id: "Glow" }),
    "visualizer id 'Glow' must be 1 to 24 characters of a-z, 0-9 and '-'",
  );
  assert.equal(withKind({ id: undefined }), "visualizer 1 is missing 'id'");
  assert.equal(withKind({ name: "" }), "visualizer 'glow': 'name' must not be empty");
  assert.equal(withKind({ name: "x".repeat(25) }), "visualizer 'glow': 'name' is over 24 characters");
  assert.equal(withKind({ name: "a\u200Bb" }), "visualizer 'glow': 'name' contains control characters");
  assert.equal(withKind({ api: 2 }), "visualizer 'glow' asks for api 2; this Plisto runs api 1");
  assert.equal(withKind({ api: undefined }), "visualizer 1 is missing 'api'");
});

test("ids and aliases share one namespace", () => {
  const twice = manifest({ visualizers: [kind(), kind({ id: "other", aliases: ["glow"] })] });
  assert.equal(refusal(twice), "visualizer id or alias 'glow' is used twice");
  assert.equal(
    withKind({ aliases: ["a", "b", "c", "d", "e"] }),
    "visualizer 'glow' lists more than 4 aliases",
  );
  assert.equal(
    withKind({ aliases: ["Bad"] }),
    "visualizer 'glow': 'aliases.Bad' must be 1 to 24 characters of a-z, 0-9 and '-'",
  );
});

test("exactly one of page or shader, with a safe path and the right extension", () => {
  assert.equal(
    withKind({ page: "vis/a.html" }),
    "visualizer 'glow' must give exactly one of 'page' or 'shader'",
  );
  assert.equal(
    withKind({ shader: undefined }),
    "visualizer 'glow' must give exactly one of 'page' or 'shader'",
  );
  assert.equal(
    withKind({ shader: "vis/glow.txt" }),
    "visualizer 'glow': 'shader' must be a .frag or .glsl file",
  );
  assert.equal(
    withKind({ shader: undefined, page: "vis/a.js" }),
    "visualizer 'glow': 'page' must be a .html file",
  );
  assert.equal(
    withKind({ shader: "../glow.frag" }),
    "visualizer 'glow': 'shader' must not contain '.' or '..' segments",
  );
  assert.equal(withKind({ shader: "/glow.frag" }), "visualizer 'glow': 'shader' must be relative");
  assert.equal(withKind({ shader: "vis\\glow.frag" }), "visualizer 'glow': 'shader' must use '/' separators");
  assert.equal(
    withKind({ shader: "_plisto/glow.frag" }),
    "visualizer 'glow': 'shader' must not start with the reserved '_plisto' folder",
  );
  assert.equal(
    withKind({ shader: "vis/nul.frag" }),
    "visualizer 'glow': 'shader' a segment is a reserved Windows device name",
  );
});

test("look is glow, image or a pair per theme", () => {
  assert.equal(withKind({ look: undefined }), "visualizer 1 is missing 'look'");
  assert.equal(
    withKind({ look: "dim" }),
    "visualizer 'glow': 'look' must be \"glow\", \"image\" or a 'light' and 'dark' pair",
  );
  const dark = { composite: "light", blend: "screen" };
  const pair = (composite, blend) => ({ light: { composite, blend }, dark });
  assert.equal(
    withKind({ look: pair("neon", "screen") }),
    "visualizer 'glow': 'look' has a composite that is not light, ink or image",
  );
  assert.equal(
    withKind({ look: pair("ink", "blurry") }),
    "visualizer 'glow': 'look' has a blend that is not a CSS mix-blend-mode keyword",
  );
  assert.equal(withKind({ look: pair("ink", "multiply") }), null);
});

test("needs.waveform asks for its capability", () => {
  assert.equal(
    withKind({ needs: { waveform: true } }),
    "visualizer 'glow' needs the waveform, which requires 'visualizer.waveform'",
  );
  const ok = manifest({
    capabilities: ["visualizer", "visualizer.waveform"],
    visualizers: [kind({ needs: { waveform: true } })],
  });
  assert.equal(refusal(ok), null);
});

test("settings: types, defaults and limits", () => {
  const setting = (over) => withKind({ settings: [{ id: "tint", label: "Tint", type: "color", ...over }] });
  assert.equal(setting({}), null);
  assert.equal(
    setting({ default: "red" }),
    "visualizer 'glow': 'settings.tint.default' is not a value it takes",
  );
  assert.equal(
    setting({ type: "slider" }),
    "visualizer 'glow': 'settings.tint.type' must be choice, toggle, range or color",
  );
  assert.equal(
    setting({ options: [] }),
    "visualizer 'glow': 'settings.tint.options' is only for a choice setting",
  );
  assert.equal(
    setting({ id: "Tint" }),
    "visualizer 'glow': 'settings.1.id' must be 1 to 24 characters of a-z, 0-9 and '-'",
  );
  assert.equal(
    setting({ type: "range", min: 1, max: 0, step: 1 }),
    "visualizer 'glow': 'settings.tint.min' must be below 'max'",
  );
  assert.equal(
    setting({ type: "range", min: 0, max: 1 }),
    "visualizer 'glow': 'settings.tint' is a range and must give 'min', 'max' and 'step'",
  );
  assert.equal(
    setting({ type: "choice", options: [{ id: "a", label: "A" }] }),
    "visualizer 'glow': 'settings.tint.options' must list 2 to 8 options",
  );
  const nine = Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, label: "S", type: "toggle" }));
  assert.equal(withKind({ settings: nine }), "visualizer 'glow' lists more than 8 settings");
});

test("presets name settings and give values they take", () => {
  const settings = [{ id: "reach", label: "Reach", type: "range", min: 0, max: 2, step: 0.1, default: 1 }];
  const preset = (values) => withKind({ settings, presets: [{ id: "far", label: "Far", values }] });
  assert.equal(preset({ reach: 1.5 }), null);
  assert.equal(
    preset({ reach: 3 }),
    "visualizer 'glow': 'presets.far.values.reach' is not a value that setting takes",
  );
  assert.equal(
    preset({ depth: 1 }),
    "visualizer 'glow': 'presets.far.values.depth' names no setting of this visualizer",
  );
  assert.equal(preset({}), "visualizer 'glow': 'presets.far.values' must set at least one setting");
});

test("capabilities and tier", () => {
  assert.equal(
    refusal(manifest({ capabilities: ["visualizer", "sparkle"] })),
    "unknown capability 'sparkle'",
  );
  assert.equal(
    refusal(manifest({ capabilities: ["visualizer", "visualizer"] })),
    "capability 'visualizer' is listed twice",
  );
  assert.equal(
    refusal(manifest({ capabilities: ["visualizer", "audio.tap"] })),
    "capability 'audio.tap' is not available to ui plugins",
  );
  assert.equal(refusal(manifest({ tier: "cloud" })), "unknown tier 'cloud'");
  assert.equal(refusal(manifest({ capabilities: undefined })), "missing required field 'capabilities'");
});

test("an entry is optional only for a ui plugin with kinds and no sidebar", () => {
  assert.equal(refusal(manifest({ sidebar: { items: [] } })), "missing required field 'entry'");
  assert.equal(refusal(manifest({ entry: "index.txt" })), "a ui plugin's entry must be a .html file");
  assert.equal(refusal(manifest({ entry: "index.html" })), null);
});

// -- The files a kind names --

test("a kind whose file is missing is refused, and a present one passes", () => {
  const dir = mkdtempSync(join(tmpdir(), "plisto-kit-check-test-"));
  try {
    writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest()));
    assert.deepEqual(
      checkManifest(dir),
      { ok: false, refusal: "the file named by 'shader' of visualizer 'glow' is missing" },
    );
    mkdirSync(join(dir, "vis"));
    writeFileSync(join(dir, "vis", "glow.frag"), "void main() {}");
    assert.equal(checkManifest(dir).ok, true);
    writeFileSync(join(dir, "plugin.json"), "{ not json");
    assert.match(checkManifest(dir).refusal, /^plugin\.json is not valid: /);
    rmSync(join(dir, "plugin.json"));
    assert.deepEqual(checkManifest(dir), { ok: false, refusal: "plugin.json is missing" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- Listing --

test("a plain visualizer plugin is listed in Visualizers only", () => {
  const capabilities = ["visualizer", "storage", "playback.read", "library.read"];
  const facts = readFacts(null, manifest({ capabilities }));
  assert.deepEqual(listingOf(facts), { listing: "catalog", reasons: [] });
});

test("each thing outside the stage puts the plugin in the Plugins list too", () => {
  const listed = (over) => listingOf(readFacts(null, manifest(over)));
  assert.equal(listed({ entry: "index.html" }).listing, "plugins");
  assert.match(listed({ entry: "index.html" }).reasons[0], /page of its own/);
  assert.match(listed({ sidebar: { items: [] }, entry: "index.html" }).reasons.join(), /sidebar/);
  assert.match(
    listed({ capabilities: ["visualizer", "network"], network: ["https://example.com"] }).reasons[0],
    /'network'/,
  );
  assert.match(listed({ capabilities: ["visualizer", "ui.toast"] }).reasons[0], /'ui.toast'/);
  assert.match(listed({ capabilities: ["visualizer", "playback.control"] }).reasons[0], /'playback.control'/);
  assert.match(listed({ tier: "native", entry: "plugin.exe" }).reasons[0], /tier is 'native'/);
});

// -- Limits --

test("the limits are the ones Plisto holds", () => {
  assert.deepEqual(
    [FLASHES_PER_SEC_LIMIT, RED_FLASHES_LIMIT, HANG_LIMIT_MS, SLOW_FRAME_LIMIT_MS, SLOW_SPAN_MS],
    [3, 0, 2000, 50, 5000],
  );
});

test("flashing is over 3 a second, red is any, and an unmetered kind is not judged", () => {
  const read = (flashesPerSec, redFlashesPerSec) => ({ flashesPerSec, redFlashesPerSec, area: 0.5 });
  assert.equal(judgeFlash([read(3, 0)], true).flashing, false);
  assert.equal(judgeFlash([read(1, 0), read(3.1, 0)], true).flashing, true);
  const red = judgeFlash([read(0, 0.5)], true);
  assert.equal(red.red, true);
  assert.equal(red.flashing, false);
  assert.equal(judgeFlash([read(9, 9)], false).judged, false);
  const quiet = judgeFlash([], true);
  const figures = [quiet.judged, quiet.flashing, quiet.flashesPerSec, quiet.redFlashesPerSec];
  assert.deepEqual(figures, [true, false, null, null]);
});

test("a kind that stops answering is hung", () => {
  const every = (ms, n) => Array.from({ length: n }, (_, i) => ({ at: (i + 1) * ms, ms: 1 }));
  assert.equal(judgeHang(every(16, 600), 9600).hung, false);
  assert.equal(judgeHang([], 5000).hung, true);
  assert.equal(judgeHang([{ at: 100, ms: 1 }], 5000).hung, true);
  const gapped = [...every(16, 100), { at: 1600 + 2100, ms: 1 }];
  assert.equal(judgeHang(gapped, 4000).hung, true);
  assert.equal(judgeHang([{ at: 1900, ms: 1 }], 2000).hung, false);
});

test("slow is a median step over 50 ms held across 5 s", () => {
  const run = (ms, count, step = 100) =>
    Array.from({ length: count }, (_, i) => ({ at: i * step, ms: ms(i) }));
  assert.equal(judgeSlow(run(() => 60, 100)).slow, true);
  assert.equal(judgeSlow(run(() => 40, 100)).slow, false);
  // A spike of slow steps shorter than the span does not move the median over it.
  const spike = run((i) => (i >= 20 && i < 30 ? 200 : 5), 120);
  assert.equal(judgeSlow(spike).slow, false);
  // A short run is one window.
  assert.equal(judgeSlow(run(() => 80, 10)).slow, true);
  assert.equal(judgeSlow(run(() => null, 10)).slow, false);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
});

test("exit codes: passed, failed, flashing only", () => {
  assert.equal(exitCodeFor([{ pass: true, flashing: false }]), 0);
  assert.equal(exitCodeFor([{ pass: true, flashing: true }]), 3);
  assert.equal(exitCodeFor([{ pass: false, flashing: true }]), 1);
  assert.equal(exitCodeFor([{ pass: true, flashing: false }, { pass: false, flashing: false }]), 1);
});

// -- Feed and command line --

test("the feed ticks once per frame with a beat on a steady tempo", () => {
  const feed = createFeed({ fine: true, waveform: true, pointer: true });
  const dt = 1 / 60;
  let beats = 0;
  let last = 0;
  for (let i = 0; i < 600; i++) {
    const tick = feed.next(i * dt, dt);
    assert.equal(tick.seq, i + 1);
    assert.equal(tick.sig.bands.length, 24);
    assert.equal(tick.fine.length, 128);
    assert.equal(tick.wave.length, 256);
    beats += tick.nBeats;
    last = tick.beatAt;
  }
  assert.equal(beats, Math.round(10 / BEAT_SECONDS));
  assert.ok(last > 9);
  const bare = createFeed({}).next(0, dt);
  assert.deepEqual([bare.fine, bare.wave, bare.pointer], [null, null, null]);
});

test("the command line takes one folder and its options", () => {
  const args = parseArgs(["folder", "--kind", "glow", "--seconds", "4", "--json"]);
  assert.equal(args.kind, "glow");
  assert.equal(args.seconds, 4);
  assert.equal(args.json, true);
  assert.equal(parseArgs(["folder"]).seconds, 10);
  assert.throws(() => parseArgs([]), /exactly one plugin folder/);
  assert.throws(() => parseArgs(["a", "--seconds", "0"]), /--seconds/);
  assert.throws(() => parseArgs(["a", "--nope"]), /unknown or incomplete option/);
});
