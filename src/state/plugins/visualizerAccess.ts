/*
 * What a visualizer frame may ask of Plisto, by exact method name. A visualizer frame is torn down at
 * every kind change, so it gets nothing that needs a long-lived delivery target: no subscriptions, streams,
 * sockets, sidebar, toasts, prompts or network. The page channel is its one way to the plugin's own page.
 * A call not listed here is refused before it reaches Rust, so a new method stays refused until it is
 * judged here; Rust still checks the plugin's grants for whatever passes.
 */

// -- State Imports --
import { errorMsg } from "./bridge";
import { CHANNEL_METHOD } from "../../visRuntime/protocol";

// -- Type Imports --
import type { Action } from "./bridge";

/** The grant that opens the plugin's own store. */
const STORAGE_GRANT = "storage";

const STORAGE = new Set([
  "storage.get",
  "storage.set",
  "storage.remove",
  "storage.keys",
  "storage.clear",
  "storage.usage",
]);

const OPEN = new Set([
  "log.write",
  CHANNEL_METHOD,
  "playback.state",
  "library.tracks",
  "library.tracks_by_id",
  "library.albums",
  "library.album",
  "library.album_tracks",
  "library.playlists",
  "library.playlist",
  "library.playlist_tracks",
  "library.playlist_entries",
  "library.cover",
]);

/** Whether a visualizer frame of a plugin holding `granted` may call `method`. */
export function visualizerMay(method: string, granted: readonly string[]): boolean {
  if (STORAGE.has(method)) return granted.includes(STORAGE_GRANT);
  return OPEN.has(method);
}

/**
 * Turns a call from a visualizer record that the list refuses into a `denied` answer to that call.
 * Every other action passes unchanged. A grants lookup that throws reads as no grants.
 */
export function screenCall<S>(action: Action<S>, granted: (pluginId: string) => readonly string[]): Action<S> {
  if (action.kind !== "call" || action.rec.role !== "visualizer") return action;
  let held: readonly string[] = [];
  try {
    held = granted(action.rec.pluginId);
  } catch {
    // Fail closed: storage stays refused.
  }
  if (visualizerMay(action.method, held)) return action;
  const msg = errorMsg(action.callId, "denied", "A visualizer frame cannot call this method.");
  return { kind: "reply", rec: action.rec, msg };
}
