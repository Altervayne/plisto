// Writes the kit's feed reference from the author-facing types, and checks that the committed copy is current.
//   node tools/kit-feed.mjs build   writes plugin-kit/visualizers/docs/feed.md
//   node tools/kit-feed.mjs check   regenerates in memory and compares with the committed page
// The members and their types come from plugin-kit/visualizers/types/plisto-vis-1.d.ts through the
// TypeScript parser; the words come from tools/lib/feedMeanings.mjs. A member without a meaning, or a
// meaning without a member, fails the run, so the page cannot lag the types.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { MEANINGS, NOT_FEED, SECTIONS } from "./lib/feedMeanings.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = join(ROOT, "plugin-kit/visualizers/types/plisto-vis-1.d.ts");
const OUT = join(ROOT, "plugin-kit/visualizers/docs/feed.md");

const lf = (text) => text.replace(/\r\n/g, "\n");

// Every interface declared in the `plistoVis` namespace, with its members' names, types and optional marks.
// Method members are read too, so a method added to a feed interface needs a meaning like any field.
function readInterfaces() {
  const sf = ts.createSourceFile(TYPES, lf(readFileSync(TYPES, "utf8")), ts.ScriptTarget.ES2020, true);
  const found = new Map();
  const visit = (node) => {
    if (ts.isInterfaceDeclaration(node)) {
      const members = node.members
        .filter((m) => ts.isPropertySignature(m) || ts.isMethodSignature(m))
        .map((m) => ({
          name: m.name.getText(sf),
          optional: m.questionToken !== undefined,
          type: memberType(m, sf),
        }));
      found.set(node.name.text, members);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

// A property's type text, or a method's parameter list and return type.
function memberType(m, sf) {
  if (ts.isMethodSignature(m)) return m.getText(sf).replace(/\s+/g, " ").replace(/^[^(<]*/, "").replace(/;$/, "");
  return m.type ? m.type.getText(sf).replace(/\s+/g, " ") : "unknown";
}

const cell =(text) => text.replace(/\|/g, "\\|");

function render(interfaces) {
  const problems = [];
  const lines = [
    "# The feed",
    "",
    "This page lists every field a visualizer frame receives and what it means. It is generated from",
    "`types/plisto-vis-1.d.ts`; do not edit it by hand.",
    "",
    "A kind reads these fields in `frame` (raw), in `update` and `uniforms` (scene) and in `draw` (candidate).",
    "A shader kind reads them as uniforms instead; see the [README](../README.md).",
    "",
  ];
  const used = new Set();
  const known = new Set([...SECTIONS.map(([name]) => name), ...NOT_FEED]);
  for (const name of interfaces.keys()) {
    if (!known.has(name)) problems.push(`interface ${name} is in neither SECTIONS nor NOT_FEED`);
  }
  for (const [name, intro] of SECTIONS) {
    const members = interfaces.get(name);
    if (!members) {
      problems.push(`the types declare no interface ${name}`);
      continue;
    }
    lines.push(`## ${name}`, "", intro, "", "| Field | Type | Meaning |", "| --- | --- | --- |");
    for (const m of members) {
      const key = `${name}.${m.name}`;
      used.add(key);
      const meaning = MEANINGS[key];
      if (!meaning) problems.push(`${key} has no meaning`);
      const field = m.optional ? `\`${m.name}?\`` : `\`${m.name}\``;
      lines.push(`| ${field} | \`${cell(m.type)}\` | ${cell(meaning ?? "")} |`);
    }
    lines.push("");
  }
  for (const key of Object.keys(MEANINGS)) {
    if (!used.has(key)) problems.push(`${key} has a meaning but no member`);
  }
  return { text: lines.join("\n").replace(/\n+$/, "\n"), problems };
}

const mode = process.argv[2];
if (mode !== "build" && mode !== "check") {
  console.error("usage: node tools/kit-feed.mjs build|check");
  process.exit(2);
}

const { text, problems } = render(readInterfaces());
if (problems.length > 0) {
  for (const p of problems) console.error(`kit-feed: ${p}`);
  process.exit(1);
}
if (mode === "build") {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, text);
  console.log(`kit-feed: wrote ${OUT}`);
} else {
  let current = "";
  try {
    current = lf(readFileSync(OUT, "utf8"));
  } catch {
    // A missing page is stale.
  }
  if (current !== text) {
    console.error("kit-feed: plugin-kit/visualizers/docs/feed.md is stale; run npm run kit:feed");
    process.exit(1);
  }
  console.log("kit-feed: feed.md is current");
}
