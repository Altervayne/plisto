/*
 * Builders for a seated plugin stream's two DTOs, for tests and for stubbed-IPC previews. Defaults describe
 * a live radio item that is playing, accepts no skips and has no artwork yet.
 */

// -- Type Imports --
import type { StreamNow, StreamStatus } from "../../types";

/** The hub's display state, with `over` laid on top of a playing live item from "Night Radio". */
export function streamNowFixture(over: Partial<StreamNow> = {}): StreamNow {
  return {
    item: -41,
    plugin_id: "night-radio",
    plugin_name: "Night Radio",
    title: "Lowlight Jazz",
    artist: null,
    album: null,
    now: "Marlo Fenn - Slow Harbor",
    live: true,
    seekable: false,
    state: "playing",
    skip: { next: false, prev: false },
    art_rev: 0,
    rev: 1,
    ...over,
  };
}

/** The engine's stream status, with `over` laid on top of a live item over a parked track. */
export function streamStatusFixture(over: Partial<StreamStatus> = {}): StreamStatus {
  return {
    live: true,
    seekable: false,
    phase: "playing",
    parked: { track_id: 7, secs: 61.5 },
    parked_cleared: false,
    ...over,
  };
}
