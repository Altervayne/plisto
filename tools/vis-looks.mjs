// Records and checks the look of every plugin fixture and kit example through the runtime.
//   node tools/vis-looks.mjs record PORT.json [MORE.json]   writes plugin-kit/visualizers/types/looks-1.json
//   node tools/vis-looks.mjs check  PORT.json [MORE.json ...]   compares the rows with the recorded looks
// Each input is the output of `node tools/visualizer-lab.mjs port` (one file for the GL kinds, another for
// `--kind ridge`) or of `... examples`. A look is the lab's pixel hash per theme and layout, kept beside the
// sha256 of what it was drawn from: the fixture file, or for an example kind (named <folder>/<kind id>) a
// sha256 over its example folder's plugin.json and every file under vis/, as LF text, sorted by path, each
// preceded by its path. Page-only files of a mixed example do not count. A recorded kind whose fixture file
// changed has no look to compare and fails until it is recorded again. With the fixture unchanged, a
// different look fails, unless plugin-kit/visualizers/types/api1-fixes.md lists the kind as a bullet
// (`- <kind>: <reason>`); a listed kind (an example kind with its folder) is reported and accepted. `record`
// replaces the kinds in its inputs and keeps the others.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(ROOT, "plugin-kit/visualizers/fixtures");
const EXAMPLES = join(ROOT, "plugin-kit/visualizers/examples");
const LOOKS = join(ROOT, "plugin-kit/visualizers/types/looks-1.json");
const FIXES = join(ROOT, "plugin-kit/visualizers/types/api1-fixes.md");

const lf = (text) => text.replace(/\r\n/g, "\n");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** The looks in the lab output files, by kind: { "<theme> <layout>": sha256 }. */
function readRows(paths) {
  const byKind = new Map();
  for (const path of paths) {
    const rows = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(rows)) throw new Error(`${path}: expected an array of rows`);
    for (const row of rows) {
      if (!row.kind || !row.theme || !row.layout || !row.sha256) {
        throw new Error(`${path}: a row is not kind, theme, layout and sha256`);
      }
      if (!byKind.has(row.kind)) byKind.set(row.kind, {});
      byKind.get(row.kind)[`${row.theme} ${row.layout}`] = row.sha256;
    }
  }
  return byKind;
}

const fixtureSha = (kind) => sha256(lf(readFileSync(join(FIXTURES, `${kind}.js`), "utf8")));

/** The sha256 over files given as [path, text] pairs: sorted by path, each as path, NUL, LF text, NUL. */
export function filesSha(files) {
  const hash = createHash("sha256");
  for (const [path, text] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    hash.update(`${path}\0${lf(text)}\0`);
  }
  return hash.digest("hex");
}

/** The paths under `dir` of every file, as posix paths relative to `base`. */
function walk(dir, base) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    return e.isDirectory() ? walk(path, base) : [relative(base, path).split(sep).join("/")];
  });
}

/** Whether a kind is an example kind, named <folder>/<kind id>. */
export const isExampleKind = (kind) => kind.includes("/");

/** The sha256 of what an example kind loads: its plugin.json and everything under vis/. */
export function exampleSha(kind) {
  const dir = join(EXAMPLES, kind.split("/")[0]);
  const paths = ["plugin.json", ...walk(join(dir, "vis"), dir)];
  return filesSha(paths.map((p) => [p, readFileSync(join(dir, p), "utf8")]));
}

const keySha = (kind) => (isExampleKind(kind) ? exampleSha(kind) : fixtureSha(kind));

function readRecorded() {
  try {
    return JSON.parse(lf(readFileSync(LOOKS, "utf8")));
  } catch {
    return { api: 1, looks: {} };
  }
}

/** The kinds api1-fixes.md accepts a changed look for. */
function readFixes() {
  let text = "";
  try {
    text = lf(readFileSync(FIXES, "utf8"));
  } catch {
    return new Set();
  }
  return new Set([...text.matchAll(/^- ([a-z0-9/-]+):/gm)].map((m) => m[1]));
}

function record(rows) {
  const recorded = readRecorded();
  for (const [kind, hashes] of rows) {
    recorded.looks[kind] = { fixture: keySha(kind), rows: hashes };
  }
  recorded.looks = Object.fromEntries(Object.entries(recorded.looks).sort(([a], [b]) => (a < b ? -1 : 1)));
  mkdirSync(dirname(LOOKS), { recursive: true });
  writeFileSync(LOOKS, JSON.stringify(recorded, null, 2) + "\n");
  console.log(`recorded ${rows.size} kinds into ${LOOKS} (${Object.keys(recorded.looks).length} in all)`);
}

function check(rows) {
  const recorded = readRecorded();
  const fixes = readFixes();
  const failures = [];
  const accepted = [];
  for (const [kind, was] of Object.entries(recorded.looks)) {
    const now = rows.get(kind);
    if (!now) {
      failures.push(`${kind}: no rows in the input`);
      continue;
    }
    if (keySha(kind) !== was.fixture) {
      failures.push(`${kind}: the fixture changed since its look was recorded, record it again`);
      continue;
    }
    const keys = new Set([...Object.keys(was.rows), ...Object.keys(now)]);
    const moved = [...keys].filter((k) => was.rows[k] !== now[k]);
    if (moved.length === 0) continue;
    if (fixes.has(kind)) accepted.push(`${kind}: ${moved.join(", ")}`);
    else failures.push(`${kind}: the look changed for ${moved.join(", ")}`);
  }
  for (const kind of rows.keys()) {
    if (!(kind in recorded.looks)) failures.push(`${kind}: no recorded look`);
  }
  for (const line of accepted) console.log(`accepted by api1-fixes.md: ${line}`);
  if (failures.length > 0) {
    console.error(`the looks changed:\n- ${failures.join("\n- ")}`);
    process.exit(1);
  }
  console.log(`looks unchanged (${Object.keys(recorded.looks).length} kinds)`);
}

function main() {
  const [mode, ...paths] = process.argv.slice(2);
  if ((mode !== "record" && mode !== "check") || paths.length === 0) {
    console.error("usage: node tools/vis-looks.mjs record|check PORT.json [MORE.json ...]");
    process.exit(2);
  }
  const rows = readRows(paths);
  if (mode === "record") record(rows);
  else check(rows);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
