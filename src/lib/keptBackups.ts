/*
 * The pure side of the Kept backups surfaces: which backups belong to a set of tracks or a folder, how a
 * row stands, the summary line's numbers, and the notices a discard leaves behind.
 */

// -- Utils Imports --
import { formatBytes } from "./format";
import { undoFailureText } from "./trimFailureText";

// -- Type Imports --
import type { Translate } from "../i18n";
import type { TrimFailureInfo } from "./trimReplace";
import type { KeptBackup, KeptDiscardAllOutcome, KeptDiscardOutcome } from "../types";

const DAY_MS = 86_400_000;

/** How a row reads: undoable, changed since the trim, its backup gone, or its folder offline. */
export type KeptRowKind = "ready" | "changed" | "missing" | "offline";

/** The confirm a row or the footer has asked for. */
export type KeptAsk =
  | { kind: "undo"; backup: KeptBackup }
  | { kind: "discard"; backup: KeptBackup }
  | { kind: "all" };

/** The backups whose track is one of `trackIds`. A backup outliving its track has no id and never matches. */
export function keptForTracks(backups: readonly KeptBackup[], trackIds: readonly number[]): KeptBackup[] {
  const ids = new Set(trackIds);
  return backups.filter((b) => b.trackId != null && ids.has(b.trackId));
}

/** The backups that live under library folder `rootId`. */
export function keptForRoot(backups: readonly KeptBackup[], rootId: number): KeptBackup[] {
  return backups.filter((b) => b.rootId === rootId);
}

/** How a row reads. An offline or missing state wins over what the backend says about undo. */
export function keptRowKind(backup: KeptBackup): KeptRowKind {
  if (backup.state === "missing") return "missing";
  if (backup.state === "offline") return "offline";
  return backup.canUndo ? "ready" : "changed";
}

/** The backups Discard all can reach: on disk and on a folder that is online. */
export function discardable(backups: readonly KeptBackup[]): KeptBackup[] {
  return backups.filter((b) => b.state === "kept");
}

/** The numbers of the summary line. `count` and `bytes` cover the backups still on disk. */
export interface KeptSummary {
  count: number;
  bytes: number;
  missing: number;
  offline: number;
}

export function summarizeKept(backups: readonly KeptBackup[]): KeptSummary {
  const present = backups.filter((b) => b.state !== "missing");
  return {
    count: present.length,
    bytes: present.reduce((sum, b) => sum + b.size, 0),
    missing: backups.length - present.length,
    offline: backups.filter((b) => b.state === "offline").length,
  };
}

/** Whole days until a backup expires: null when it is kept until discarded, 0 when it goes today. */
export function expiryDays(backup: KeptBackup, nowMs: number): number | null {
  if (backup.expiresAt == null) return null;
  return Math.max(0, Math.ceil((backup.expiresAt - nowMs) / DAY_MS));
}

/** The line left after discarding one backup, or null when it simply went. */
export function discardOneNotice(t: Translate, backup: KeptBackup, outcome: KeptDiscardOutcome): string | null {
  return outcome.leftInPlace ? t((d) => d.fileWrites.kept.leftInPlace, { path: backup.relPath }) : null;
}

/** The line left after Discard all, naming files left in place and offline backups kept; null when neither. */
export function discardAllNotice(t: Translate, outcome: KeptDiscardAllOutcome): string | null {
  const parts = [
    outcome.leftInPlace > 0 ? t((d) => d.fileWrites.kept.leftInPlaceMany, { n: outcome.leftInPlace }) : null,
    outcome.offline > 0 ? t((d) => d.fileWrites.kept.discardAllOffline, { n: outcome.offline }) : null,
  ].filter((part): part is string => part != null);
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * The summary line: how many backups hold how much space, the missing and offline ones, and how long
 * they are kept. `keepDays` is null when they stay until discarded.
 */
export function summaryLine(t: Translate, backups: readonly KeptBackup[], keepDays: number | null): string {
  const s = summarizeKept(backups);
  const counts = [
    t((d) => d.fileWrites.kept.summary, { n: s.count, size: formatBytes(s.bytes) }),
    s.missing > 0 ? t((d) => d.fileWrites.kept.summaryMissing, { n: s.missing }) : null,
    s.offline > 0 ? t((d) => d.fileWrites.kept.summaryOffline, { n: s.offline }) : null,
  ].filter((part): part is string => part != null);
  const keep =
    keepDays == null
      ? t((d) => d.fileWrites.kept.summaryForever)
      : t((d) => d.fileWrites.kept.summaryDays, { n: keepDays });
  return `${counts.join(", ")} - ${keep}`;
}

/** Why an Undo trim failed, in the words the Track Editor uses for the same failure. */
export function undoFailureLine(t: Translate, failure: TrimFailureInfo, backup: KeptBackup): string {
  return undoFailureText(t, failure, backup.relPath, formatBytes(backup.size));
}
