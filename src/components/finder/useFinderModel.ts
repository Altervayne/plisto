// -- Framework Imports --
import { useCallback, useMemo } from "react";

// -- State Imports --
import { PREF_KEYS, usePreference, useSetPreference } from "../../state/preferences/store";

// -- Hook Imports --
import { useFinderIndex } from "./useFinderIndex";
import { usePlayRecency } from "./usePlayRecency";

// -- Utils Imports --
import { entryKey } from "./finderIndex";
import { searchFinder } from "./finderMatch";
import { parseRecents, pushRecent, resolveRecents } from "./finderRecents";

// -- Type Imports --
import type { FinderEntry } from "./finderIndex";
import type { FinderGroupKey } from "./finderMatch";

/** One navigable row: an entry, or the footer that hands the query to All Tracks. */
export type FinderItem = { type: "entry"; entry: FinderEntry } | { type: "showAll"; count: number };

/** A labelled run of rows. */
export interface FinderSection {
  key: FinderGroupKey | "recent";
  items: FinderItem[];
}

/** What the palette renders for the current query, and the hook to remember an opened entry. */
export interface FinderModel {
  sections: FinderSection[];
  // Every row across the sections in display order, for the keyboard cursor.
  items: FinderItem[];
  // A typed query that found nothing.
  noMatch: boolean;
  // A blank query with no recents to show.
  noRecents: boolean;
  remember: (entry: FinderEntry) => void;
}

/**
 * The finder's rows for a query: the matched groups, or the recents when the query is blank. Runs on
 * every keystroke over the prebuilt index, so it stays a plain synchronous pass.
 */
export function useFinderModel(query: string): FinderModel {
  const { index, destinations } = useFinderIndex();
  const lastPlayed = usePlayRecency();
  const storedRecents = usePreference(PREF_KEYS.finderRecent);
  const setPreference = useSetPreference();

  const lookup = useMemo(() => {
    const destinationByKey = new Map(
      destinations.map((entry) => [entryKey(entry.kind, entry.id), entry] as const),
    );
    return (key: string): FinderEntry | undefined =>
      index.byKey.get(key) ?? destinationByKey.get(key);
  }, [index, destinations]);

  const recentRefs = useMemo(() => parseRecents(storedRecents), [storedRecents]);

  const remember = useCallback(
    (entry: FinderEntry) => {
      const next = pushRecent(recentRefs, entry, lookup);
      setPreference(PREF_KEYS.finderRecent, JSON.stringify(next));
    },
    [recentRefs, lookup, setPreference],
  );

  const blank = query.trim() === "";

  const view = useMemo(() => {
    if (blank) {
      const recents = resolveRecents(recentRefs, lookup);
      const sections: FinderSection[] =
        recents.length > 0
          ? [{ key: "recent", items: recents.map((entry) => ({ type: "entry", entry })) }]
          : [];
      return { sections, noMatch: false, noRecents: recents.length === 0 };
    }
    const results = searchFinder(
      [index.entries, destinations],
      query,
      lastPlayed,
      index.goneTrackFields,
    );
    const sections: FinderSection[] = results.groups.map((group) => {
      const items: FinderItem[] = group.hits.map((hit) => ({ type: "entry", entry: hit.entry }));
      if (group.key === "tracks" && results.trackMatches > group.hits.length) {
        items.push({ type: "showAll", count: results.trackMatches });
      }
      return { key: group.key, items };
    });
    return { sections, noMatch: sections.length === 0, noRecents: false };
  }, [blank, recentRefs, lookup, index, destinations, query, lastPlayed]);

  const items = useMemo(() => view.sections.flatMap((section) => section.items), [view]);

  return { ...view, items, remember };
}
