/*
 * The worded parts of a scan summary line, built through a translator so the counts read in the active
 * locale. Only the parts that carry a number show, so a clean run reads short. A blocking scan leads
 * with how many it indexed; a background session walks only what changed, so it lists changes alone
 * and reads "Up to date" when there were none. Possible duplicates close the line whatever the source,
 * since they describe the library rather than the pass. After a blocking scan the unreadable part is the
 * standing number on record whenever it is above zero; after a session it is the count of new ones and
 * shows only when there are some, so a repeat of known failures stays quiet.
 */

// -- Type Imports --
import type { Translate } from "../../i18n";
import type { LibrarySummary } from "../../state/librarySync";

/**
 * One part of the line: plain text, or a count the view pairs with its Review link. An `issues` part is
 * `fresh` when the count is what a background session just found, not the standing total.
 */
export type SummaryPart =
  | { kind: "text"; text: string }
  | { kind: "gone"; n: number }
  | { kind: "issues"; n: number; fresh: boolean }
  | { kind: "duplicates"; n: number };

const text = (value: string): SummaryPart => ({ kind: "text", text: value });

/** A blocking scan's parts: the indexed count, what changed, and the gone count last. */
function blockingParts(summary: LibrarySummary, t: Translate): SummaryPart[] {
  const parts = [text(t((d) => d.scan.summaryIndexed, { n: summary.total }))];

  // On a first scan everything is new, so folding it in would only echo the indexed count.
  if (summary.inserted > 0 && summary.inserted !== summary.total) {
    parts.push(text(t((d) => d.scan.summaryNew, { n: summary.inserted })));
  }
  if (summary.updated > 0) parts.push(text(t((d) => d.scan.summaryChanged, { n: summary.updated })));
  if (summary.removed > 0) parts.push(text(t((d) => d.scan.summaryRemoved, { n: summary.removed })));
  if (summary.issues > 0) parts.push({ kind: "issues", n: summary.issues, fresh: false });
  if (summary.cancelled) parts.push(text(t((d) => d.scan.summaryCancelled)));
  if (summary.missing > 0) parts.push({ kind: "gone", n: summary.missing });
  return parts;
}

/** A background session's parts: only the non-zero changes, or "Up to date". */
function syncParts(summary: LibrarySummary, t: Translate): SummaryPart[] {
  const parts: SummaryPart[] = [];
  if (summary.inserted > 0) parts.push(text(t((d) => d.scan.summaryNew, { n: summary.inserted })));
  if (summary.updated > 0) parts.push(text(t((d) => d.scan.summaryChanged, { n: summary.updated })));
  if (summary.returned > 0) {
    parts.push(text(t((d) => d.scan.summaryReturned, { n: summary.returned })));
  }
  if (summary.missing > 0) parts.push({ kind: "gone", n: summary.missing });
  const fresh = summary.new_issues ?? 0;
  if (fresh > 0) parts.push({ kind: "issues", n: fresh, fresh: true });
  if (summary.deferred > 0) {
    parts.push(text(t((d) => d.scan.summaryCopying, { n: summary.deferred })));
  }
  return parts.length > 0 ? parts : [text(t((d) => d.scan.summaryUpToDate))];
}

/** The summary's parts in reading order, worded for where the summary came from. */
export function scanSummaryParts(
  summary: LibrarySummary,
  t: Translate,
  duplicates = 0,
): SummaryPart[] {
  const parts = summary.source === "sync" ? syncParts(summary, t) : blockingParts(summary, t);
  return duplicates > 0 ? [...parts, { kind: "duplicates", n: duplicates }] : parts;
}
