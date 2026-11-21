// Copies what the kit runs from this repository into the kit, so the kit stands alone, and checks the copies.
//   node tools/kit-sync.mjs build   writes the copies
//   node tools/kit-sync.mjs check   compares the copies with their sources and fails on a stale one
// The protocol module is written as plain JS by the TypeScript compiler, with its types erased. The Edge
// runner gets a one-line header that marks it generated. The lake fixture, which the lake example ships as
// its script, is copied unchanged.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const lf = (text) => text.replace(/\r\n/g, "\n");
const read = (path) => lf(readFileSync(join(ROOT, path), "utf8"));

const HEADER = "// A generated copy of a Plisto source file; do not edit.\n";

function protocolJs() {
  const out = ts.transpileModule(read("src/visRuntime/protocol.ts"), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext, newLine: ts.NewLineKind.LineFeed },
  });
  return HEADER + lf(out.outputText);
}

// Each copy: where it lands (relative to the repository) and how its text is made.
const COPIES = [
  ["plugin-kit/visualizers/lib/protocol.js", protocolJs],
  ["plugin-kit/visualizers/lib/edgeLive.mjs", () => HEADER + read("tools/lib/edgeLive.mjs")],
  ["plugin-kit/visualizers/examples/lake/vis/lake.js", () => read("plugin-kit/visualizers/fixtures/lake.js")],
];

const mode = process.argv[2];
if (mode !== "build" && mode !== "check") {
  console.error("usage: node tools/kit-sync.mjs build|check");
  process.exit(2);
}

let stale = 0;
for (const [path, make] of COPIES) {
  const text = make();
  const file = join(ROOT, path);
  let current = null;
  try {
    current = lf(readFileSync(file, "utf8"));
  } catch {
    // A missing copy is stale.
  }
  if (current === text) continue;
  if (mode === "build") {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    console.log(`kit-sync: wrote ${path}`);
  } else {
    stale++;
    console.error(`kit-sync: ${path} is stale; run npm run kit:sync`);
  }
}
if (mode === "check") {
  if (stale > 0) process.exit(1);
  console.log("kit-sync: copies are current");
}
