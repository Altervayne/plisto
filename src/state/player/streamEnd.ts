/*
 * Which end-of-stream notices earn a toast, and which line each one reads. A stream the user stopped, a
 * newer play replaced, its owner stopped or that finished on its own ends quietly: the player already shows
 * the result. Pure, so the mapping is testable apart from the toast.
 */

// -- Type Imports --
import type { StreamEndNotice } from "../../types";

/** The keys of `player.stream.end`, one per toast line. */
export type StreamEndKey =
  | "network"
  | "denied"
  | "unsupported"
  | "playlist"
  | "noAudio"
  | "stalled"
  | "producerGone"
  | "pluginOff"
  | "consent"
  | "safeMode";

/**
 * The notice the store holds after `incoming` arrives. A silent end must not cut short a toast still showing
 * for another plugin's stream, so it is dropped then; it replaces the showing end only when that one is for
 * the same plugin, and anything else (including null, the toast clearing itself) takes the slot.
 */
export function nextStreamEnd(
  current: StreamEndNotice | null,
  incoming: StreamEndNotice | null,
): StreamEndNotice | null {
  if (!incoming || !current) return incoming;
  const showing = streamEndKey(current) != null;
  if (showing && streamEndKey(incoming) == null && current.plugin_id !== incoming.plugin_id) return current;
  return incoming;
}

/**
 * The toast line for an end, or null when the end is silent. A plugin that went away reads by its detail:
 * an update turns it off, a withdrawn approval and safe mode have their own lines, and any other detail
 * (the user disabling or uninstalling it) stays silent.
 */
export function streamEndKey(end: StreamEndNotice): StreamEndKey | null {
  switch (end.reason) {
    case "network":
      return "network";
    case "denied":
      return "denied";
    case "unsupported":
      return end.detail === "playlist" ? "playlist" : "unsupported";
    case "no_audio":
      return "noAudio";
    case "stalled":
      return "stalled";
    case "producer_gone":
      return "producerGone";
    case "plugin_gone":
      if (end.detail === "update") return "pluginOff";
      if (end.detail === "consent") return "consent";
      if (end.detail === "safe_mode") return "safeMode";
      return null;
    case "user":
    case "replaced":
    case "stopped":
    case "finished":
      return null;
  }
}
