/*
 * Reads a plugin folder's manifest the way Plisto's installer does, as far as a visualizer plugin needs: the
 * tier, the entry, the capabilities, the `visualizers` block and the files it names. Returns the kinds and
 * the facts the listing rule reads, or the one refusal line Plisto would show. Other fields (id, name,
 * version, icon, sidebar) are Plisto's to check at install.
 */

// -- Library Imports --
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

// -- Local Imports --
import { missingFile, plainFile, validateVisualizers } from "./decl.mjs";
import { Refusal, clip, hasExt, relPathProblem } from "./refusal.mjs";

const MAX_MANIFEST_BYTES = 64 * 1024;
const CAPABILITIES = [
  "storage", "library.read", "playback.read", "playback.control", "network", "background", "ui.toast",
  "ui.confirm", "ui.chips", "ui.sidebar", "audio.tap", "audio.events", "audio.device",
  "audio.output_takeover", "playback.stream", "visualizer", "visualizer.waveform",
];
const AUDIO = ["audio.tap", "audio.events", "audio.device", "audio.output_takeover"];

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

function readCapabilities(raw, tier) {
  if (raw === undefined || raw === null) throw new Refusal("missing required field 'capabilities'");
  if (!Array.isArray(raw) || raw.some((c) => typeof c !== "string")) {
    throw new Refusal("plugin.json is not valid: invalid type for 'capabilities', expected a list");
  }
  const caps = [];
  for (const name of raw) {
    if (!CAPABILITIES.includes(name)) throw new Refusal(`unknown capability '${clip(name)}'`);
    if (caps.includes(name)) throw new Refusal(`capability '${name}' is listed twice`);
    const allowed = tier === "ui" ? !AUDIO.includes(name) : name !== "background";
    if (!allowed) throw new Refusal(`capability '${name}' is not available to ${tier} plugins`);
    caps.push(name);
  }
  return caps;
}

function readEntry(raw, tier, hasSidebar, hasVisualizers) {
  const optional = tier === "ui" && hasVisualizers && !hasSidebar;
  if (raw === undefined || raw === null) {
    if (optional) return null;
    throw new Refusal("missing required field 'entry'");
  }
  if (typeof raw !== "string") {
    throw new Refusal("plugin.json is not valid: invalid type for 'entry', expected string");
  }
  const problem = relPathProblem(raw);
  if (problem) throw new Refusal(`'entry' ${problem}`);
  const ext = tier === "ui" ? ".html" : ".exe";
  if (!hasExt(raw, ext)) throw new Refusal(`a ${tier} plugin's entry must be a ${ext} file`);
  return raw;
}

/** The refusal for the manifest text, or the parsed manifest. */
function parseManifest(bytes) {
  if (bytes.length > MAX_MANIFEST_BYTES) {
    throw new Refusal(`plugin.json is ${bytes.length} bytes, over the ${MAX_MANIFEST_BYTES} byte limit`);
  }
  const text = bytes.toString("utf8").replace(/^\uFEFF/, "");
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    const why = String(e.message).replace(/\p{Cc}/gu, " ").slice(0, 160);
    throw new Refusal(`plugin.json is not valid: ${why}`);
  }
  if (!isObject(json)) throw new Refusal("plugin.json is not valid: invalid type, expected a map");
  return json;
}

/** The result for a manifest and the folder it sits in: `{ ok: true, ... }` or `{ ok: false, refusal }`. */
export function checkManifest(dir) {
  try {
    const meta = lstatSync(dir, { throwIfNoEntry: false });
    if (!meta) throw new Refusal("the plugin folder is missing");
    if (!meta.isDirectory() || meta.isSymbolicLink()) {
      throw new Refusal("the plugin folder is not a plain folder");
    }
    const file = join(dir, "plugin.json");
    const fileMeta = lstatSync(file, { throwIfNoEntry: false });
    if (!fileMeta) throw new Refusal("plugin.json is missing");
    if (!fileMeta.isFile() || fileMeta.isSymbolicLink()) throw new Refusal("plugin.json is not a plain file");
    const json = parseManifest(readFileSync(file));
    return readFacts(dir, json);
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, refusal: e.message };
    throw e;
  }
}

/** Reads the facts out of a parsed manifest. Exported for tests that hold no folder. */
export function readFacts(dir, json) {
  if (json.tier === undefined || json.tier === null) throw new Refusal("missing required field 'tier'");
  if (json.tier !== "ui" && json.tier !== "native") throw new Refusal(`unknown tier '${clip(json.tier)}'`);
  const tier = json.tier;
  const hasSidebar = json.sidebar !== undefined && json.sidebar !== null;
  const hasBlock = json.visualizers !== undefined && json.visualizers !== null;
  const entry = readEntry(json.entry, tier, hasSidebar, hasBlock);
  const caps = readCapabilities(json.capabilities, tier);
  const decls = validateVisualizers(json.visualizers, caps);
  if (decls.length === 0) throw new Refusal("the plugin declares no visualizers");
  if (dir !== null) {
    if (entry !== null && !plainFile(dir, entry)) throw new Refusal("the file named by 'entry' is missing");
    const missing = missingFile(dir, decls);
    if (missing) throw new Refusal(missing);
  }
  return {
    ok: true,
    id: typeof json.id === "string" ? json.id : null,
    name: typeof json.name === "string" ? json.name : null,
    tier,
    caps,
    entry,
    hasSidebar,
    decls,
  };
}
