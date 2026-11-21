// Compares two outputs of `node tools/visualizer-lab.mjs hash`, row by row, keyed by kind, theme and layout.
//   node tools/visualizer-hash-diff.mjs a.json b.json
// Prints each differing, missing or extra row and both row counts. Exits 1 on any difference, 0 when identical.

import { readFileSync } from "node:fs";

const [pathA, pathB] = process.argv.slice(2);
if (!pathA || !pathB) {
  console.error("usage: node tools/visualizer-hash-diff.mjs <a.json> <b.json>");
  process.exit(2);
}

function load(path) {
  const rows = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(rows)) throw new Error(`${path}: expected an array of rows`);
  const map = new Map();
  for (const row of rows) map.set(`${row.kind} ${row.theme} ${row.layout}`, row.sha256);
  return { count: rows.length, map };
}

const a = load(pathA);
const b = load(pathB);
let differences = 0;

for (const [key, hash] of a.map) {
  if (!b.map.has(key)) {
    console.log(`missing in B: ${key}`);
    differences++;
  } else if (b.map.get(key) !== hash) {
    console.log(`differs: ${key}\n  A ${hash}\n  B ${b.map.get(key)}`);
    differences++;
  }
}
for (const key of b.map.keys()) {
  if (!a.map.has(key)) {
    console.log(`extra in B: ${key}`);
    differences++;
  }
}
if (a.count !== b.count) differences++;

console.log(`rows: A ${a.count}, B ${b.count}`);
console.log(differences === 0 ? "identical" : `${differences} difference(s)`);
process.exit(differences === 0 ? 0 : 1);
