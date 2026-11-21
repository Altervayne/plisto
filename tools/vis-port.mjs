// Ports the built-in GL visualizer kinds to plugin fixtures and checks that the fixtures are current.
//   node tools/vis-port.mjs build   writes plugin-kit/visualizers/fixtures/<kind>.js for every GL kind
//   node tools/vis-port.mjs check   regenerates in memory and compares with the committed fixtures
// A fixture is the kind's scene module with its types stripped, its imports bound from the runtime's
// `plistoVis` namespace and its factory registered through `plistoVis.candidate` with the program list the
// views entry names. Rewrites, all by the TypeScript parser: `f.mirrored` becomes
// `f.settings.layout === "mirrored"`; Fireflies' flash probe and its `uPin` uniform are dropped. A scene the
// rewrite cannot port fails the run with the scene named, and is never patched by hand. `ridge.js` is
// written by hand and is left alone. Each fixture also runs once against the committed runtime bundle in
// node, which catches a name the bundle lacks and any top-level code that throws.

import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import ts from "typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VISUALIZERS = join(ROOT, "src/components/player/visualizers");
const GL = join(VISUALIZERS, "gl");
const VIEWS = join(VISUALIZERS, "visualizerViews.tsx");
const OUT = join(ROOT, "plugin-kit/visualizers/fixtures");
const BUNDLE = join(ROOT, "plugin-kit/visualizers/runtime/plisto-vis-1.js");
const SURFACE = join(ROOT, "plugin-kit/visualizers/types/surface-1.json");
const HAND_WRITTEN = ["ridge.js"];

const KINDS = [
  "terrain", "warp", "nebula", "bloom", "halftone", "dot-spectrum", "dot-cover", "liquid", "ink", "mercury",
  "silk", "pond", "glass", "train", "record", "snowfall", "latte", "fireflies", "window", "lake",
  "neon-highway", "server-room", "circuit-board", "oscilloscope", "hologram", "gravitational-waves",
  "ringed-planet", "station", "solar-flare", "event-horizon",
];

// What a scene carries only for the lab, which a plugin has no use for.
const DROPS = {
  fireflies: { statements: ["fireflyProbe"], lines: /uPin/ },
};

const lf = (text) => text.replace(/\r\n/g, "\n");
const camel = (id) => id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

class PortError extends Error {}

// -- The views entry --

// Each kind's factory and program list identifiers, and the scene module they are imported from.
function readViews() {
  const sf = ts.createSourceFile(VIEWS, lf(readFileSync(VIEWS, "utf8")), ts.ScriptTarget.ES2020, true);
  const from = new Map();
  let table = null;
  for (const st of sf.statements) {
    const bound = ts.isImportDeclaration(st) ? st.importClause?.namedBindings : undefined;
    if (bound && ts.isNamedImports(bound)) {
      for (const el of bound.elements) from.set(el.name.text, st.moduleSpecifier.text);
    }
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        const init = d.initializer;
        if (d.name.getText() === "VISUALIZER_VIEWS" && init && ts.isObjectLiteralExpression(init)) table = init;
      }
    }
  }
  if (!table) throw new PortError("visualizerViews.tsx has no VISUALIZER_VIEWS table");
  const views = new Map();
  for (const prop of table.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isObjectLiteralExpression(prop.initializer)) continue;
    const key = ts.isStringLiteral(prop.name) ? prop.name.text : prop.name.getText();
    const field = (name) => {
      const isNamed = (q) => ts.isPropertyAssignment(q) && q.name.getText() === name;
      const p = prop.initializer.properties.find(isNamed);
      return p && ts.isIdentifier(p.initializer) ? p.initializer.text : null;
    };
    views.set(key, { factory: field("factory"), programs: field("programs"), from });
  }
  return views;
}

// -- One scene --

function applyEdits(text, edits) {
  let out = text;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}

function portKind(kind, view, exportsOf) {
  const fail = (why) => {
    throw new PortError(`${kind}: ${why}`);
  };
  if (!view?.factory || !view.programs) fail("the views entry names no factory or program list");
  const module = camel(kind);
  const spec = view.from.get(view.factory);
  if (spec !== `./gl/${module}`) fail(`the factory comes from ${spec}, not ./gl/${module}`);
  const file = join(GL, `${module}.ts`);
  let text = lf(readFileSync(file, "utf8"));
  const drop = DROPS[kind];
  if (drop) text = text.split("\n").filter((line) => !drop.lines.test(line)).join("\n");

  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2020, true);
  const edits = [];
  const bindings = [];
  const declared = new Set();
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) {
      edits.push({ start: st.getStart(), end: st.end, text: "" });
      const clause = st.importClause;
      if (!clause || clause.isTypeOnly) continue;
      const named = clause.namedBindings;
      if (clause.name || !named || !ts.isNamedImports(named)) fail("an import is not a list of names");
      for (const el of named.elements) {
        if (el.isTypeOnly) continue;
        const imported = (el.propertyName ?? el.name).text;
        if (!exportsOf.has(imported)) {
          fail(`it imports ${imported} from ${st.moduleSpecifier.text}, which plistoVis does not export`);
        }
        bindings.push(imported === el.name.text ? imported : `${imported}: ${el.name.text}`);
      }
      continue;
    }
    if (ts.isExportDeclaration(st) || ts.isExportAssignment(st)) {
      fail("it has an export that is not a declaration");
    }
    const modifiers = ts.canHaveModifiers(st) ? ts.getModifiers(st) : undefined;
    const exported = modifiers?.find((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (exported) edits.push({ start: exported.getStart(), end: exported.end + 1, text: "" });
    const names = ts.isVariableStatement(st)
      ? st.declarationList.declarations.map((d) => d.name.getText())
      : [];
    if (ts.isFunctionDeclaration(st) && st.name) names.push(st.name.text);
    names.forEach((name) => declared.add(name));
    if (drop?.statements.some((name) => names.includes(name))) {
      edits.push({ start: st.getFullStart(), end: st.end, text: "" });
    }
  }
  if (!declared.has(view.factory)) fail(`${view.factory} is not declared in gl/${module}.ts`);
  if (!declared.has(view.programs)) fail(`${view.programs} is not declared in gl/${module}.ts`);

  const visit = (node) => {
    const access = ts.isPropertyAccessExpression(node);
    if (access && node.name.text === "mirrored" && ts.isIdentifier(node.expression)) {
      const text = `(${node.expression.text}.settings.layout === "mirrored")`;
      edits.push({ start: node.getStart(), end: node.end, text });
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  const out = ts.transpileModule(applyEdits(text, edits), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
      removeComments: true,
      newLine: ts.NewLineKind.LineFeed,
    },
    reportDiagnostics: true,
    fileName: `${module}.ts`,
  });
  if (out.diagnostics?.length) {
    fail(ts.flattenDiagnosticMessageText(out.diagnostics[0].messageText, "\n"));
  }
  const body = lf(out.outputText).trim();
  if (/^\s*(import|export)\b/m.test(body)) fail("an import or export is left after the rewrite");
  if (drop && /uPin|fireflyProbe/.test(body)) fail("a dropped probe is still referenced");
  const names = bindings.length > 0 ? `const { ${bindings.join(", ")} } = plistoVis;\n` : "";
  const content =
    `// ${kind}: generated by tools/vis-port.mjs from gl/${module}.ts; do not edit.\n` +
    `(() => {\n${names}${body}\n` +
    `plistoVis.candidate(${view.factory}, { programs: ${view.programs} });\n})();\n`;
  if (/[^\x00-\x7f]/.test(content)) fail("the port carries a non-ASCII character");
  return content;
}

// -- Smoke run --

function loadRuntime() {
  const sandbox = { console };
  vm.runInNewContext(lf(readFileSync(BUNDLE, "utf8")), sandbox, { filename: "plisto-vis-1.js" });
  return sandbox.plistoVis;
}

// Runs a fixture against the committed runtime with registration captured, so nothing mounts.
function smoke(kind, content, runtime) {
  const registered = [];
  const stub = { ...runtime, candidate: (factory, options) => registered.push({ factory, options }) };
  try {
    vm.runInNewContext(content, { plistoVis: stub, console }, { filename: `${kind}.js` });
  } catch (e) {
    throw new PortError(`${kind}: the fixture fails when it loads: ${e instanceof Error ? e.message : e}`);
  }
  const [only] = registered;
  const programs = only?.options?.programs;
  const whole = registered.length === 1 && typeof only.factory === "function";
  if (!whole || !Array.isArray(programs) || programs.length === 0) {
    throw new PortError(`${kind}: the fixture must register one factory with a program list`);
  }
  for (const p of programs) {
    if ([p.name, p.vs, p.fs].some((v) => typeof v !== "string")) {
      throw new PortError(`${kind}: a program is not name, vs and fs`);
    }
  }
}

// -- Run --

function generate() {
  const surface = JSON.parse(readFileSync(SURFACE, "utf8"));
  const exportsOf = new Set(Object.keys(surface.exports));
  const views = readViews();
  const runtime = loadRuntime();
  const made = new Map();
  for (const kind of KINDS) {
    const content = portKind(kind, views.get(kind), exportsOf);
    smoke(kind, content, runtime);
    made.set(`${kind}.js`, content);
  }
  return made;
}

function main() {
  const mode = process.argv[2];
  if (mode !== "build" && mode !== "check") {
    console.error("usage: node tools/vis-port.mjs build|check");
    process.exit(2);
  }
  const made = generate();
  if (mode === "build") {
    mkdirSync(OUT, { recursive: true });
    for (const [name, content] of made) writeFileSync(join(OUT, name), content);
    console.log(`wrote ${made.size} fixtures to ${OUT}`);
    return;
  }
  const problems = [];
  const present = new Set(readdirSync(OUT));
  for (const [name, content] of made) {
    if (!present.has(name)) problems.push(`missing ${name}`);
    else if (lf(readFileSync(join(OUT, name), "utf8")) !== content) problems.push(`out of date ${name}`);
  }
  for (const name of present) {
    if (!made.has(name) && !HAND_WRITTEN.includes(name)) problems.push(`unexpected ${name}`);
  }
  for (const name of HAND_WRITTEN) {
    if (!present.has(name)) problems.push(`missing ${name}`);
  }
  if (problems.length > 0) {
    const list = problems.join("\n- ");
    console.error(`the fixtures are not current, run node tools/vis-port.mjs build:\n- ${list}`);
    process.exit(1);
  }
  console.log(`fixtures up to date (${made.size} ported, ${HAND_WRITTEN.length} by hand)`);
}

try {
  main();
} catch (e) {
  console.error(e instanceof PortError ? `cannot port ${e.message}` : e instanceof Error ? e.stack : e);
  process.exit(1);
}
