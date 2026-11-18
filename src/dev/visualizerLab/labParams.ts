/*
 * The lab's query-string choices as pure functions: which layouts a run covers, the song window a
 * measure reads, and the reactivity the song is followed at.
 */

// -- Local Imports --
import { LAB_LAYOUT_IDS, type LabLayoutId } from "./labScene";

// -- State Imports --
import { REACTIVITY_LEVELS, type Reactivity } from "../../state/player/visualizerKind";

/** The layouts `raw` names, or `fallback` when it names none. An unknown name is an error. */
export function pickLayoutIds(raw: string | null, fallback: readonly LabLayoutId[]): LabLayoutId[] {
  if (!raw) return [...fallback];
  if (!(LAB_LAYOUT_IDS as readonly string[]).includes(raw)) {
    throw new Error(`unknown layout: ${raw} (one of ${LAB_LAYOUT_IDS.join(", ")})`);
  }
  return [raw as LabLayoutId];
}

/** The song seconds a measure reads: from `from` for `length`. */
export interface ReadWindow {
  from: number;
  length: number;
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

function seconds(name: string, raw: string): number {
  const v = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(v)) throw new Error(`${name}= must be a number of seconds, got "${raw}"`);
  return v;
}

/** The seconds one 60 fps frame lasts. */
const FRAME_SECONDS = 1 / 60;

/**
 * The read window from the `from` and `for` params, each absent meaning its default. Rejects a negative
 * start, a length that holds no 60 fps frame, and a window that runs past `songEnd`.
 */
export function parseReadWindow(
  fromRaw: string | null,
  forRaw: string | null,
  defaults: ReadWindow,
  songEnd: number,
): ReadWindow {
  const from = fromRaw === null ? defaults.from : seconds("from", fromRaw);
  const length = forRaw === null ? defaults.length : seconds("for", forRaw);
  if (from < 0) throw new Error(`from= must not be negative, got ${from}`);
  if (length <= 0) throw new Error(`for= must be longer than zero, got ${length}`);
  if (length < FRAME_SECONDS) throw new Error(`for= must hold at least one 60 fps frame (${round6(FRAME_SECONDS)} s), got ${length}`);
  if (from + length > songEnd + 1e-9) {
    throw new Error(`the window ${from} s to ${from + length} s runs past the end of the song at ${songEnd} s`);
  }
  return { from, length };
}

/** The reactivity `raw` names, or `fallback` when it is absent. An unknown name is an error. */
export function pickReactivity(raw: string | null, fallback: Reactivity): Reactivity {
  if (!raw) return fallback;
  if (!(REACTIVITY_LEVELS as readonly string[]).includes(raw)) throw new Error(`unknown reactivity: ${raw}`);
  return raw as Reactivity;
}
