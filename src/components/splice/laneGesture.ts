/*
 * The pure decisions behind the waveform's editing gestures, factored out of the view so they are
 * deterministic and testable. The tool changes only what an empty-lane click does: Move seeks the
 * playhead, Splice drops a cut. Everything else - a drag always scrubs, a handle click selects - is the
 * same in both tools. The cropper passes no tool (undefined), reading as Move.
 */

/** The active lane tool. Move seeks on a click; Splice drops a cut on a click. */
export type Tool = "move" | "splice";

/** Whether an empty-lane press seeks the playhead now. Splice holds off and waits for the release. */
export function laneDownScrubs(tool: Tool | undefined): boolean {
  return tool !== "splice";
}

/** Whether an empty-lane move scrubs. Move scrubs always; Splice never does - the cut tool leaves the
 * playhead alone, so a drag in Splice mode is inert (only a click drops a cut). Scrub with the Move tool. */
export function laneMoveScrubs(tool: Tool | undefined, _dragged: boolean): boolean {
  return tool !== "splice";
}

/** Whether an empty-lane release drops a cut: a Splice click only, never a drag or a Move press. */
export function laneUpDropsMarker(tool: Tool | undefined, dragged: boolean): boolean {
  return tool === "splice" && !dragged;
}

/** Whether a marker-handle release selects it. A click selects; a drag has already moved it. */
export function handleUpSelects(dragged: boolean): boolean {
  return !dragged;
}

/** An id kept only while it is still live, else null: prunes a stale selection after the set changes. */
export function liveIdOrNull(id: string | null, liveIds: Iterable<string>): string | null {
  if (id === null) return null;
  for (const live of liveIds) if (live === id) return id;
  return null;
}
