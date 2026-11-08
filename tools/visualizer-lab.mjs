// Drives the dev-only visualizer render lab (visualizer-lab.html) through headless Edge and reads its result.
// The dev server must already be running; this script never starts one.
//   node tools/visualizer-lab.mjs hash [OUT.json] [--kind K] [--theme T] [--layout L]
//   node tools/visualizer-lab.mjs thumb [OUT_DIR] [--kind K]
//   node tools/visualizer-lab.mjs bench [--kind K] [--theme T] [--layout L]
//   node tools/visualizer-lab.mjs flash [--theme T] [--layout L]    Fireflies' WCAG flash percentages.
//   node tools/visualizer-lab.mjs view [--kind K] [--theme T] [--layout L]    Prints the URL to open.
// Shared flags: --url BASE (default http://localhost:1420), --edge PATH, --budget MS (virtual time, default
// 60000), --gpu or --soft to force the real GPU or software GL. Bench defaults to the GPU and every other
// mode to software GL, so hashes and thumbnails do not depend on the machine.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [mode, ...rest] = process.argv.slice(2);

const flags = {};
const positional = [];
for (let i = 0; i < rest.length; i++) {
  if (!rest[i].startsWith("--")) positional.push(rest[i]);
  else if (rest[i] === "--gpu") flags.gpu = true;
  else if (rest[i] === "--soft") flags.soft = true;
  else flags[rest[i].slice(2)] = rest[++i];
}

const BASE = flags.url ?? "http://localhost:1420";
const EDGE = flags.edge ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const useGpu = flags.gpu || (mode === "bench" && !flags.soft);
const BUDGET = flags.budget ?? "60000";

function labUrl() {
  const q = new URLSearchParams({ mode });
  for (const key of ["kind", "theme", "layout"]) if (flags[key]) q.set(key, flags[key]);
  return `${BASE}/visualizer-lab.html?${q}`;
}

function unescapeHtml(s) {
  return s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

// Loads the lab URL in headless Edge and returns the JSON the page wrote into <pre id="out">.
function runLab(url) {
  const profile = mkdtempSync(join(tmpdir(), "plisto-lab-"));
  const args = [
    "--headless=new",
    "--dump-dom",
    `--virtual-time-budget=${BUDGET}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    ...(useGpu ? [] : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]),
    url,
  ];
  const run = spawnSync(EDGE, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  rmSync(profile, { recursive: true, force: true });
  if (run.error) throw run.error;
  const m = run.stdout.match(/<pre id="out"[^>]*>([\s\S]*?)<\/pre>/);
  if (!m) throw new Error(`the lab wrote no result (exit ${run.status}); is the dev server up at ${BASE}?\n${run.stderr.slice(0, 500)}`);
  const result = JSON.parse(unescapeHtml(m[1]));
  if (result && result.error) throw new Error(`lab error: ${result.error}`);
  return result;
}

if (mode === "hash") {
  const rows = runLab(labUrl());
  const json = JSON.stringify(rows, null, 2) + "\n";
  if (positional[0]) writeFileSync(positional[0], json);
  else process.stdout.write(json);
  console.error(`${rows.length} hashes`);
} else if (mode === "thumb") {
  const rows = runLab(labUrl());
  const dir = positional[0] ?? "src/assets/visualizer-thumbs";
  mkdirSync(dir, { recursive: true });
  for (const row of rows) {
    const bytes = Buffer.from(row.dataUrl.split(",")[1], "base64");
    writeFileSync(join(dir, `${row.kind}-${row.theme}.webp`), bytes);
  }
  console.error(`${rows.length} thumbnails in ${dir}`);
} else if (mode === "bench") {
  const { theme, layout, rows } = runLab(labUrl());
  console.log(`bench: ${layout} layout, ${theme} theme, ms per render and ratio to Glass`);
  console.log("kind".padEnd(14) + "dpr".padEnd(5) + "ms".padEnd(10) + "glass ms".padEnd(10) + "ratio");
  for (const r of rows) {
    console.log(r.kind.padEnd(14) + String(r.dpr).padEnd(5) + r.ms.toFixed(3).padEnd(10) + r.glassMs.toFixed(3).padEnd(10) + r.ratio.toFixed(2));
  }
} else if (mode === "flash") {
  const rows = runLab(labUrl());
  console.log("flash: Fireflies at its blink floor vs the full swell, level at maximum (limit 25%)");
  console.log("layout".padEnd(10) + "theme".padEnd(8) + "stage %".padEnd(10) + "worst 341x256 window %");
  for (const r of rows) console.log(r.layout.padEnd(10) + r.theme.padEnd(8) + String(r.stagePct).padEnd(10) + r.windowPct);
} else if (mode === "view") {
  console.log(labUrl());
} else {
  console.error("usage: visualizer-lab.mjs hash|thumb|bench|flash|view [options]");
  process.exit(1);
}
