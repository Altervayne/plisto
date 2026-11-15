/*
 * The finder's Settings entries, built from the settings registry so the palette never lists a row the
 * page lacks or misses one it has: one entry per visible setting, one per section (a jump to its top)
 * and one per installed plugin's hub row. The scoped list reads the same entries.
 */

// -- Utils Imports --
import { searchFold } from "../../lib/fold";
import { matchesTokens, searchTokens } from "../../lib/tokenMatch";
import { hubSettingId, visibleSettings } from "../settings/settingsRegistry";
import { SETTINGS_SECTIONS } from "../settings/settingsSections";

// -- Type Imports --
import type { Dict } from "../../i18n/en";
import type { PluginTagKind } from "../../state/plugins/trust";
import type { SettingsContext } from "../settings/settingsRegistry";
import type { SettingsSectionId } from "../settings/settingsSections";
import type { SettingFinderEntry } from "./finderIndex";
import type { FinderScope } from "./useFinderModel";

/** The words the entries are built from, already translated. */
export interface SettingsEntryText {
  // The group's name, also the sublabel of a section row.
  group: string;
  // "Settings > Section" for a row in that section.
  path: (section: string) => string;
}

/** An installed plugin, as its hub row needs it. */
export interface HubSource {
  id: string;
  name: string;
  tag: PluginTagKind | null;
}

/** One scoped result group: a section's title and the entries that matched in it. */
export interface ScopedGroup {
  section: SettingsSectionId;
  title: string;
  items: SettingFinderEntry[];
}

/** Every Settings entry that exists now, in page order: each section's row first, then its settings. */
export function settingEntries(
  dict: Dict,
  ctx: SettingsContext,
  hubs: readonly HubSource[],
  text: SettingsEntryText,
): SettingFinderEntry[] {
  const visible = visibleSettings(ctx);
  const entries: SettingFinderEntry[] = [];
  for (const section of SETTINGS_SECTIONS) {
    const sectionLabel = section.label(dict);
    entries.push({
      kind: "setting",
      id: section.id,
      variant: "section",
      section: section.id,
      label: sectionLabel,
      sublabel: text.group,
      fields: [searchFold(sectionLabel)],
      synonyms: [],
      tag: null,
      trackIds: [],
    });
    const path = text.path(sectionLabel);
    for (const setting of visible) {
      if (setting.section !== section.id) continue;
      const synonyms = setting.synonyms(dict);
      const helper = setting.sublabel?.(dict);
      const label = setting.label(dict);
      entries.push({
        kind: "setting",
        id: setting.id,
        variant: "setting",
        section: section.id,
        label,
        sublabel: path,
        fields: [
          searchFold(label),
          ...synonyms.map(searchFold),
          ...(helper ? [searchFold(helper)] : []),
        ],
        synonyms,
        tag: null,
        trackIds: [],
      });
    }
    if (section.id !== "plugins") continue;
    for (const hub of hubs) {
      entries.push({
        kind: "setting",
        id: hubSettingId(hub.id),
        variant: "hub",
        section: section.id,
        label: hub.name,
        sublabel: path,
        fields: [searchFold(hub.name)],
        synonyms: [],
        pluginId: hub.id,
        tag: hub.tag,
        trackIds: [],
      });
    }
  }
  return entries;
}

/** The synonym that found the entry when its label alone did not, else null. */
export function matchedSynonym(entry: SettingFinderEntry, tokens: readonly string[]): string | null {
  if (matchesTokens([entry.fields[0]], tokens)) return null;
  for (let i = 0; i < entry.synonyms.length; i += 1) {
    if (matchesTokens([entry.fields[i + 1]], tokens)) return entry.synonyms[i];
  }
  return null;
}

/**
 * The entries a scoped query finds, grouped by section in page order. The sublabel of a hit is the
 * synonym that matched (none when the label did), since the section is already the group's title.
 */
export function scopedGroups(entries: readonly SettingFinderEntry[], query: string): ScopedGroup[] {
  const tokens = searchTokens(query);
  const titles = new Map<SettingsSectionId, string>();
  for (const entry of entries) {
    if (entry.variant === "section") titles.set(entry.section, entry.label);
  }
  const groups: ScopedGroup[] = [];
  for (const entry of entries) {
    if (!matchesTokens(entry.fields, tokens)) continue;
    const via = matchedSynonym(entry, tokens);
    const item = { ...entry, sublabel: via ?? undefined };
    const last = groups[groups.length - 1];
    if (last?.section === entry.section) last.items.push(item);
    else groups.push({ section: entry.section, title: titles.get(entry.section) ?? "", items: [item] });
  }
  return groups;
}

/** Whether Backspace should remove the scope: a fresh press on an empty field, never a held key. */
export function dropsScope(scope: FinderScope | null, query: string, repeat = false): boolean {
  return scope != null && query === "" && !repeat;
}

/** The fewest characters of the group word a query must type before it names the whole group. */
export const GROUP_WORD_MIN = 4;

/** Whether every query token is a prefix of the (folded) group word, as "settings" or "param" are. */
export function namesGroup(query: string, group: string): boolean {
  const tokens = searchTokens(query);
  return tokens.length > 0 && tokens.every((token) => token.length >= GROUP_WORD_MIN && group.startsWith(token));
}

/** The entries with the group word added as a field, so a query naming the group matches each row. */
export function withGroupWord(entries: readonly SettingFinderEntry[], group: string): SettingFinderEntry[] {
  return entries.map((entry) => (entry.variant === "section" ? entry : { ...entry, fields: [...entry.fields, group] }));
}

/** The section rows alone, as the scoped list shows before anything is typed. */
export function sectionEntries(entries: readonly SettingFinderEntry[]): SettingFinderEntry[] {
  return entries
    .filter((entry) => entry.variant === "section")
    .map((entry) => ({ ...entry, sublabel: undefined }));
}
