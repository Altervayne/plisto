/*
 * The album disc-layout math: pure functions that turn a set of drawer members into a full atomic
 * layout (every member's disc and its per-disc position). A disc groups by `disc_no ?? 1`, so an
 * unset disc rides with disc 1. Numbering restarts at 1 inside each disc. Framework-free and
 * deterministic, so the list and the row share one numbering and it unit-tests without a UI.
 */

// -- Type Imports --
import type { AlbumTrackRow, TrackPlacement } from "../../types";

/** A member's disc, an unset disc falling to disc 1 - the key the drawer groups and numbers by. */
export const discOf = (row: AlbumTrackRow): number => row.disc_no ?? 1;

/** One disc group: its number and its members, in the order they render. */
export interface DiscGroup {
  disc: number;
  rows: AlbumTrackRow[];
}

/**
 * Splits members into disc groups in ascending disc order. Members must already be sorted by
 * (disc, track_no) - the drawer selector guarantees it - so same-disc rows sit contiguous and keep
 * their track order.
 */
export function groupByDisc(rows: AlbumTrackRow[]): DiscGroup[] {
  const groups: DiscGroup[] = [];
  for (const row of rows) {
    const disc = discOf(row);
    const last = groups[groups.length - 1];
    if (last && last.disc === disc) last.rows.push(row);
    else groups.push({ disc, rows: [row] });
  }
  return groups;
}

/**
 * Stamps a per-disc track_no onto members taken in their intended order: within each disc the number
 * rises 1..n. Each member keeps its own `disc_no` (null included, which numbers with disc 1). The
 * caller sets the order and each member's disc; this only assigns the numbering.
 */
export function layoutInOrder(orderedMembers: AlbumTrackRow[]): TrackPlacement[] {
  const perDisc = new Map<number, number>();
  return orderedMembers.map((row) => {
    const disc = discOf(row);
    const no = (perDisc.get(disc) ?? 0) + 1;
    perDisc.set(disc, no);
    return { track_id: row.track_id, disc_no: row.disc_no, track_no: no };
  });
}

/**
 * Places one member at a precise slot on `disc` and returns the whole re-numbered layout - the drag
 * path, where a drop resolves a target disc and an index within it. A same-disc drop keeps the
 * member's stored disc (so a null/disc-1 track stays pristine on a reorder); a cross-disc drop stamps
 * the target disc onto it. The rest keep their disc and relative order, `index` clamps into the
 * target disc's run, and members must arrive sorted by (disc, track_no).
 */
export function placeAt(
  members: AlbumTrackRow[],
  trackId: number,
  disc: number,
  index: number,
): TrackPlacement[] {
  const moved = members.find((r) => r.track_id === trackId);
  if (!moved) return layoutInOrder(members);
  const disc_no = disc === discOf(moved) ? moved.disc_no : disc;
  const reassigned: AlbumTrackRow = { ...moved, disc_no };
  const others = members.filter((r) => r.track_id !== trackId);

  // Rebuild the order disc by disc; on the target disc the moved track slots in at the wanted index.
  const discs = new Set<number>(others.map(discOf));
  discs.add(disc);
  const ordered: AlbumTrackRow[] = [];
  for (const d of [...discs].sort((a, b) => a - b)) {
    if (d !== disc) {
      for (const r of others) if (discOf(r) === d) ordered.push(r);
      continue;
    }
    const run = others.filter((r) => discOf(r) === d);
    run.splice(Math.max(0, Math.min(index, run.length)), 0, reassigned);
    ordered.push(...run);
  }
  return layoutInOrder(ordered);
}

/**
 * Moves one member to `disc`, appended after that disc's current members, and returns the whole
 * re-numbered layout. The rest keep their disc and relative order; a null disc sends the track to
 * disc 1 while clearing its stored disc. Members must arrive sorted by (disc, track_no).
 */
export function moveToDisc(
  members: AlbumTrackRow[],
  trackId: number,
  disc: number | null,
): TrackPlacement[] {
  const moved = members.find((r) => r.track_id === trackId);
  if (!moved) return layoutInOrder(members);
  const target = disc ?? 1;
  const others = members.filter((r) => r.track_id !== trackId);
  const reassigned: AlbumTrackRow = { ...moved, disc_no: disc };

  // Rebuild the order disc by disc so the moved track lands last on its target disc.
  const discs = new Set<number>(others.map(discOf));
  discs.add(target);
  const ordered: AlbumTrackRow[] = [];
  for (const d of [...discs].sort((a, b) => a - b)) {
    for (const r of others) if (discOf(r) === d) ordered.push(r);
    if (d === target) ordered.push(reassigned);
  }
  return layoutInOrder(ordered);
}

/**
 * Resolves a drop of one member onto another into the full re-numbered layout. The drop takes the
 * over-row's disc and slots before or after it by the DIRECTION of travel: a track dragged downward
 * (it started above the over) lands after it, one dragged upward lands before it. Direction is what
 * dnd-kit's own arrayMove keys on, and it stays correct both ways where a mid-drag pointer-vs-row
 * geometry read drifts by one on an upward move. Members must arrive sorted by (disc, track_no).
 */
export function reorderOnto(
  members: AlbumTrackRow[],
  movedId: number,
  overId: number,
): TrackPlacement[] {
  const from = members.findIndex((r) => r.track_id === movedId);
  const overIndex = members.findIndex((r) => r.track_id === overId);
  if (from === -1 || overIndex === -1) return layoutInOrder(members);

  const disc = discOf(members[overIndex]);
  const run = members.filter((r) => discOf(r) === disc && r.track_id !== movedId);
  const at = run.findIndex((r) => r.track_id === overId);
  // Downward (the moved row sat above the over) lands after it; upward lands before it.
  const after = from < overIndex;
  return placeAt(members, movedId, disc, at + (after ? 1 : 0));
}
