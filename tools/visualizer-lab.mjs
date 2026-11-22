// Drives the dev-only visualizer render lab (visualizer-lab.html) through headless Edge and reads its result.
// The dev server must already be running; this script never starts one. Launch it from PowerShell.
//   node tools/visualizer-lab.mjs hash [OUT.json] [--kind K] [--theme T] [--layout L]
//   node tools/visualizer-lab.mjs port [OUT.json] [--kind K] [--theme T] [--layout L]
//     (hash's rows, drawn from the plugin fixtures; --kind ridge for the raw Ridge port)
//   node tools/visualizer-lab.mjs examples [OUT.json] [--example FOLDER] [--theme T] [--layout L]
//     (port's rows for the kit examples under plugin-kit/visualizers/examples, kind <folder>/<kind id>)
//   node tools/visualizer-lab.mjs port-nets [--kind K] [--theme T] [--layout L] [--from S] [--for S]
//     [--react R] [--track N]  (each fixture played through the runtime: meter, frame ms)
//   node tools/visualizer-lab.mjs thumb [OUT_DIR] [--kind K]
//   node tools/visualizer-lab.mjs bench [--kind K] [--ref K] [--theme T] [--layout L]
//   node tools/visualizer-lab.mjs steps  --kind K [--theme T] [--layout L] [--from S] [--for S] [--react R] [--track N]
//   node tools/visualizer-lab.mjs flash [--kind K] [--red 0|1] [--theme T] [--layout L] [--from S] [--for S] [--react R] [--track N]
//   node tools/visualizer-lab.mjs level  --kind K [--level 0..1] [--theme T] [--layout L]
//   node tools/visualizer-lab.mjs calm   --kind K [--theme T] [--layout L]
//   node tools/visualizer-lab.mjs view [--kind K] [--theme T] [--layout L]    Prints the URL to open.
// Measures take --scene ID (a scene module the registry does not hold; --dark marks it dark-only, --fine says it
// draws from the 128-band spectrum) in place of --kind. Layouts are player, ambient and ambient-side; the measures default to player and ambient-side.
// --from and --for set the song seconds a steps or flash run reads (default: the drop from 34 s, for 10 s).
// --track N plays the dumped real track .ai/lab-tracks/N.json in place of the song (from and for then read
// track seconds, default 0 s for 10 s).
// flash with no kind runs Fireflies' worst case. --json prints the raw result instead of a table.
// Shared flags: --url BASE (default http://localhost:1420), --edge PATH, --gpu or --soft to force the real
// GPU or software GL. Bench and port-nets default to the GPU and every other mode to software GL, so
// hashes and thumbnails do not depend on the machine. Every run is read live over the DevTools protocol
// (real clock, so timings are true) and is bounded by --timeout SECONDS (default 1800). Edge is closed and
// its profile removed however the run ends, Ctrl+C included.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runEdgeLive } from "./lib/edgeLive.mjs";

const [mode, ...rest] = process.argv.slice(2);

const flags = {};
const positional = [];
const SWITCHES = ["gpu", "soft", "json", "dark", "fine"];
for (let i = 0; i < rest.length; i++) {
  if (!rest[i].startsWith("--")) positional.push(rest[i]);
  else if (SWITCHES.includes(rest[i].slice(2))) flags[rest[i].slice(2)] = true;
  else flags[rest[i].slice(2)] = rest[++i];
}

const BASE = flags.url ?? "http://localhost:1420";
const EDGE = flags.edge ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const useGpu = flags.gpu || ((mode === "bench" || mode === "port-nets") && !flags.soft);
const TIMEOUT_MS = Number(flags.timeout ?? 1800) * 1000;
const FORWARDED = [
  "kind", "example", "scene", "theme", "layout", "ref", "red", "level", "from", "for", "react", "track",
];

function labUrl() {
  const q = new URLSearchParams({ mode });
  for (const key of FORWARDED) if (flags[key] !== undefined) q.set(key, flags[key]);
  if (flags.dark) q.set("dark", "1");
  if (flags.fine) q.set("fine", "1");
  return `${BASE}/visualizer-lab.html?${q}`;
}

const SOFTWARE_GL = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"];

/** Runs the lab URL in headless Edge and returns the parsed JSON the page wrote into <pre id="out">. */
async function runLab(url) {
  const text = await runEdgeLive({ edge: EDGE, args: useGpu ? [] : SOFTWARE_GL, url, timeoutMs: TIMEOUT_MS });
  const parsed = JSON.parse(text);
  if (parsed && parsed.error) throw new Error(`lab error: ${parsed.error}`);
  return parsed;
}

function cell(v) {
  return typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
}

/** Prints rows as aligned columns, one per key in first-seen order. */
function printTable(rows) {
  const cols = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  const width = cols.map((c) => Math.max(c.length, ...rows.map((r) => cell(r[c] ?? "").length)) + 2);
  console.log(cols.map((c, i) => c.padEnd(width[i])).join(""));
  for (const r of rows) console.log(cols.map((c, i) => cell(r[c] ?? "").padEnd(width[i])).join(""));
}

/** Prints a measure's result: its text fields as key: value lines, then its rows as a table. */
function printResult(result) {
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const { rows, ...head } = result;
  for (const [k, v] of Object.entries(head)) console.log(`${k}: ${cell(v)}`);
  console.log("");
  printTable(rows);
}

function printBench({ theme, layouts, ref, signal, rows }) {
  if (flags.json) {
    console.log(JSON.stringify({ theme, layouts, ref, signal, rows }, null, 2));
    return;
  }
  const refKey = rows.length > 0 && "refMs" in rows[0] ? "refMs" : "glassMs";
  console.log(`bench: ${layouts.join(" and ")} layout, ${theme} theme, ms per render, ratio to ${ref} (${signal})`);
  console.log("kind".padEnd(16) + "layout".padEnd(14) + "dpr".padEnd(5) + "ms".padEnd(10) + `${ref} ms`.padEnd(14) + "ratio");
  for (const r of rows) {
    console.log(
      r.kind.padEnd(16) + r.layout.padEnd(14) + String(r.dpr).padEnd(5) + r.ms.toFixed(3).padEnd(10) + r[refKey].toFixed(3).padEnd(14) + r.ratio.toFixed(2),
    );
  }
}

const MEASURES = ["steps", "flash", "level", "calm"];

async function main() {
  if (mode === "hash" || mode === "port" || mode === "examples") {
    const rows = await runLab(labUrl());
    const json = JSON.stringify(rows, null, 2) + "\n";
    if (positional[0]) writeFileSync(positional[0], json);
    else process.stdout.write(json);
    console.error(`${rows.length} hashes`);
  } else if (mode === "thumb") {
    const rows = await runLab(labUrl());
    const dir = positional[0] ?? "src/assets/visualizer-thumbs";
    mkdirSync(dir, { recursive: true });
    for (const row of rows) {
      const bytes = Buffer.from(row.dataUrl.split(",")[1], "base64");
      writeFileSync(join(dir, `${row.kind}-${row.theme}.webp`), bytes);
    }
    console.error(`${rows.length} thumbnails in ${dir}`);
  } else if (mode === "bench") {
    printBench(await runLab(labUrl()));
  } else if (mode === "port-nets") {
    printResult(await runLab(labUrl()));
  } else if (MEASURES.includes(mode)) {
    if (mode !== "flash" && !flags.kind && !flags.scene) throw new Error(`${mode} needs --kind or --scene`);
    printResult(await runLab(labUrl()));
  } else if (mode === "view") {
    console.log(labUrl());
  } else {
    const modes = "hash|port|examples|port-nets|thumb|bench|steps|flash|level|calm|view";
    console.error(`usage: visualizer-lab.mjs ${modes} [options]`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
