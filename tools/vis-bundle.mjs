// Builds the plugin visualizer runtime and checks the committed copy.
//   node tools/vis-bundle.mjs build   writes plugin-kit/visualizers/runtime/plisto-vis-1.js and shader.html
//   node tools/vis-bundle.mjs check   rebuilds in memory and compares with the committed files
// Both refuse a bundle that pulls in an app-only module or carries a UI string from src/i18n, and
// both evaluate it with no window or document, so loading it can never touch the page.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import ts from "typescript";
import { build } from "vite";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "plugin-kit/visualizers/runtime");
const BUNDLE = join(OUT_DIR, "plisto-vis-1.js");
const PAGE_SRC = join(ROOT, "src/visRuntime/shader.html");
const PAGE = join(OUT_DIR, "shader.html");

// Modules the runtime must never carry: the app's UI, its IPC, the built-in registry and the strings.
const BANNED_MODULES = [
  /node_modules[\/](react|react-dom|scheduler|@tauri-apps)[\/]/,
  /src[\/]lib[\/]ipc/,
  /visualizerRegistry/,
  /src[\/]i18n[\/]/,
];

const lf = (text) => text.replace(/\r\n/g, "\n");

async function bundle() {
  const result = await build({
    configFile: join(ROOT, "vite.vis.config.ts"),
    root: ROOT,
    logLevel: "warn",
    build: { write: false },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((r) => r.output);
  const chunk = outputs.find((o) => o.type === "chunk");
  if (!chunk) throw new Error("the build produced no script");
  return { code: lf(chunk.code), modules: chunk.moduleIds ?? Object.keys(chunk.modules) };
}

// The string tables the runtime must not carry from.
const STRING_TABLES = ["src/i18n/en.ts", "src/i18n/fr.ts"];

// Words the tables also hold as search keywords that are names in the runtime's own api: the host's
// `update` message, the frame's `flash` message, the scene pass blend `add` and the log level `debug`.
const API_WORDS = new Set(["update", "flash", "add", "debug"]);

// Every string value in the string tables, found with the TypeScript parser.
function uiStrings() {
  const found = new Set();
  const visit = (node) => {
    const isKey = node.parent !== undefined && ts.isPropertyAssignment(node.parent) && node.parent.name === node;
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && !isKey) found.add(node.text);
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      if (node.text.trim().length >= 12) found.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  for (const table of STRING_TABLES) {
    const path = join(ROOT, table);
    visit(ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true));
  }
  found.delete("");
  return found;
}

function guard({ code, modules }) {
  const problems = [];
  for (const id of modules) {
    if (BANNED_MODULES.some((re) => re.test(id))) problems.push(`bundles ${id}`);
  }
  if (code.includes("visualizerRegistry")) problems.push("names visualizerRegistry");
  for (const text of uiStrings()) {
    if (API_WORDS.has(text)) continue;
    const quoted = [JSON.stringify(text), `'${text}'`, `\`${text}\``];
    if (text.length >= 12 ? code.includes(text) : quoted.some((q) => code.includes(q))) {
      problems.push(`carries the UI string ${JSON.stringify(text)}`);
    }
  }
  if (problems.length > 0) throw new Error(`the runtime bundle ${problems.join("; ")}`);
}

// Loads the script where no page exists: any load-time DOM access throws here.
function evaluate(code) {
  const sandbox = { console };
  vm.runInNewContext(code, sandbox, { filename: "plisto-vis-1.js" });
  const ns = sandbox.plistoVis;
  for (const name of ["shader", "scene", "candidate", "raw"]) {
    if (typeof ns?.[name] !== "function") throw new Error(`plistoVis.${name} is missing after evaluation`);
  }
  return ns;
}

async function main() {
  const mode = process.argv[2];
  if (mode !== "build" && mode !== "check") {
    console.error("usage: node tools/vis-bundle.mjs build|check");
    process.exit(2);
  }
  const out = await bundle();
  guard(out);
  const ns = evaluate(out.code);
  const page = lf(readFileSync(PAGE_SRC, "utf8"));
  const bytes = Buffer.byteLength(out.code);
  if (mode === "build") {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(BUNDLE, out.code);
    writeFileSync(PAGE, page);
    console.log(`wrote ${BUNDLE} (${bytes} bytes, api ${ns.version}) and ${PAGE}`);
    return;
  }
  const stale = [];
  const read = (path) => {
    try {
      return lf(readFileSync(path, "utf8"));
    } catch {
      return null;
    }
  };
  if (read(BUNDLE) !== out.code) stale.push(BUNDLE);
  if (read(PAGE) !== page) stale.push(PAGE);
  if (stale.length > 0) {
    console.error(`out of date, run npm run vis:build: ${stale.join(", ")}`);
    process.exit(1);
  }
  console.log(`runtime bundle up to date (${bytes} bytes, api ${ns.version})`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
