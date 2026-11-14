/*
 * What the Sound popover says about the output takeover, as pure code. The player's flag decides whether
 * the output is held; the plugin statuses only name the holder. A held output with no matching status (a
 * stale or empty board at boot) still shows a line, without a name.
 */

// -- Type Imports --
import type { PluginRow, PluginStatus } from "../../types";

/** `id` and `name` are null when no holder is known; `text` is the holder's own report, shown as a second line. */
export type TakeoverView =
  | { kind: "held"; id: string | null; name: string | null; text: string | null }
  | { kind: "notResponding"; name: string };

const nameOf = (rows: readonly PluginRow[], id: string): string =>
  rows.find((row) => row.id === id)?.manifest?.name ?? id;

/** The block the popover shows, or null when nothing is held and no plugin lost the output. */
export function takeoverView(
  outputTakenOver: boolean,
  statuses: Readonly<Record<string, PluginStatus>>,
  rows: readonly PluginRow[],
): TakeoverView | null {
  const all = Object.values(statuses);
  if (outputTakenOver) {
    const holder = all.find((status) => status.takeover);
    if (!holder) return { kind: "held", id: null, name: null, text: null };
    const text = holder.reported?.text?.trim();
    return { kind: "held", id: holder.id, name: nameOf(rows, holder.id), text: text || null };
  }
  const lost = all.find((status) => status.host === "not_responding" && status.takeover_revoked === "not_responding");
  return lost ? { kind: "notResponding", name: nameOf(rows, lost.id) } : null;
}
