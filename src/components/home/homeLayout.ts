/*
 * The Home bento's layout engine: the pure rules that turn a saved layout string into a validated box
 * list and the mutations arrange applies. Framework-free and deterministic, so the hook and the tests
 * read one source. Every box is single-instance - its type is its identity, so a layout never holds a
 * type twice. Parsing is defensive: a stale or hand-edited pref never renders a broken Home, it falls
 * back to the mode's seed.
 */

// -- Unit Imports --
import { BOX_CATALOG, SIZE_SPAN, seedLayout } from "./boxCatalog";

// -- Type Imports --
import type { BoxSeed, BoxSize, BoxType } from "./boxCatalog";
import type { AppMode } from "../../state/player/store";

/** Whether a string names a real box type in the catalog. */
function isBoxType(value: unknown): value is BoxType {
  return typeof value === "string" && value in BOX_CATALOG;
}

/** A box's size clamped to the ones its type allows: an out-of-range size lands on the type's default. */
function clampSize(type: BoxType, size: unknown): BoxSize {
  const spec = BOX_CATALOG[type];
  return spec.allowedSizes.includes(size as BoxSize) ? (size as BoxSize) : spec.size;
}

// Old single-letter size codes, mapped to their footprint so a layout saved before the cols x rows
// system reads back at the same shape. clampSize then enforces each box's own legality on the result.
const LEGACY_SIZE: Record<string, BoxSize> = { S: "1x1", M: "2x1", T: "2x2", L: "2x2" };

/**
 * The saved layout for a mode, validated. An absent or unparseable string falls back to the mode's seed.
 * A parsed list is filtered against the catalog: unknown types drop, a repeated type keeps only its first
 * placement, and a size the type disallows clamps to its default. A stored EMPTY list is a deliberate
 * clear and stays empty - the user removed every box. An all-invalid list (entries that every one fail
 * validation, a stale or corrupt pref) does fall back to the seed, so a broken pref never strands the Home.
 */
export function parseLayout(json: string | undefined, mode: AppMode): BoxSeed[] {
  if (!json) return seedLayout(mode);

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return seedLayout(mode);
  }
  if (!Array.isArray(raw)) return seedLayout(mode);
  // A deliberately-cleared layout stands; only a broken pref (entries that all fail validation, below)
  // re-seeds. Without this an empty layout can never persist - it re-seeds itself on the next read.
  if (raw.length === 0) return [];

  const seen = new Set<BoxType>();
  const layout: BoxSeed[] = [];
  for (const entry of raw) {
    const type = (entry as { type?: unknown })?.type;
    if (!isBoxType(type) || seen.has(type)) continue;
    seen.add(type);
    const rawSize = (entry as { size?: unknown }).size;
    const size = typeof rawSize === "string" && rawSize in LEGACY_SIZE ? LEGACY_SIZE[rawSize] : rawSize;
    layout.push({ type, size: clampSize(type, size) });
  }

  return layout.length > 0 ? layout : seedLayout(mode);
}

/** The layout as its persisted string. */
export function serializeLayout(layout: BoxSeed[]): string {
  return JSON.stringify(layout);
}

/** Moves `fromType` to `toType`'s position, sliding the rest along: a forward move lands after the
 *  target, a backward move on it, so a drop lands where the pointer left it. A no-op when either is absent. */
export function reorderLayout(layout: BoxSeed[], fromType: BoxType, toType: BoxType): BoxSeed[] {
  const from = layout.findIndex((box) => box.type === fromType);
  const to = layout.findIndex((box) => box.type === toType);
  if (from < 0 || to < 0 || from === to) return [...layout];

  // Insert at the target's original index. Once the box is pulled out, a forward target has shifted back
  // one, so this seats it after the target; a backward target is untouched, so it seats before it.
  const next = [...layout];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** Sets a box's size, clamped to the sizes its type allows. A no-op when the type is absent. */
export function resizeLayout(layout: BoxSeed[], type: BoxType, size: BoxSize): BoxSeed[] {
  return layout.map((box) => (box.type === type ? { type, size: clampSize(type, size) } : box));
}

/** Drops a box from the layout. */
export function removeBox(layout: BoxSeed[], type: BoxType): BoxSeed[] {
  return layout.filter((box) => box.type !== type);
}

/** Appends a box at its default size. A no-op when the type is already placed - boxes are single-instance. */
export function addBox(layout: BoxSeed[], type: BoxType): BoxSeed[] {
  if (layout.some((box) => box.type === type)) return [...layout];
  return [...layout, { type, size: BOX_CATALOG[type].size }];
}

/**
 * The allowed size whose footprint sits closest to a target column and row count, by squared span
 * distance. A drag-resize reads its target cells from the pointer, then snaps here so the box always
 * lands on a size the grid can place.
 */
export function nearestAllowedSize(type: BoxType, cols: number, rows: number): BoxSize {
  const allowed = BOX_CATALOG[type].allowedSizes;
  let best = allowed[0];
  let bestDist = Infinity;
  for (const size of allowed) {
    const span = SIZE_SPAN[size];
    const dist = (span.cols - cols) ** 2 + (span.rows - rows) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = size;
    }
  }
  return best;
}

/** The size after a box's current one in its allowed range, wrapping past the last back to the first. */
export function cycleSize(layout: BoxSeed[], type: BoxType): BoxSeed[] {
  const box = layout.find((entry) => entry.type === type);
  if (!box) return [...layout];
  const allowed = BOX_CATALOG[type].allowedSizes;
  const next = allowed[(allowed.indexOf(box.size) + 1) % allowed.length];
  return resizeLayout(layout, type, next);
}
