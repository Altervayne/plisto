/*
 * What the hub's one sheet can be: a review of a plugin, or a notice that an operation did not go
 * through. A review carries the staged token while the files are only staged, and the manifest hash
 * the consent will be tied to once they are installed.
 */

// -- Type Imports --
import type { PluginErrorKey } from "./errors";
import type { ReviewLead, ReviewMode, ReviewSubject } from "./review";

/** Where a confirmed review stands. Anything but idle holds the sheet open and its buttons off. */
export type SheetPhase = "idle" | "installing" | "approving" | "enabling" | "updating";

/** Which operation a notice reports as not done. */
export type NoticeKind =
  | "install"
  | "update"
  | "approve"
  | "enable"
  | "unregistered"
  | "unreadable"
  | "updatedUnreadable"
  | "stale";

export interface ReviewState {
  kind: "review";
  mode: ReviewMode;
  subject: ReviewSubject;
  /** The staged inspection, until install or update consumes it. */
  token: string | null;
  /** The installed manifest the consent is tied to; null while the files are only staged. */
  hash: string | null;
  /** Why a consent review is open. */
  lead: ReviewLead;
  phase: SheetPhase;
}

export interface NoticeState {
  kind: "notice";
  notice: NoticeKind;
  /** The plugin, or the file when no plugin was read. */
  name: string;
  /** The refusal's message key; null for a notice that is not about a refused command. */
  error: PluginErrorKey | null;
}

export type SheetState = ReviewState | NoticeState;

/** A review sheet that has not started anything. */
export function reviewState(
  mode: ReviewMode,
  subject: ReviewSubject,
  token: string | null,
  hash: string | null,
  lead: ReviewLead = "adopted",
): ReviewState {
  return { kind: "review", mode, subject, token, hash, lead, phase: "idle" };
}

/** The last path segment, for naming a file in a notice. */
export function fileNameOf(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
