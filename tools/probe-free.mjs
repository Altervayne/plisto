// Scans files for strings that exist only in probe code. Probe code is debug-only, so a release
// binary or a dist build must hold none of these markers.
//   node tools/probe-free.mjs <paths>               Exit 1 on any hit, one line per hit.
//   node tools/probe-free.mjs --expect-hit <paths>  Exit 1 unless every marker is found somewhere.
// Paths are files or directories (walked recursively). Each marker is searched as ASCII and as
// UTF-16LE, since minified bundles and Windows binaries carry strings in either form. Exit 2 on a
// usage or read error.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Patterns run over the file bytes read as latin1, one character per byte.
const hex = (s) => [...s].map((c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`).join("");
const wideHex = (s) => hex(Buffer.from(s, "utf16le").toString("latin1"));

function literal(name) {
  return { name, ascii: hex(name), wide: wideHex(name) };
}

const MARKERS = [
  {
    // The wildcard: the literal prefix, printable characters, then the suffix.
    name: "https://probe-*.invalid/*",
    ascii: `${hex("https://probe-")}[\\x21-\\x7e]*?${hex(".invalid/")}`,
    wide: `${wideHex("https://probe-")}(?:[\\x21-\\x7e]\\x00)*?${wideHex(".invalid/")}`,
  },
  // Host names are built from their labels at run time, so the labels are the literals to look for.
  literal("probe-ui0s"),
  literal("probe-vis2"),
  literal("[probe-host]"),
  literal("probe_capture"),
  literal("probe:burst"),
].map((m) => ({
  name: m.name,
  forms: [
    { enc: "ascii", re: new RegExp(m.ascii) },
    { enc: "utf16le", re: new RegExp(m.wide) },
  ],
}));

function collect(path, out) {
  const st = statSync(path);
  if (st.isDirectory()) {
    for (const name of readdirSync(path).sort()) collect(join(path, name), out);
  } else if (st.isFile()) {
    out.push(path);
  }
  return out;
}

const args = process.argv.slice(2);
const expect = args.includes("--expect-hit");
const paths = args.filter((a) => a !== "--expect-hit");

if (paths.length === 0 || paths.some((p) => p.startsWith("--"))) {
  console.error("usage: node tools/probe-free.mjs [--expect-hit] <paths>");
  process.exit(2);
}

let files;
try {
  files = paths.reduce((acc, p) => collect(p, acc), []);
} catch (e) {
  console.error(`probe-free: ${e.message}`);
  process.exit(2);
}

const records = []; // one entry per (file, marker) hit
for (const file of files) {
  const text = readFileSync(file).toString("latin1");
  for (const m of MARKERS) {
    const form = m.forms.find((f) => f.re.test(text));
    if (form) records.push({ file, name: m.name, enc: form.enc });
  }
}

if (expect) {
  let missing = 0;
  for (const m of MARKERS) {
    const hit = records.find((r) => r.name === m.name);
    if (hit) {
      console.log(`found ${m.name} in ${hit.file} (${hit.enc})`);
    } else {
      console.log(`missing ${m.name}`);
      missing += 1;
    }
  }
  process.exit(missing ? 1 : 0);
}

for (const r of records) console.log(`${r.file} ${r.name} (${r.enc})`);
console.log(`probe-free: ${files.length} files scanned, ${records.length} hits`);
process.exit(records.length ? 1 : 0);
