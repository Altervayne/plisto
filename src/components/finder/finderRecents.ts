/*
 * The quick finder's recents: the last entries opened, persisted as a small JSON list of kind and id.
 * The stored list is untrusted input from the settings table, so parsing keeps only well-formed refs,
 * and a ref whose entry is gone drops out on read.
 */

// -- Utils Imports --
import { entryKey } from "./finderIndex";

// -- Type Imports --
import type { FinderEntry, FinderKind } from "./finderIndex";

/** One remembered entry. */
export interface RecentRef {
  kind: FinderKind;
  id: number | string;
}

/** How many recents the finder keeps. */
export const RECENT_LIMIT = 6;

const KINDS: readonly string[] = [
  "artist",
  "album",
  "single",
  "playlist",
  "genre",
  "track",
  "destination",
];

function isRecentRef(value: unknown): value is RecentRef {
  if (typeof value !== "object" || value == null) return false;
  const { kind, id } = value as { kind?: unknown; id?: unknown };
  return (
    typeof kind === "string" &&
    KINDS.includes(kind) &&
    (typeof id === "number" || typeof id === "string")
  );
}

/** The stored list, or an empty one when the pref is absent or malformed. */
export function parseRecents(raw: string | undefined): RecentRef[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isRecentRef).slice(0, RECENT_LIMIT) : [];
  } catch {
    return [];
  }
}

/** The entries the refs still resolve to, in order. A ref with no entry left drops out. */
export function resolveRecents(
  refs: RecentRef[],
  lookup: (key: string) => FinderEntry | undefined,
): FinderEntry[] {
  const entries: FinderEntry[] = [];
  for (const ref of refs) {
    const entry = lookup(entryKey(ref.kind, ref.id));
    if (entry) entries.push(entry);
  }
  return entries;
}

/** The list with `entry` moved to the front, stale refs dropped, capped at the limit. */
export function pushRecent(
  refs: RecentRef[],
  entry: FinderEntry,
  lookup: (key: string) => FinderEntry | undefined,
): RecentRef[] {
  const key = entryKey(entry.kind, entry.id);
  const rest = refs.filter((ref) => {
    const refKey = entryKey(ref.kind, ref.id);
    return refKey !== key && lookup(refKey) != null;
  });
  return [{ kind: entry.kind, id: entry.id }, ...rest].slice(0, RECENT_LIMIT);
}
