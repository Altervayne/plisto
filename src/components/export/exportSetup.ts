/*
 * The remembered export setup: the last-used choices plus one entry per destination that has been run.
 * Pure and framework-free. The blob is stored as one JSON string under one preference key and parsed
 * per field with a fallback, so a corrupt or older blob never throws and a later field needs only a
 * default. It holds choices only; nothing here describes or changes what an export writes.
 */

// -- Local Imports --
import { DEFAULT_PRESET } from "./templates";

// -- Type Imports --
import type { ExportTarget } from "../../types";
import type { ExportScope } from "./scopeState";
import type { PlaylistShape } from "./ExportSections";

/** Every choice the export screen offers that is worth keeping between visits. */
export interface Setup {
  folder: string;
  file: string;
  albums: boolean;
  singles: boolean;
  playlists: boolean;
  shape: PlaylistShape;
  deviceInPlace: boolean;
  scope: ExportScope;
}

/** A destination that has been run: the setup it ran with, how to reach it again, and when. */
export interface DestEntry {
  setup: Setup;
  target: ExportTarget;
  usedAt: number;
}

/** The last setup, with the destination it was last used on (null when none was picked). */
export interface LastSetup extends Setup {
  target: ExportTarget | null;
}

/** The stored blob. */
export interface Setups {
  v: 1;
  last: LastSetup;
  dests: Record<string, DestEntry>;
}

/** How many destinations are kept; the least recently used fall off first. */
export const MAX_DESTS = 30;

/** The setup a first-ever visit starts from. */
export const DEFAULT_SETUP: Setup = {
  folder: DEFAULT_PRESET.folder,
  file: DEFAULT_PRESET.file,
  albums: true,
  singles: true,
  playlists: false,
  shape: "mimic",
  deviceInPlace: false,
  scope: "all",
};

/** The fields that describe a destination rather than a taste; a new destination starts them at default. */
function withDestinationDefaults(setup: Setup): Setup {
  return { ...setup, scope: DEFAULT_SETUP.scope, deviceInPlace: DEFAULT_SETUP.deviceInPlace };
}

/**
 * The key a destination is filed under, mirroring the export ledger's key: a folder path or a device
 * breadcrumb with separators folded to backslash and lowercased, a device prefixed with `device:`.
 */
export function destKey(target: ExportTarget): string {
  const fold = (s: string) => s.replace(/\//g, "\\").toLowerCase();
  return target.kind === "device" ? `device:${fold(target.target.display)}` : fold(target.path);
}

// ---- Parsing ----

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTarget(value: unknown): ExportTarget | null {
  if (!isRecord(value)) return null;
  if (value.kind === "folder" && typeof value.path === "string" && value.path !== "") {
    return { kind: "folder", path: value.path };
  }
  if (value.kind === "device" && isRecord(value.target)) {
    const { device_name, display, pidl } = value.target;
    if (typeof device_name === "string" && typeof display === "string" && typeof pidl === "string") {
      return { kind: "device", target: { device_name, display, pidl } };
    }
  }
  return null;
}

/** One setup, each field taken from `value` when it has the right type and from `base` otherwise. */
function parseSetup(value: unknown, base: Setup): Setup {
  const v = isRecord(value) ? value : {};
  return {
    folder: typeof v.folder === "string" ? v.folder : base.folder,
    file: typeof v.file === "string" ? v.file : base.file,
    albums: typeof v.albums === "boolean" ? v.albums : base.albums,
    singles: typeof v.singles === "boolean" ? v.singles : base.singles,
    playlists: typeof v.playlists === "boolean" ? v.playlists : base.playlists,
    shape: v.shape === "mimic" || v.shape === "file" ? v.shape : base.shape,
    deviceInPlace: typeof v.deviceInPlace === "boolean" ? v.deviceInPlace : base.deviceInPlace,
    scope: v.scope === "all" || v.scope === "changed" ? v.scope : base.scope,
  };
}

/**
 * Parses the stored blob. Never throws: unreadable input yields the defaults, a bad field falls back
 * on its own, and a destination entry with no usable target is dropped. `layout` seeds the last
 * setup's patterns when the blob has none, so a library that only ever used the plain pattern
 * preferences keeps its layout.
 */
export function parseSetups(
  raw: string | null | undefined,
  layout?: { folder: string; file: string },
): Setups {
  const base: Setup = { ...DEFAULT_SETUP, ...layout };
  let json: unknown = null;
  if (raw) {
    try {
      json = JSON.parse(raw);
    } catch {
      json = null;
    }
  }
  const root = isRecord(json) ? json : {};
  const last = isRecord(root.last) ? root.last : {};
  let dests: Record<string, DestEntry> = {};
  if (isRecord(root.dests)) {
    for (const [key, entry] of Object.entries(root.dests)) {
      // A stored key of __proto__ would reset the map's prototype on assignment.
      if (key === "__proto__" || !isRecord(entry)) continue;
      const target = parseTarget(entry.target);
      if (!target) continue;
      const usedAt = typeof entry.usedAt === "number" && Number.isFinite(entry.usedAt) ? entry.usedAt : 0;
      dests[key] = { setup: parseSetup(entry.setup, base), target, usedAt };
    }
    dests = capped(dests, "");
  }
  return { v: 1, last: { ...parseSetup(last, base), target: parseTarget(last.target) }, dests };
}

// ---- Reading ----

/** Whether this destination has been run before. */
export function hasRecord(setups: Setups, target: ExportTarget): boolean {
  return Object.prototype.hasOwnProperty.call(setups.dests, destKey(target));
}

/**
 * The setup to start a destination on: its own entry when it has been run, otherwise the last setup
 * with scope and device mode back at their defaults.
 */
export function setupFor(setups: Setups, target: ExportTarget): Setup {
  const key = destKey(target);
  if (hasRecord(setups, target)) return setups.dests[key].setup;
  const { target: _target, ...last } = setups.last;
  return withDestinationDefaults(last);
}

/**
 * Settles a setup against the destination it is about to apply to. A dated device snapshot always
 * holds everything, so it cannot carry a changed-only scope, and device mode means nothing for a folder.
 */
export function fitToTarget(setup: Setup, target: ExportTarget | null): Setup {
  const device = target?.kind === "device";
  const deviceInPlace = device && setup.deviceInPlace;
  const scope = device && !deviceInPlace ? "all" : setup.scope;
  return { ...setup, deviceInPlace, scope };
}

/**
 * What picking `target` should show. A destination with a record restores its own setup; a new one
 * keeps what is on screen with scope and device mode back at their defaults.
 */
export function setupOnPick(setups: Setups, target: ExportTarget, current: Setup): Setup {
  const next = hasRecord(setups, target) ? setupFor(setups, target) : withDestinationDefaults(current);
  return fitToTarget(next, target);
}

/** What opening the screen restores. `recorded` is whether the last destination has been run. */
export interface RestorePlan {
  target: ExportTarget | null;
  setup: Setup;
  recorded: boolean;
}

/** A settled restore. `applyLayout` is true only for a recorded destination that passed its check. */
export interface SettledRestore {
  target: ExportTarget | null;
  setup: Setup;
  applyLayout: boolean;
}

/** What opening the screen restores: the last destination to revalidate, and the setup it carries. */
export function restorePlan(setups: Setups): RestorePlan {
  const { target } = setups.last;
  if (!target) {
    const { target: _target, ...last } = setups.last;
    return { target: null, setup: withDestinationDefaults(last), recorded: false };
  }
  return {
    target,
    setup: fitToTarget(setupFor(setups, target), target),
    recorded: hasRecord(setups, target),
  };
}

/**
 * Settles a restore once the destination has been checked. A destination that failed its check stays
 * empty, and the scope and device mode that described it go back to their defaults; the rest holds.
 * The layout follows the destination only when it has a record, since its ledger was written with it.
 */
export function settleRestore(plan: RestorePlan, checkedOk: boolean): SettledRestore {
  if (plan.target && checkedOk) {
    return { target: plan.target, setup: plan.setup, applyLayout: plan.recorded };
  }
  return { target: null, setup: withDestinationDefaults(plan.setup), applyLayout: false };
}

// ---- Writing ----

/** Keeps the `MAX_DESTS` most recently used destinations; `keep` wins a tie so a fresh run is never the one dropped. */
function capped(dests: Record<string, DestEntry>, keep: string): Record<string, DestEntry> {
  const keys = Object.keys(dests);
  if (keys.length <= MAX_DESTS) return dests;
  keys.sort((a, b) => {
    if (dests[a].usedAt !== dests[b].usedAt) return dests[b].usedAt - dests[a].usedAt;
    return a === keep ? -1 : b === keep ? 1 : 0;
  });
  const out: Record<string, DestEntry> = {};
  for (const key of keys.slice(0, MAX_DESTS)) out[key] = dests[key];
  return out;
}

/** Records a run: the setup becomes the last one and the destination's own, stamped `now`. */
export function rememberRun(
  setups: Setups,
  target: ExportTarget,
  setup: Setup,
  now: number,
): Setups {
  const key = destKey(target);
  const dests = { ...setups.dests, [key]: { setup, target, usedAt: now } };
  return { v: 1, last: { ...setup, target }, dests: capped(dests, key) };
}

/**
 * Records a destination pick without a run: the setup and destination become the last ones, and a
 * destination that already has a record gets its reach refreshed (a device's current handle). Its
 * saved setup and date stay as the last run left them.
 */
export function rememberPick(setups: Setups, target: ExportTarget, setup: Setup): Setups {
  const key = destKey(target);
  const dests = hasRecord(setups, target)
    ? { ...setups.dests, [key]: { ...setups.dests[key], target } }
    : setups.dests;
  return { v: 1, last: { ...setup, target }, dests };
}
