// Freezes the author-facing surface of the plugin visualizer runtime.
//   node tools/vis-surface.mjs build   writes plugin-kit/visualizers/types/surface-1.json
//   node tools/vis-surface.mjs check   compares the runtime with that file
// Each export of src/visRuntime/index.ts is recorded with its type text, and every declared type that text
// reaches with its declaration, read through the TypeScript compiler. Each export that is not a function is
// also recorded with a sha256 of its value, read by evaluating the committed bundle with no window. The
// check fails on a removed export, a changed type or declaration, or a changed value. A new export is
// reported and does not fail: the author types check (surface.typecheck.ts) holds it to the .d.ts.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import ts from "typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(ROOT, "src/visRuntime/index.ts");
const BUNDLE = join(ROOT, "plugin-kit/visualizers/runtime/plisto-vis-1.js");
const SURFACE = join(ROOT, "plugin-kit/visualizers/types/surface-1.json");

const lf = (text) => text.replace(/\r\n/g, "\n");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

// -- Types --

function openProgram() {
  const cfgPath = join(ROOT, "tsconfig.json");
  const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, ROOT);
  return ts.createProgram({ rootNames: [ENTRY], options: { ...parsed.options, noEmit: true } });
}

// A type declared in the repository, as opposed to the language's or a package's own.
function isOwn(program, symbol) {
  const decls = symbol?.declarations ?? [];
  return decls.length > 0 && decls.every((d) => {
    const file = d.getSourceFile();
    return !program.isSourceFileDefaultLibrary(file) && !/[\\/]node_modules[\\/]/.test(file.fileName);
  });
}

// The symbols whose declaration is part of the surface; a function's body is not.
const SF = ts.SymbolFlags;
const DECLARING = SF.Interface | SF.TypeAlias | SF.Class | SF.Enum;

const FORMAT =
  ts.TypeFormatFlags.NoTruncation |
  ts.TypeFormatFlags.InTypeAlias |
  ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;

function readTypes(program, checker, exportTypes) {
  const printer = ts.createPrinter({ removeComments: true });
  const declared = new Map();
  const seen = new Set();

  const record = (symbol) => {
    if (!(symbol.flags & DECLARING) || !isOwn(program, symbol)) return;
    for (const decl of symbol.declarations) {
      const file = decl.getSourceFile();
      const key = `${symbol.name}@${relative(ROOT, file.fileName).replace(/\\/g, "/")}`;
      const text = printer.printNode(ts.EmitHint.Unspecified, decl, file);
      declared.set(key, declared.has(key) ? `${declared.get(key)}\n${text}` : text);
    }
  };

  const visit = (type) => {
    if (seen.has(type)) return;
    seen.add(type);
    if (type.aliasSymbol) record(type.aliasSymbol);
    for (const arg of type.aliasTypeArguments ?? []) visit(arg);
    if (type.isUnionOrIntersection()) {
      type.types.forEach(visit);
      return;
    }
    if (!(type.flags & ts.TypeFlags.Object)) return;
    const symbol = type.symbol;
    if (symbol && !(symbol.flags & ts.SymbolFlags.TypeLiteral)) record(symbol);
    for (const arg of typeArguments(checker, type)) visit(arg);
    // A language or package type is named, never walked into.
    if (symbol && !isOwn(program, symbol)) return;
    for (const prop of checker.getPropertiesOfType(type)) {
      const at = prop.valueDeclaration ?? prop.declarations?.[0] ?? ENTRY_FILE;
      visit(checker.getTypeOfSymbolAtLocation(prop, at));
    }
    for (const sig of type.getCallSignatures()) {
      for (const param of sig.getParameters()) {
        visit(checker.getTypeOfSymbolAtLocation(param, param.valueDeclaration ?? ENTRY_FILE));
      }
      visit(sig.getReturnType());
    }
    for (const info of checker.getIndexInfosOfType(type)) visit(info.type);
  };

  const ENTRY_FILE = program.getSourceFile(ENTRY);
  for (const type of exportTypes) visit(type);
  return Object.fromEntries([...declared].sort(([a], [b]) => (a < b ? -1 : 1)));
}

function typeArguments(checker, type) {
  return type.objectFlags & ts.ObjectFlags.Reference ? checker.getTypeArguments(type) : [];
}

// -- Values --

function loadBundle() {
  const sandbox = { console };
  vm.runInNewContext(lf(readFileSync(BUNDLE, "utf8")), sandbox, { filename: "plisto-vis-1.js" });
  if (!sandbox.plistoVis) throw new Error("the bundle defines no plistoVis");
  return sandbox.plistoVis;
}

// A stable text for a value: sorted keys, typed arrays as number lists, functions as their arity.
function canonical(value) {
  if (typeof value === "function") return `fn/${value.length}`;
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (ArrayBuffer.isView(value)) {
    return `${Object.prototype.toString.call(value)}[${Array.from(value).join(",")}]`;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
}

// -- Surface --

function readSurface() {
  const program = openProgram();
  const checker = program.getTypeChecker();
  const file = program.getSourceFile(ENTRY);
  const moduleSymbol = checker.getSymbolAtLocation(file);
  const runtime = loadBundle();
  const exports = {};
  const types = [];
  for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
    const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    if (!(target.flags & ts.SymbolFlags.Value)) continue;
    if (!(symbol.name in runtime)) throw new Error(`export ${symbol.name} is missing from the bundle`);
    const type = checker.getTypeOfSymbolAtLocation(target, file);
    types.push(type);
    const isFunction = typeof runtime[symbol.name] === "function";
    // A constant's literal type is its value, which the hash already holds.
    const shown = isFunction ? type : checker.getBaseTypeOfLiteralType(type);
    const entry = { type: checker.typeToString(shown, undefined, FORMAT) };
    if (isFunction) entry.kind = "function";
    else {
      entry.kind = "value";
      entry.sha256 = sha256(canonical(runtime[symbol.name]));
    }
    exports[symbol.name] = entry;
  }
  const names = Object.keys(exports).sort();
  const extra = Object.keys(runtime).filter((k) => !(k in exports));
  if (extra.length > 0) throw new Error(`the bundle exports what index.ts does not: ${extra.join(", ")}`);
  return {
    api: runtime.version,
    exports: Object.fromEntries(names.map((n) => [n, exports[n]])),
    types: readTypes(program, checker, types),
  };
}

function compare(recorded, current) {
  const failures = [];
  const added = [];
  for (const [name, was] of Object.entries(recorded.exports)) {
    const now = current.exports[name];
    if (!now) failures.push(`removed export ${name}`);
    else if (now.type !== was.type) {
      failures.push(`changed signature of ${name}\n  was ${was.type}\n  now ${now.type}`);
    }
    else if (now.sha256 !== was.sha256) failures.push(`changed value of ${name}`);
  }
  for (const [key, was] of Object.entries(recorded.types)) {
    if (!(key in current.types)) failures.push(`removed type ${key}`);
    else if (current.types[key] !== was) failures.push(`changed type ${key}`);
  }
  for (const name of Object.keys(current.exports)) if (!(name in recorded.exports)) added.push(name);
  if (recorded.api !== current.api) failures.push(`api ${recorded.api} is now ${current.api}`);
  return { failures, added };
}

function main() {
  const mode = process.argv[2];
  if (mode !== "build" && mode !== "check") {
    console.error("usage: node tools/vis-surface.mjs build|check");
    process.exit(2);
  }
  const current = readSurface();
  const count = Object.keys(current.exports).length;
  if (mode === "build") {
    mkdirSync(dirname(SURFACE), { recursive: true });
    writeFileSync(SURFACE, JSON.stringify(current, null, 2) + "\n");
    console.log(`wrote ${SURFACE} (${count} exports, ${Object.keys(current.types).length} types)`);
    return;
  }
  let recorded;
  try {
    recorded = JSON.parse(lf(readFileSync(SURFACE, "utf8")));
  } catch {
    console.error(`no readable ${SURFACE}, run node tools/vis-surface.mjs build`);
    process.exit(1);
  }
  const { failures, added } = compare(recorded, current);
  if (added.length > 0) console.log(`new exports not recorded yet: ${added.join(", ")}`);
  if (failures.length > 0) {
    console.error(`the api ${current.api} surface changed:\n${failures.map((f) => `- ${f}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`surface unchanged (${count} exports)`);
}

try {
  main();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
