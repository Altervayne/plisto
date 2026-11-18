// Drives the dev-only visualizer render lab (visualizer-lab.html) through headless Edge and reads its result.
// The dev server must already be running; this script never starts one. Launch it from PowerShell.
//   node tools/visualizer-lab.mjs hash [OUT.json] [--kind K] [--theme T] [--layout L]
//   node tools/visualizer-lab.mjs thumb [OUT_DIR] [--kind K]
//   node tools/visualizer-lab.mjs bench [--kind K] [--ref K] [--theme T] [--layout L]
//   node tools/visualizer-lab.mjs steps  --kind K [--theme T] [--layout L] [--from S] [--for S] [--react R]
//   node tools/visualizer-lab.mjs flash [--kind K] [--red 0|1] [--theme T] [--layout L] [--from S] [--for S] [--react R]
//   node tools/visualizer-lab.mjs level  --kind K [--level 0..1] [--theme T] [--layout L]
//   node tools/visualizer-lab.mjs calm   --kind K [--theme T] [--layout L]
//   node tools/visualizer-lab.mjs view [--kind K] [--theme T] [--layout L]    Prints the URL to open.
// Measures take --scene ID (a scene module the registry does not hold; --dark marks it dark-only, --fine says it
// draws from the 128-band spectrum) in place of --kind. Layouts are player, ambient and ambient-side; the measures default to player and ambient-side.
// --from and --for set the song seconds a steps or flash run reads (default: the drop from 34 s, for 10 s).
// flash with no kind runs Fireflies' worst case. --json prints the raw result instead of a table.
// Shared flags: --url BASE (default http://localhost:1420), --edge PATH, --budget MS (virtual time; each
// mode has a default sized for software GL), --gpu or --soft to force the real GPU or software GL. Bench
// defaults to the GPU and every other mode to software GL, so hashes and thumbnails do not depend on the
// machine. A GPU run is read live over the DevTools protocol (no virtual time, so timings are real) and
// is bounded by --timeout SECONDS (default 1800) instead of the budget; Edge and its profile are removed
// however the run ends, Ctrl+C included.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
const useGpu = flags.gpu || (mode === "bench" && !flags.soft);
// Virtual-time budgets in ms: long reads and software GL need far more than a page that only draws once.
const BUDGETS = { hash: 600000, thumb: 600000, bench: 600000, steps: 3600000, flash: 3600000, level: 3600000, calm: 1800000, view: 5000 };
const BUDGET = flags.budget ?? String(BUDGETS[mode] ?? 60000);
const TIMEOUT_MS = Number(flags.timeout ?? 1800) * 1000;
const FORWARDED = ["kind", "scene", "theme", "layout", "ref", "red", "level", "from", "for", "react"];

function labUrl() {
  const q = new URLSearchParams({ mode });
  for (const key of FORWARDED) if (flags[key] !== undefined) q.set(key, flags[key]);
  if (flags.dark) q.set("dark", "1");
  if (flags.fine) q.set("fine", "1");
  return `${BASE}/visualizer-lab.html?${q}`;
}

function unescapeHtml(s) {
  return s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

const BASE_ARGS = ["--headless=new", "--no-first-run", "--hide-scrollbars", "--force-device-scale-factor=1"];
const SOFTWARE_GL = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"];

function resultOf(parsed) {
  if (parsed && parsed.error) throw new Error(`lab error: ${parsed.error}`);
  return parsed;
}

// Loads the lab URL in headless Edge under a virtual-time budget and returns the JSON the page wrote into <pre id="out">.
function runLabDump(url) {
  const profile = mkdtempSync(join(tmpdir(), "plisto-lab-"));
  const args = [
    ...BASE_ARGS,
    "--dump-dom",
    `--virtual-time-budget=${BUDGET}`,
    `--user-data-dir=${profile}`,
    ...(useGpu ? [] : SOFTWARE_GL),
    url,
  ];
  const run = spawnSync(EDGE, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  rmSync(profile, { recursive: true, force: true });
  if (run.error) throw run.error;
  const m = run.stdout.match(/<pre id="out"[^>]*>([\s\S]*?)<\/pre>/);
  if (!m) {
    throw new Error(
      `the lab wrote no result (exit ${run.status}); is the dev server up at ${BASE}, or does the run need a larger --budget?\n${run.stderr.slice(0, 500)}`,
    );
  }
  return resultOf(JSON.parse(unescapeHtml(m[1])));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Loads the lab URL in headless Edge with a DevTools port and polls the page until it is done. The clock is
// real, so a bench reads true timings. Every wait, protocol calls included, ends at the --timeout deadline,
// when Edge exits, or when the socket closes; the Edge process tree and the profile are removed on every
// exit path, Ctrl+C included.
async function runLabLive(url) {
  const profile = mkdtempSync(join(tmpdir(), "plisto-lab-"));
  const deadline = Date.now() + TIMEOUT_MS;
  let child = null;
  let ws = null;
  const stop = () => {
    ws?.close();
    if (!child || child.pid === undefined) return;
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill("SIGKILL");
  };
  const removeProfile = () => rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  const onInterrupt = () => {
    stop();
    removeProfile();
    process.exit(130);
  };
  process.once("SIGINT", onInterrupt);

  // Rejects when the browser fails to start, exits, or drops the socket.
  let fail = () => {};
  const failed = new Promise((_, reject) => {
    fail = reject;
  });
  failed.catch(() => {});

  /** Awaits `promise`, giving up at the deadline or when the browser goes away. */
  const within = (promise, what) => {
    let timer = null;
    const late = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out waiting for ${what} (--timeout ${TIMEOUT_MS / 1000} s)`)), Math.max(0, deadline - Date.now()));
    });
    return Promise.race([promise, failed, late]).finally(() => clearTimeout(timer));
  };

  /** Polls `read` until it returns something other than null. */
  const until = async (read, what) => {
    for (;;) {
      const v = await within(read(), what);
      if (v !== null && v !== undefined) return v;
      await within(sleep(500), what);
    }
  };

  try {
    child = spawn(
      EDGE,
      [...BASE_ARGS, "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1280,800", ...(useGpu ? [] : SOFTWARE_GL), url],
      { stdio: "ignore" },
    );
    child.on("error", (e) => fail(new Error(`could not start Edge at ${EDGE}: ${e.message}`)));
    child.on("exit", (code) => fail(new Error(`Edge exited early (code ${code})`)));

    // With port 0 the browser picks one and records it in the profile.
    const port = await until(async () => {
      const file = join(profile, "DevToolsActivePort");
      return existsSync(file) ? readFileSync(file, "utf8").split("\n")[0] : null;
    }, "the browser's DevTools port");
    const target = await until(async () => {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        return list.find((t) => t.type === "page" && t.url.includes("visualizer-lab")) ?? null;
      } catch {
        return null;
      }
    }, "the lab page");
    ws = new WebSocket(target.webSocketDebuggerUrl);
    ws.addEventListener("close", () => fail(new Error("the DevTools socket closed")));
    ws.addEventListener("error", () => fail(new Error("the DevTools socket failed")));
    await within(new Promise((resolve) => ws.addEventListener("open", resolve)), "the DevTools socket");
    let id = 0;
    const pending = new Map();
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      }
    });
    const evaluate = (expression) =>
      within(
        new Promise((resolve) => {
          const n = ++id;
          pending.set(n, resolve);
          ws.send(JSON.stringify({ id: n, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
        }),
        "the page to answer",
      );
    const text = await until(async () => {
      const m = await evaluate("document.body && document.body.dataset.done === '1' ? (document.getElementById('out') || {}).textContent || '' : null");
      return m.result?.result?.value ?? null;
    }, "the lab to finish");
    if (text === "") throw new Error("the lab finished without a result");
    return resultOf(JSON.parse(text));
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    stop();
    await sleep(500);
    removeProfile();
  }
}

async function runLab(url) {
  return useGpu ? runLabLive(url) : runLabDump(url);
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
  if (mode === "hash") {
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
  } else if (MEASURES.includes(mode)) {
    if (mode !== "flash" && !flags.kind && !flags.scene) throw new Error(`${mode} needs --kind or --scene`);
    printResult(await runLab(labUrl()));
  } else if (mode === "view") {
    console.log(labUrl());
  } else {
    console.error("usage: visualizer-lab.mjs hash|thumb|bench|steps|flash|level|calm|view [options]");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
