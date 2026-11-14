/*
 * What a seated plugin stream shows, as pure rules over the hub's StreamNow and the engine's duration.
 * The mini, the full Player and the transport all read their lines, phase words and button states from
 * here, so no surface decides them on its own. A stream is never labelled "Live": `live` is an engine
 * fact, and the display follows `seekable` and a known length instead.
 */

// -- Type Imports --
import type { StreamNow, StreamNowState } from "../../types";

/** The phases shown as one static word in place of the line they interrupt. */
export type StreamWaitPhase = "connecting" | "buffering" | "reconnecting";

/** The waiting phase of a state, or null for `playing` and `paused`. */
export function waitingPhase(state: StreamNowState): StreamWaitPhase | null {
  return state === "connecting" || state === "buffering" || state === "reconnecting" ? state : null;
}

/** True when the main button reads Pause: every state but `paused`, so a press during a wait stops the wait. */
export function showsPause(now: StreamNow): boolean {
  return now.state !== "paused";
}

/** True when the item has a length the scrubber can span. */
export function hasKnownLength(durationSecs: number): boolean {
  return durationSecs > 0;
}

/** True when the item gets a scrubber: seekable and of known length. Anything else shows listened time. */
export function showsScrubber(now: StreamNow, durationSecs: number): boolean {
  return now.seekable && hasKnownLength(durationSecs);
}

/**
 * The large line and the one beneath it. The now line leads when the plugin sets one, with the title
 * beneath; otherwise the title leads over the artist. `second` is null when there is nothing to show.
 */
export function streamLines(now: StreamNow): { first: string; second: string | null } {
  if (now.now) return { first: now.now, second: now.title };
  return { first: now.title, second: now.artist };
}

/**
 * The stream to draw for the engine's seat and the hub's state. The engine's status can arrive a frame
 * before the hub's event: with a seat and no state yet, a connecting placeholder with empty lines stands in,
 * so no surface falls back to the library path for a stream's negative id. Null when no stream is seated.
 */
export function resolveStream(seated: boolean, now: StreamNow | null, item: number | null): StreamNow | null {
  if (!seated) return null;
  if (now) return now;
  return {
    item: item ?? 0,
    plugin_id: "",
    plugin_name: "",
    title: "",
    artist: null,
    album: null,
    now: null,
    live: false,
    seekable: false,
    state: "connecting",
    skip: { next: false, prev: false },
    art_rev: 0,
    rev: 0,
  };
}

/** True when a Next or Previous key may be sent: always without a stream, else only if the plugin accepts it. */
export function skipAllowed(stream: StreamNow | null, direction: "next" | "prev"): boolean {
  return stream == null || stream.skip[direction];
}
