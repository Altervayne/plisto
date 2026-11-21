/*
 * The settings and presets a visualizer kind declares, validated by the same rules and wording as Plisto's
 * manifest parser. A setting without a default starts at its first option, off, its minimum, or the cover.
 */

// -- Local Imports --
import { ID_RULE, Refusal, clip, labelProblem, validKindId } from "./refusal.mjs";

const MAX_SETTINGS = 8;
const MAX_PRESETS = 6;

const bad = (kind, field, reason) => new Refusal(`visualizer '${kind}': '${field}' ${reason}`);
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** The value as the setting holds it, or undefined when the setting cannot take it. */
export function accepts(setting, value) {
  switch (setting.type) {
    case "choice":
      return typeof value === "string" && setting.options.some((o) => o.id === value) ? value : undefined;
    case "toggle":
      return typeof value === "boolean" ? value : undefined;
    case "range":
      return typeof value === "number" && value >= setting.min && value <= setting.max ? value : undefined;
    default:
      return typeof value === "string" && (value === "cover" || /^#[0-9a-fA-F]{6}$/.test(value))
        ? value
        : undefined;
  }
}

function fallback(setting) {
  if (setting.type === "choice") return setting.options[0].id;
  if (setting.type === "toggle") return false;
  if (setting.type === "range") return setting.min;
  return "cover";
}

function innerId(kind, field, id, taken) {
  if (typeof id !== "string") throw bad(kind, `${field}.id`, "is missing");
  if (!validKindId(id)) throw bad(kind, `${field}.id`, ID_RULE);
  if (taken.has(id)) throw bad(kind, `${field}.${id}`, "is listed twice");
  taken.add(id);
  return id;
}

function innerLabel(kind, field, label) {
  if (typeof label !== "string") throw bad(kind, `${field}.label`, "is missing");
  const problem = labelProblem(label);
  if (problem) throw bad(kind, `${field}.label`, problem);
  return label;
}

function parseOptions(kind, field, raw) {
  const list = Array.isArray(raw) ? raw : [];
  if (list.length < 2 || list.length > 8) throw bad(kind, `${field}.options`, "must list 2 to 8 options");
  const taken = new Set();
  return list.map((option, i) => {
    const at = `${field}.options.${i + 1}`;
    const o = isObject(option) ? option : {};
    return { id: innerId(kind, at, o.id, taken), label: innerLabel(kind, at, o.label) };
  });
}

function parseKind(kind, field, raw) {
  if (typeof raw.type !== "string") throw bad(kind, `${field}.type`, "is missing");
  const type = raw.type;
  const hasRange = raw.min !== undefined || raw.max !== undefined || raw.step !== undefined;
  if (type !== "choice" && raw.options !== undefined) {
    throw bad(kind, `${field}.options`, "is only for a choice setting");
  }
  if (type !== "range" && hasRange) throw bad(kind, field, "gives 'min', 'max' or 'step' but is not a range");
  if (type === "choice") return { type, options: parseOptions(kind, field, raw.options) };
  if (type === "toggle" || type === "color") return { type };
  if (type !== "range") throw bad(kind, `${field}.type`, "must be choice, toggle, range or color");
  const { min, max, step } = raw;
  if (![min, max, step].every((n) => typeof n === "number")) {
    throw bad(kind, field, "is a range and must give 'min', 'max' and 'step'");
  }
  if (min >= max) throw bad(kind, `${field}.min`, "must be below 'max'");
  if (step <= 0 || step > max - min) throw bad(kind, `${field}.step`, "must be above 0 and within the range");
  return { type, min, max, step };
}

/** The settings of a kind, each with its default filled in. */
export function validateSettings(kind, raw) {
  if (raw.length > MAX_SETTINGS) {
    throw new Refusal(`visualizer '${kind}' lists more than ${MAX_SETTINGS} settings`);
  }
  const taken = new Set();
  return raw.map((item, i) => {
    const s = isObject(item) ? item : {};
    const id = innerId(kind, `settings.${i + 1}`, s.id, taken);
    const field = `settings.${id}`;
    const label = innerLabel(kind, field, s.label);
    const setting = { id, label, ...parseKind(kind, field, s) };
    if (s.default === undefined || s.default === null) return { ...setting, default: fallback(setting) };
    const value = accepts(setting, s.default);
    if (value === undefined) throw bad(kind, `${field}.default`, "is not a value it takes");
    return { ...setting, default: value };
  });
}

/** The presets of a kind, each value checked against the setting it names. */
export function validatePresets(kind, raw, settings) {
  if (raw.length > MAX_PRESETS) {
    throw new Refusal(`visualizer '${kind}' lists more than ${MAX_PRESETS} presets`);
  }
  const taken = new Set();
  return raw.map((item, i) => {
    const p = isObject(item) ? item : {};
    const id = innerId(kind, `presets.${i + 1}`, p.id, taken);
    const field = `presets.${id}`;
    const label = innerLabel(kind, field, p.label);
    const entries = isObject(p.values) ? Object.entries(p.values) : [];
    if (entries.length === 0) throw bad(kind, `${field}.values`, "must set at least one setting");
    const values = {};
    for (const [key, value] of entries) {
      const at = `${field}.values.${clip(key)}`;
      const setting = settings.find((s) => s.id === key);
      if (!setting) throw bad(kind, at, "names no setting of this visualizer");
      const held = accepts(setting, value);
      if (held === undefined) throw bad(kind, at, "is not a value that setting takes");
      values[key] = held;
    }
    return { id, label, values };
  });
}
