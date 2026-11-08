// Captures and guards the visualizer picker thumbnails in src/assets/visualizer-thumbs.
//   node tools/visualizer-thumbs.mjs capture [--kind K] [lab flags]   Renders the stills through the lab, updates manifest.json.
//   node tools/visualizer-thumbs.mjs rehash K...            Re-records hashes for kinds whose stills still match their source.
//   node tools/visualizer-thumbs.mjs check                 Fails when a kind's source hash differs from the manifest.
// Capture needs the dev server running and forwards its flags (for example --url) to visualizer-lab.mjs.
// A kind's hash covers its renderer file, the local modules that file imports, and the shared lab scene.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "src/assets/visualizer-thumbs");
const MANIFEST = join(DIR, "manifest.json");
const VIS = "src/components/player/visualizers";

// Files every kind's still depends on.
const SHARED = [
  `${VIS}/gl/renderer.ts`,
  `${VIS}/visualizerPalette.ts`,
  "src/dev/visualizerLab/labScene.ts",
  "src/dev/visualizerLab/labMusic.ts",
  "src/styles/tokens.css",
];

// Ridge is composed by the lab page itself, so the page is part of its source.
const RIDGE_FILES = [
  "src/components/player/SpectrumRidge.tsx",
  "src/components/player/SpectrumRidge.module.css",
  "src/dev/visualizerLab/main.tsx",
];

/** Every kind id, read from the registry source so the list has one owner. */
function kindIds() {
  const src = readFileSync(join(ROOT, "src/state/player/visualizerRegistry.ts"), "utf8");
  return [...src.matchAll(/^\s+id: "([a-z-]+)",$/gm)].map((m) => m[1]);
}

function camel(id) {
  return id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/** The file plus the relative modules it imports, transitively. */
function closure(entry, seen = new Set()) {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const text = readFileSync(join(ROOT, entry), "utf8");
  for (const m of text.matchAll(/from "(\.[^"]+)"/g)) {
    const base = join(dirname(entry), m[1]).split("\\").join("/");
    const hit = [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((f) => existsSync(join(ROOT, f)));
    if (hit) closure(hit, seen);
  }
  return seen;
}

function sourceFiles(kind) {
  if (kind === "ridge") return new Set([...RIDGE_FILES, ...SHARED.slice(2)]);
  const files = closure(`${VIS}/gl/${camel(kind)}.ts`);
  for (const f of SHARED) files.add(f);
  return files;
}

/** SHA-256 over the sorted files, with line endings normalized so the hash is the same on every checkout. */
function hashKind(kind) {
  const h = createHash("sha256");
  for (const f of [...sourceFiles(kind)].sort()) {
    h.update(f + "\n");
    h.update(readFileSync(join(ROOT, f), "utf8").replace(/\r\n/g, "\n"));
  }
  return h.digest("hex");
}

function currentHashes() {
  return Object.fromEntries(kindIds().map((k) => [k, hashKind(k)]));
}

const [mode, ...rest] = process.argv.slice(2);

if (mode === "capture") {
  // One lab run per kind keeps each page short. --kind K captures just that kind.
  const lab = join(ROOT, "tools/visualizer-lab.mjs");
  const at = rest.indexOf("--kind");
  const only = at >= 0 ? rest[at + 1] : null;
  const passthrough = at >= 0 ? rest.filter((_, i) => i !== at && i !== at + 1) : rest;
  const kinds = only ? [only] : kindIds();
  const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")) : {};
  for (const kind of kinds) {
    const run = spawnSync(process.execPath, [lab, "thumb", DIR, "--kind", kind, ...passthrough], { stdio: "inherit" });
    if (run.status !== 0) process.exit(run.status ?? 1);
    manifest[kind] = hashKind(kind);
    writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  }
  console.log(`captured ${kinds.length} kinds`);
} else if (mode === "rehash") {
  // Records the current source hash for kinds whose stills are known to match it, without recapturing.
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  for (const kind of rest) manifest[kind] = hashKind(kind);
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
} else if (mode === "check") {
  const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")) : {};
  const stale = [];
  for (const [kind, hash] of Object.entries(currentHashes())) {
    if (manifest[kind] !== hash) stale.push(kind);
    for (const theme of ["light", "dark"]) {
      if (!existsSync(join(DIR, `${kind}-${theme}.webp`))) stale.push(`${kind}-${theme}.webp (missing)`);
    }
  }
  if (stale.length > 0) {
    console.error(`stale thumbnails: ${stale.join(", ")}\nrun: npm run thumbs -- --url http://localhost:1420`);
    process.exit(1);
  }
  console.log("thumbnails are current");
} else {
  console.error("usage: visualizer-thumbs.mjs capture|check");
  process.exit(1);
}
