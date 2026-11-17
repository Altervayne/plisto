/*
 * What an album entry in a playlist hands to the player and to its own row: the queue slice for a play
 * next or an append, whether anything in it can play, the missing tally, the total length and a member's
 * display title. Pure over the entry's expanded members, so the row and its menu share one reading.
 */

// -- Type Imports --
import type { AlbumTrackRow, QueueBlock } from "../../types";
import type { PlaylistEntry } from "./playlistExpand";

/** An album entry of an expansion, with the members it expands to. */
export type AlbumEntry = Extract<PlaylistEntry, { kind: "album" }>;

/** The entry's own queue slice: every member, and a kept entry as one block over them. */
export function entryQueue(entry: AlbumEntry): { ids: number[]; blocks: QueueBlock[] | undefined } {
  const ids = entry.members.map((member) => member.track_id);
  const kept = entry.entry.keep_order && ids.length > 0;
  return { ids, blocks: kept ? [[0, ids.length]] : undefined };
}

/** How many members have lost their file. */
export function missingCount(members: AlbumTrackRow[]): number {
  return members.filter((member) => member.missing_at != null).length;
}

/** Whether any member can play. */
export function hasPlayableMember(members: AlbumTrackRow[]): boolean {
  return members.some((member) => member.missing_at == null);
}

/** The summed length of the members whose file is present, or null when none is. */
export function totalSecs(members: AlbumTrackRow[]): number | null {
  const present = members.filter((member) => member.missing_at == null);
  if (present.length === 0) return null;
  return present.reduce((sum, member) => sum + (member.duration_secs ?? 0), 0);
}

/** A member's title: the edit over the raw tag, then the filename when both are blank. */
export function memberTitle(member: AlbumTrackRow): string {
  const resolved = member.title_override ?? member.raw_title;
  return resolved == null || resolved === "" ? member.filename : resolved;
}
