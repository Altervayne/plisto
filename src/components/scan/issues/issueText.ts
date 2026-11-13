/*
 * The pure parts of the unreadable-files sheet: how a path is split and shortened for a row, which
 * words a reason and its next step take, which filter chips show, and how the clipboard text is
 * previewed. No React, so each is tested alone.
 */

// -- Type Imports --
import type { Dict } from "../../../i18n/en";
import type { Translate } from "../../../i18n";
import type { ScanIssueReason } from "../../../types";
import type { ReasonCounts } from "../../../state/scanIssues";

/** Lines of the copy text the panel previews before it says how many more follow. */
export const PREVIEW_LINES = 15;

/** The reasons in the order the filter chips list them. */
export const REASON_ORDER: ScanIssueReason[] = [
  "access_denied",
  "in_use",
  "corrupt_or_unsupported",
  "path_too_long",
  "disk_error",
  "other",
];

const REASON_LABEL: Record<ScanIssueReason, (d: Dict) => string> = {
  access_denied: (d) => d.scan.issueReasonAccessDenied,
  in_use: (d) => d.scan.issueReasonInUse,
  corrupt_or_unsupported: (d) => d.scan.issueReasonCorrupt,
  path_too_long: (d) => d.scan.issueReasonPathTooLong,
  disk_error: (d) => d.scan.issueReasonDisk,
  other: (d) => d.scan.issueReasonOther,
};

const REASON_HINT: Record<ScanIssueReason, (d: Dict) => string> = {
  access_denied: (d) => d.scan.issueHintAccessDenied,
  in_use: (d) => d.scan.issueHintInUse,
  corrupt_or_unsupported: (d) => d.scan.issueHintCorrupt,
  path_too_long: (d) => d.scan.issueHintPathTooLong,
  disk_error: (d) => d.scan.issueHintDisk,
  other: (d) => d.scan.issueHintOther,
};

/** The worded reason, e.g. "Access denied". A code this build does not know reads as `other`. */
export function reasonLabel(t: Translate, reason: ScanIssueReason): string {
  return t(REASON_LABEL[reason] ?? REASON_LABEL.other);
}

/** The one-line next step for a reason. */
export function reasonHint(t: Translate, reason: ScanIssueReason): string {
  return t(REASON_HINT[reason] ?? REASON_HINT.other);
}

/** A row's file or folder name and the folder that holds it, split on either separator. */
export function splitPath(path: string): { name: string; dir: string } {
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  if (cut < 0) return { name: trimmed, dir: "" };
  return { name: trimmed.slice(cut + 1), dir: trimmed.slice(0, cut) };
}

/** Cuts the middle out of a long path so its head and the end of its last folder both stay readable. */
export function shortenPath(path: string, max = 70): string {
  if (path.length <= max) return path;
  const keep = max - 3;
  const head = Math.ceil(keep * 0.45);
  return `${path.slice(0, head)}...${path.slice(path.length - (keep - head))}`;
}

/** Counts with every code this build does not know folded into `other`. */
function knownCounts(byReason: ReasonCounts): ReasonCounts {
  const folded: ReasonCounts = {};
  for (const [reason, n] of Object.entries(byReason)) {
    const key = REASON_ORDER.includes(reason as ScanIssueReason) ? (reason as ScanIssueReason) : "other";
    folded[key] = (folded[key] ?? 0) + (n ?? 0);
  }
  return folded;
}

/** The filter chips with their counts, in display order. Empty when one reason leaves nothing to filter. */
export function visibleChips(byReason: ReasonCounts): { reason: ScanIssueReason; n: number }[] {
  const counts = knownCounts(byReason);
  const present = REASON_ORDER.flatMap((reason) => {
    const n = counts[reason] ?? 0;
    return n > 0 ? [{ reason, n }] : [];
  });
  return present.length > 1 ? present : [];
}

/** How many issues stand across every reason. */
export function standingTotal(byReason: ReasonCounts): number {
  return Object.values(byReason).reduce((sum, n) => sum + (n ?? 0), 0);
}

/** The clipboard text cut for the panel: its header, the first lines, and how many lines it leaves out. */
export function copyPreview(
  text: string,
  max = PREVIEW_LINES,
): { header: string; lines: string[]; more: number } {
  const all = text.split("\n");
  if (all[all.length - 1] === "") all.pop();
  const [header = "", ...rest] = all;
  return { header, lines: rest.slice(0, max), more: Math.max(0, rest.length - max) };
}

/** Whether a last-seen time is recent enough to read as a check that just ran. */
export function checkedJustNow(lastSeen: number, nowSeconds: number): boolean {
  return nowSeconds - lastSeen < 120;
}
