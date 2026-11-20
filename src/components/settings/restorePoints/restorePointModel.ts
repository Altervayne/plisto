/*
 * The pure side of the restore points surface: what a row is called, what a restore loses, how the
 * unmatched tracks group, and the plain text the clipboard receives. Wording stays in the views.
 */

// -- Type Imports --
import type { RestoreResult } from "../../../state/restorePoints/store";
import type { RestorePointRow, RestoreSummary, UnmatchedGroup } from "../../../types";

/** The whitelisted action keys a point can be taken before. */
export type ActionKey = "tags_apply" | "merge_duplicates" | "delete_albums" | "remove_root" | "purge" | "relocate";

/** What a row is called: its reason, plus the action key when the point was taken before an action. */
export type PointKind =
  | { reason: "version"; version: string }
  | { reason: "daily" }
  | { reason: "restore" }
  | { reason: "action"; action: ActionKey | null };

const ACTION_KEYS: readonly string[] = [
  "tags_apply",
  "merge_duplicates",
  "delete_albums",
  "remove_root",
  "purge",
  "relocate",
];

/** The kind of a point. A version point is named for the version that made it. */
export function pointKind(row: RestorePointRow): PointKind {
  const version = row.status.kind === "ready" ? row.status.app_version : "";
  switch (row.reason) {
    case "version":
      return { reason: "version", version };
    case "action": {
      const detail = row.status.kind === "ready" ? row.status.detail : null;
      return { reason: "action", action: detail !== null && ACTION_KEYS.includes(detail) ? (detail as ActionKey) : null };
    }
    default:
      return { reason: row.reason };
  }
}

/** What a restore of one point loses, read from its dry run. Every field is a count or a flag. */
export interface LostItems {
  /** The point's tracks no longer in the library. */
  notFound: number;
  /** Albums and singles whose every track is gone. */
  notRecreated: number;
  /** Tracks added since the point, whose edits are cleared. */
  cleared: number;
  /** No track of the point is in the library: nothing of it comes back. */
  allUnmatched: boolean;
}

export function lostItems(summary: RestoreSummary): LostItems {
  return {
    notFound: summary.unmatched_tracks,
    notRecreated: summary.albums_not_recreated,
    cleared: summary.cleared_tracks,
    allUnmatched: summary.unmatched_tracks > 0 && summary.filed_tracks === 0,
  };
}

/** The unmatched groups by the heading they sit under; a single reads as an album. */
export interface GroupedUnmatched {
  albums: UnmatchedGroup[];
  playlists: UnmatchedGroup[];
  other: UnmatchedGroup[];
}

export function groupUnmatched(groups: UnmatchedGroup[]): GroupedUnmatched {
  const grouped: GroupedUnmatched = { albums: [], playlists: [], other: [] };
  for (const group of groups) {
    if (group.kind === "playlist") grouped.playlists.push(group);
    else if (group.kind === "other") grouped.other.push(group);
    else grouped.albums.push(group);
  }
  return grouped;
}

/** The headings the copied text uses, already in the active language. */
export interface CopyHeadings {
  albums: string;
  playlists: string;
  other: string;
}

/** The unmatched list as plain text: a heading per kind, a title per container, its paths indented. */
export function unmatchedText(groups: UnmatchedGroup[], headings: CopyHeadings): string {
  const grouped = groupUnmatched(groups);
  const blocks: string[] = [];
  const section = (heading: string, list: UnmatchedGroup[]) => {
    if (list.length === 0) return;
    const lines = [heading];
    for (const group of list) {
      if (group.title !== null) lines.push(group.title);
      for (const path of group.paths) lines.push(group.title !== null ? `  ${path}` : path);
    }
    blocks.push(lines.join("\n"));
  };
  section(headings.albums, grouped.albums);
  section(headings.playlists, grouped.playlists);
  section(headings.other, grouped.other);
  return blocks.join("\n\n");
}

/** A refusal because a scan holds the library: shown as a line, never as a sheet of its own. */
export function isBusyRefusal(result: RestoreResult | null): boolean {
  return result?.kind === "refused" && result.failure.key === "busy";
}

/**
 * Whether closing the sheet that shows `shown` should clear the stored result: it is still that result,
 * or it is a scan refusal that replaced it. Any other result is newer and stays.
 */
export function shouldClearResult(shown: RestoreResult, current: RestoreResult | null): boolean {
  return current === shown || isBusyRefusal(current);
}
