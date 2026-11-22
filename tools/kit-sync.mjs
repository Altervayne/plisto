// Copies what the kit runs from this repository into the kit, so the kit stands alone, and checks the copies.
//   node tools/kit-sync.mjs build   writes the copies
//   node tools/kit-sync.mjs check   compares the copies with their sources and fails on a stale one
// The protocol module is written as plain JS by the TypeScript compiler, with its types erased. The Edge
// runner gets a one-line header that marks it generated. The limits file joins the net limits with the two
// flash-meter constants, so the checker judges a run by the numbers Plisto uses. The lake fixture, which the
// lake example ships as its script, is copied unchanged. The plugin SDK copies the examples ship are verbatim
// too, with no header, so a modder can diff one against the kit's SDK.

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

/** The net limits module as plain JS, followed by the flash-meter limits read from the cell meter. */
function limitsJs() {
  const nets = ts.transpileModule(read("src/state/player/pluginVis/netLimits.ts"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
      newLine: ts.NewLineKind.LineFeed,
    },
  });
  const meter = read("src/components/player/visualizers/flash/cellMeter.ts");
  const lines = ["FLASHES_PER_SEC_LIMIT", "RED_FLASHES_LIMIT"].map((name) => {
    const found = meter.match(new RegExp(`^export const ${name} = ([0-9.]+);`, "m"));
    if (!found) throw new Error(`kit-sync: ${name} not found in cellMeter.ts`);
    return `/** The flash-meter limit of the same name in Plisto. */
export const ${name} = ${found[1]};
`;
  });
  return HEADER + lf(nets.outputText) + lines.join("");
}

const SDK = "plugin-kit/sdk/plisto-sdk.js";
const SDK_COPIES = [
  "plugin-kit/examples/hello-ui/plisto-sdk.js",
  "plugin-kit/examples/hello-background/plisto-sdk.js",
  "plugin-kit/examples/tap-meter/page/plisto-sdk.js",
  "plugin-kit/visualizers/examples/band-tunnel-mixed/plisto-sdk.js",
];

// Each copy: where it lands (relative to the repository) and how its text is made.
const COPIES = [
  ...SDK_COPIES.map((path) => [path, () => read(SDK)]),
  ["plugin-kit/visualizers/lib/protocol.js", protocolJs],
  ["plugin-kit/visualizers/lib/limits.js", limitsJs],
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
