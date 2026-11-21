/*
 * The `visualizers` block of a plugin manifest, validated by the same rules and wording as Plisto's manifest
 * parser, plus the check of the files each kind names. The block and the `visualizer` capability come
 * together. Composite and blend stay apart: the composite is how the runtime tone-maps the scene, the blend
 * is the CSS blend put on the slot.
 */

// -- Library Imports --
import { lstatSync } from "node:fs";
import { join } from "node:path";

// -- Local Imports --
import { ID_RULE, Refusal, clip, hasExt, labelProblem, relPathProblem, validKindId } from "./refusal.mjs";
import { validatePresets, validateSettings } from "./settings.mjs";

const MAX_VISUALIZERS = 8;
const MAX_ALIASES = 4;
const SUPPORTED_API = 1;
const LOOK_SHAPE = "must be \"glow\", \"image\" or a 'light' and 'dark' pair";
const BLENDS = [
  "normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn", "hard-light",
  "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity", "plus-lighter",
];
const COMPOSITES = ["light", "ink", "image"];

/** A look that is refused, with the reason Plisto gives. */
class LookReason extends Error {}

const bad = (kind, field, reason) => new Refusal(`visualizer '${kind}': '${field}' ${reason}`);
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** A field of one kind that holds the wrong JSON type: Plisto reports it as an unreadable manifest. */
function typed(value, type, field) {
  if (value === undefined || value === null || typeof value === type) return value ?? undefined;
  throw new Refusal(`plugin.json is not valid: invalid type for '${field}', expected ${type}`);
}

function checkFile(path, exts, wrongType) {
  const problem = relPathProblem(path);
  if (problem) return problem;
  if (path.split("/")[0].toLowerCase() === "_plisto") {
    return "must not start with the reserved '_plisto' folder";
  }
  return exts.some((ext) => hasExt(path, ext)) ? null : wrongType;
}

function parsePair(theme) {
  if (!isObject(theme)) throw new LookReason(LOOK_SHAPE);
  if (!COMPOSITES.includes(theme.composite)) {
    throw new LookReason("has a composite that is not light, ink or image");
  }
  if (!BLENDS.includes(theme.blend)) {
    throw new LookReason("has a blend that is not a CSS mix-blend-mode keyword");
  }
  return { composite: theme.composite, blend: theme.blend };
}

function parseLook(look) {
  if (look === "glow") {
    return { light: { composite: "ink", blend: "multiply" }, dark: { composite: "light", blend: "screen" } };
  }
  if (look === "image") {
    return { light: { composite: "image", blend: "normal" }, dark: { composite: "image", blend: "normal" } };
  }
  if (!isObject(look)) throw new LookReason(LOOK_SHAPE);
  return { light: parsePair(look.light), dark: parsePair(look.dark) };
}

function validateOne(index, raw, caps) {
  const missing = (field) => new Refusal(`visualizer ${index + 1} is missing '${field}'`);
  if (!isObject(raw)) {
    throw new Refusal("plugin.json is not valid: invalid type for 'visualizers', expected object");
  }
  const id = typed(raw.id, "string", "id");
  if (id === undefined) throw missing("id");
  if (!validKindId(id)) throw new Refusal(`visualizer id '${clip(id)}' ${ID_RULE}`);
  const name = typed(raw.name, "string", "name");
  if (name === undefined) throw missing("name");
  const nameProblem = labelProblem(name);
  if (nameProblem) throw bad(id, "name", nameProblem);
  const api = typed(raw.api, "number", "api");
  if (api === undefined) throw missing("api");
  if (api !== SUPPORTED_API) {
    throw new Refusal(`visualizer '${id}' asks for api ${api}; this Plisto runs api ${SUPPORTED_API}`);
  }
  const page = typed(raw.page, "string", "page");
  const shader = typed(raw.shader, "string", "shader");
  if ((page === undefined) === (shader === undefined)) {
    throw new Refusal(`visualizer '${id}' must give exactly one of 'page' or 'shader'`);
  }
  const fileProblem =
    page === undefined
      ? checkFile(shader, [".frag", ".glsl"], "must be a .frag or .glsl file")
      : checkFile(page, [".html"], "must be a .html file");
  if (fileProblem) throw bad(id, page === undefined ? "shader" : "page", fileProblem);
  if (raw.look === undefined || raw.look === null) throw missing("look");
  let look;
  try {
    look = parseLook(raw.look);
  } catch (e) {
    if (!(e instanceof LookReason)) throw e;
    throw bad(id, "look", e.message);
  }
  const needs = isObject(raw.needs) ? raw.needs : {};
  const flag = (key) => needs[key] === true;
  if (flag("waveform") && !caps.includes("visualizer.waveform")) {
    throw new Refusal(`visualizer '${id}' needs the waveform, which requires 'visualizer.waveform'`);
  }
  const aliases = Array.isArray(raw.aliases) ? raw.aliases : [];
  if (aliases.length > MAX_ALIASES) {
    throw new Refusal(`visualizer '${id}' lists more than ${MAX_ALIASES} aliases`);
  }
  const badAlias = aliases.find((a) => typeof a !== "string" || !validKindId(a));
  if (badAlias !== undefined) throw bad(id, `aliases.${clip(badAlias)}`, ID_RULE);
  const settings = validateSettings(id, Array.isArray(raw.settings) ? raw.settings : []);
  const presets = validatePresets(id, Array.isArray(raw.presets) ? raw.presets : [], settings);
  return {
    id,
    name,
    api,
    page: page ?? null,
    shader: shader ?? null,
    look,
    fillsStage: raw.fills_stage === true,
    darkOnly: raw.dark_only === true,
    needs: { fine: flag("fine"), cover: flag("cover"), pointer: flag("pointer"), waveform: flag("waveform") },
    aliases,
    settings,
    presets,
  };
}

/**
 * The kinds of the block, or a Refusal. `raw` is the manifest's `visualizers` value (undefined when absent)
 * and `caps` its validated capability names. Ids and aliases share one namespace across the plugin.
 */
export function validateVisualizers(raw, caps) {
  const draws = caps.includes("visualizer");
  if (caps.includes("visualizer.waveform") && !draws) {
    throw new Refusal("the 'visualizer.waveform' capability requires the 'visualizer' capability");
  }
  const absent = raw === undefined || raw === null;
  if (absent && !draws) return [];
  if (absent) throw new Refusal("the 'visualizer' capability requires a 'visualizers' block");
  if (!draws) throw new Refusal("a 'visualizers' block requires the 'visualizer' capability");
  const list = Array.isArray(raw) ? raw : [];
  if (list.length === 0 || list.length > MAX_VISUALIZERS) {
    throw new Refusal(`'visualizers' must list 1 to ${MAX_VISUALIZERS} visualizers, found ${list.length}`);
  }
  const taken = new Set();
  return list.map((item, index) => {
    const decl = validateOne(index, item, caps);
    for (const id of [decl.id, ...decl.aliases]) {
      if (taken.has(id)) throw new Refusal(`visualizer id or alias '${id}' is used twice`);
      taken.add(id);
    }
    return decl;
  });
}

/** Whether `rel` is a plain file inside `dir`, reached through plain folders only (no link on the way). */
export function plainFile(dir, rel) {
  const parts = rel.split("/");
  let path = dir;
  for (let i = 0; i < parts.length; i++) {
    path = join(path, parts[i]);
    try {
      const meta = lstatSync(path);
      const last = i === parts.length - 1;
      if (meta.isSymbolicLink() || !(last ? meta.isFile() : meta.isDirectory())) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** The refusal for the first kind whose page or shader file is missing or not plain, or null. */
export function missingFile(dir, decls) {
  for (const decl of decls) {
    for (const field of ["page", "shader"]) {
      if (decl[field] !== null && !plainFile(dir, decl[field])) {
        return `the file named by '${field}' of visualizer '${decl.id}' is missing`;
      }
    }
  }
  return null;
}
