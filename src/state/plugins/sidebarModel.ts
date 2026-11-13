/*
 * What a plugin's sidebar items show, as pure code: the per-key coalescing that keeps the rail calm, and
 * the table that turns a declared item plus its live state into one view. The clock is an argument, so
 * the timeline is testable without timers. A change of appearance is paced slower than a change of
 * content, so a plugin can never blink a row. Plisto never draws a value the plugin did not set: an item
 * with no live state falls back to its rest form.
 */

// -- Type Imports --
import type { PluginChip, PluginItemState, PluginSidebarEvent, PluginSidebarItem, PluginTone } from "../../types";
import type { FramePhase } from "./frameModel";

/** The least gap between two visible changes of one key, in ms. */
export const COALESCE_MS = 500;

/** The least gap between two changes of a key's appearance (tone, visibility, switch state), in ms. */
export const APPEARANCE_MS = 2000;

/** How long a toggle stays pending without a confirming update, in ms. */
export const TOGGLE_PENDING_MS = 3000;

/** The coalescing key of one item. */
export const itemKey = (pluginId: string, itemId: string): string => `${pluginId}|${itemId}`;

/** The coalescing key of one plugin's chips. */
export const chipsKey = (pluginId: string): string => `${pluginId}|chips`;

/**
 * What a state looks like apart from its content: visibility, tone, switch and enabled state, whether a
 * progress bar sweeps, and the number and tone of chips. Two values with the same signature differ only
 * in content (text, a determinate value, a chip's text or count).
 */
export function appearanceSig(event: PluginSidebarEvent): string {
  if (event.kind === "chips") return `chips:${event.chips.map((chip) => chip.tone).join(",")}`;
  const s = event.state;
  const head = `${s.type}:${s.visible ? 1 : 0}`;
  switch (s.type) {
    case "nav":
      return `${head}:${s.chip ? s.chip.tone : "-"}`;
    case "status":
      return `${head}:${s.tone}`;
    case "progress":
      return `${head}:${s.value === null ? "sweep" : "bar"}`;
    case "toggle":
      return `${head}:${s.on ? 1 : 0}:${s.enabled ? 1 : 0}`;
    case "action":
      return `${head}:${s.enabled ? 1 : 0}`;
  }
}

/**
 * One key's clock: when it last changed visibly, when its appearance last changed, the appearance
 * signature drawn now, and the newest value that arrived since with the moment it may be drawn.
 */
export interface CoalesceEntry<T> {
  lastShown: number;
  lastAppearance: number;
  appearance: string | undefined;
  held: { value: T; appearance: string | undefined; dueAt: number } | null;
}

export type CoalesceState<T> = Readonly<Record<string, CoalesceEntry<T>>>;

export interface CoalesceStep<T> {
  state: CoalesceState<T>;
  /** The value to draw now, or null when it was held back. */
  show: T | null;
  /** When to call `flush` for the key, or null when nothing is held. */
  flushAt: number | null;
}

/** One arrival. `appearance` is its signature; `quick` keeps the content pace for an appearance change. */
export interface Incoming<T> {
  key: string;
  value: T;
  appearance?: string;
  quick?: boolean;
}

/**
 * Takes one incoming value for a key. The first value shows at once. A later one shows at once when at
 * least COALESCE_MS have passed since the last visible change and, if it changes the appearance, at least
 * APPEARANCE_MS since the last appearance change (unless `quick`). Anything sooner is held; a later
 * arrival replaces the held value, and the timer fires once at the trailing edge.
 */
export function coalesce<T>(prev: CoalesceState<T>, incoming: Incoming<T>, now: number): CoalesceStep<T> {
  const { key, value, appearance, quick } = incoming;
  const entry = prev[key];
  if (!entry) {
    const first = { lastShown: now, lastAppearance: now, appearance, held: null };
    return { state: { ...prev, [key]: first }, show: value, flushAt: null };
  }
  const changed = appearance !== entry.appearance;
  const paced = changed && !quick;
  const dueAt = Math.max(entry.lastShown + COALESCE_MS, paced ? entry.lastAppearance + APPEARANCE_MS : 0);
  if (now >= dueAt) {
    const shown = {
      lastShown: now,
      lastAppearance: changed ? now : entry.lastAppearance,
      appearance,
      held: null,
    };
    return { state: { ...prev, [key]: shown }, show: value, flushAt: null };
  }
  return {
    state: { ...prev, [key]: { ...entry, held: { value, appearance, dueAt } } },
    show: null,
    flushAt: dueAt,
  };
}

/** Releases the held value of a key at its trailing edge. Nothing held returns null and no change. */
export function flush<T>(
  prev: CoalesceState<T>,
  key: string,
  now: number,
): { state: CoalesceState<T>; show: T | null } {
  const entry = prev[key];
  if (!entry?.held) return { state: prev, show: null };
  const { value, appearance } = entry.held;
  const shown = {
    lastShown: now,
    lastAppearance: appearance !== entry.appearance ? now : entry.lastAppearance,
    appearance,
    held: null,
  };
  return { state: { ...prev, [key]: shown }, show: value };
}

/** One item as it is drawn. `rest` is the declared form from the manifest; `hidden` draws nothing. */
export type ItemView =
  | { kind: "rest" }
  | { kind: "hidden" }
  | { kind: "nav"; label: string; chip: PluginChip | null }
  | { kind: "status"; tone: PluginTone; text: string }
  | { kind: "progress"; value: number | null; text: string | null }
  | { kind: "toggle"; on: boolean; enabled: boolean; pending: boolean }
  | { kind: "action"; label: string; enabled: boolean };

/**
 * The view of one declared item. No live state reads as rest, except an action whose plugin is live:
 * it is clickable at once with its declared label. A plugin that is not responding keeps what it last
 * set, but its toggle and action cannot be pressed. A crashed plugin's state is gone, so it reads as rest.
 */
export function itemView(
  decl: PluginSidebarItem,
  live: PluginItemState | undefined,
  phase: FramePhase | undefined,
  pending: boolean,
): ItemView {
  if (phase === "crashed") return { kind: "rest" };
  if (!live || live.type !== decl.type) {
    return decl.type === "action" && phase === "live"
      ? { kind: "action", label: decl.label, enabled: true }
      : { kind: "rest" };
  }
  if (!live.visible) return { kind: "hidden" };

  const responding = phase !== "not_responding";
  switch (live.type) {
    case "nav":
      return { kind: "nav", label: live.label ?? decl.label, chip: live.chip };
    case "status":
      return { kind: "status", tone: live.tone, text: live.text };
    case "progress":
      return { kind: "progress", value: live.value, text: live.text };
    case "toggle":
      return { kind: "toggle", on: live.on, enabled: live.enabled && responding, pending };
    case "action":
      return { kind: "action", label: live.label ?? decl.label, enabled: live.enabled && responding };
  }
}
