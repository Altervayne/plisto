/*
 * The Settings-scoped rows and the global Settings group's footer, as pure functions over the entries so
 * the palette's model stays a thin hook around them.
 */

// -- Utils Imports --
import { matchesTokens, searchTokens } from "../../lib/tokenMatch";
import { scopedGroups, sectionEntries } from "./finderSettingsEntries";

// -- Type Imports --
import type { SettingFinderEntry } from "./finderIndex";
import type { FinderItem, FinderSection, SectionItem } from "./useFinderModel";

const asItems = (entries: SettingFinderEntry[]): SectionItem[] =>
  entries.map((entry) => ({ type: "entry", entry }));

/**
 * What the scoped palette shows. A blank query lists the sections; a typed one lists hits by section;
 * a miss leaves no section and one row that drops the scope.
 */
export function scopedView(
  entries: readonly SettingFinderEntry[],
  query: string,
): { sections: FinderSection[]; noMatch: boolean; extra: FinderItem[] } {
  if (query.trim() === "") {
    return { sections: [{ key: "sections", items: asItems(sectionEntries(entries)) }], noMatch: false, extra: [] };
  }
  const sections: FinderSection[] = scopedGroups(entries, query).map((group) => ({
    key: "scoped",
    title: group.title,
    items: asItems(group.items),
  }));
  const none = sections.length === 0;
  return { sections, noMatch: none, extra: none ? [{ type: "everything" }] : [] };
}

/** The "Show all N settings" row when more settings match than the global group shows, else null. */
export function settingsShowAll(
  entries: readonly SettingFinderEntry[],
  query: string,
  shown: number,
): SectionItem | null {
  const tokens = searchTokens(query);
  const total = entries.filter((entry) => matchesTokens(entry.fields, tokens)).length;
  return total > shown ? { type: "showAll", count: total, target: "settings" } : null;
}
