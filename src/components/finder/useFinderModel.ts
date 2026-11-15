// -- Framework Imports --
import { useCallback, useMemo } from "react";

// -- State Imports --
import { useT } from "../../i18n";
import { PREF_KEYS, usePreference, useSetPreference } from "../../state/preferences/store";

// -- Hook Imports --
import { useFinderIndex } from "./useFinderIndex";
import { usePlayRecency } from "./usePlayRecency";

// -- Utils Imports --
import { searchFold } from "../../lib/fold";
import { entryKey } from "./finderIndex";
import { searchFinder } from "./finderMatch";
import { parseRecents, pushRecent, resolveRecents } from "./finderRecents";
import { namesGroup, withGroupWord } from "./finderSettingsEntries";
import { scopedView, settingsShowAll } from "./finderScopedView";

// -- Type Imports --
import type { FinderEntry } from "./finderIndex";
import type { FinderGroupKey } from "./finderMatch";

/** What narrows the palette to one part of the app. */
export type FinderScope = "settings";

/**
 * One navigable row: an entry, a footer that hands the query on (to All Tracks, or to the Settings
 * scope when `target` says so), or the row that drops the scope after a scoped miss.
 */
export type FinderItem =
  | { type: "entry"; entry: FinderEntry }
  | { type: "showAll"; count: number; target?: FinderScope }
  | { type: "everything" };

/** The rows a section can hold; the scope-drop row sits outside every section. */
export type SectionItem = Exclude<FinderItem, { type: "everything" }>;

/** A labelled run of rows. A scoped group carries its own `title`. */
export interface FinderSection {
  key: FinderGroupKey | "recent" | "sections" | "scoped";
  title?: string;
  items: SectionItem[];
}

/** What the palette renders for the current query, and the hook to remember an opened entry. */
export interface FinderModel {
  sections: FinderSection[];
  // Every row across the sections in display order, for the keyboard cursor.
  items: FinderItem[];
  // A typed query that found nothing. Under a scope the only row is the one that drops it.
  noMatch: boolean;
  // A blank query with no recents to show.
  noRecents: boolean;
  remember: (entry: FinderEntry) => void;
}

/** The model before its rows are flattened; `extra` holds rows that sit outside every section. */
interface FinderView {
  sections: FinderSection[];
  noMatch: boolean;
  noRecents: boolean;
  extra: FinderItem[];
}

/**
 * The finder's rows for a query: the matched groups, or the recents when the query is blank. Under the
 * Settings scope only Settings entries show, grouped by section, and a blank query lists the sections.
 * Runs on every keystroke over the prebuilt index, so it stays a plain synchronous pass.
 */
export function useFinderModel(query: string, scope: FinderScope | null = null): FinderModel {
  const { index, destinations, plugins, settings: settingRows } = useFinderIndex();
  const t = useT();
  const group = searchFold(t((d) => d.finder.settings));
  const lastPlayed = usePlayRecency();
  const storedRecents = usePreference(PREF_KEYS.finderRecent);
  const setPreference = useSetPreference();

  const lookup = useMemo(() => {
    const outsideByKey = new Map<string, FinderEntry>(
      [...destinations, ...plugins, ...settingRows].map((entry) => [entryKey(entry.kind, entry.id), entry] as const),
    );
    return (key: string): FinderEntry | undefined => index.byKey.get(key) ?? outsideByKey.get(key);
  }, [index, destinations, plugins, settingRows]);

  const recentRefs = useMemo(() => parseRecents(storedRecents), [storedRecents]);

  const remember = useCallback(
    (entry: FinderEntry) => {
      const next = pushRecent(recentRefs, entry, lookup);
      setPreference(PREF_KEYS.finderRecent, JSON.stringify(next));
    },
    [recentRefs, lookup, setPreference],
  );

  const blank = query.trim() === "";

  // A query that names the group ("settings") lists every setting; the word is no field otherwise.
  const settings = useMemo(
    () => (scope == null && namesGroup(query, group) ? withGroupWord(settingRows, group) : settingRows),
    [scope, query, group, settingRows],
  );

  const view = useMemo((): FinderView => {
    if (scope === "settings") {
      return { ...scopedView(settings, query), noRecents: false };
    }
    if (blank) {
      const recents = resolveRecents(recentRefs, lookup);
      const sections: FinderSection[] =
        recents.length > 0
          ? [{ key: "recent", items: recents.map((entry) => ({ type: "entry", entry })) }]
          : [];
      return { sections, noMatch: false, noRecents: recents.length === 0, extra: [] };
    }
    const results = searchFinder(
      [index.entries, destinations, plugins, settings],
      query,
      lastPlayed,
      index.goneTrackFields,
    );
    const sections: FinderSection[] = results.groups.map((group) => {
      const items: SectionItem[] = group.hits.map((hit) => ({ type: "entry", entry: hit.entry }));
      if (group.key === "tracks" && results.trackMatches > group.hits.length) {
        items.push({ type: "showAll", count: results.trackMatches });
      }
      if (group.key === "settings") {
        const more = settingsShowAll(settings, query, group.hits.length);
        if (more) items.push(more);
      }
      return { key: group.key, items };
    });
    return { sections, noMatch: sections.length === 0, noRecents: false, extra: [] };
  }, [scope, blank, recentRefs, lookup, index, destinations, plugins, settings, query, lastPlayed]);

  const items = useMemo(
    () => [...view.sections.flatMap((section) => section.items), ...view.extra],
    [view],
  );

  return { sections: view.sections, noMatch: view.noMatch, noRecents: view.noRecents, items, remember };
}
