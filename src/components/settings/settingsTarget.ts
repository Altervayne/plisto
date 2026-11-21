/*
 * What a surface outside Settings can ask Settings to land on: one row, one plugin's hub row, one
 * visualizer plugin's family in the catalog, or a whole section. Resolution against the live page lives
 * here so a target that has no row on screen falls back to its section.
 */

// -- Local Imports --
import { settingAnchorId, settingEntry } from "./settingsRegistry";
import { SETTINGS_SECTIONS } from "./settingsSections";

// -- Type Imports --
import type { HubSettingId, SettingId } from "./settingsRegistry";
import type { SettingsSectionId } from "./settingsSections";

/** The id of a visualizer-only plugin's family in the Visualizers catalog. */
export type FamilySettingId = `family-${string}`;

export type SettingsTarget = SettingId | HubSettingId | FamilySettingId | SettingsSectionId;

export function familySettingId(pluginId: string): FamilySettingId {
  return `family-${pluginId}`;
}

/** Where a target lands: the DOM id of a row, or a section. */
export type LandingAnchor =
  | { kind: "row"; domId: string }
  | { kind: "section"; section: SettingsSectionId };

/** Rows land this far below the top of the scroller; a section lands flush. */
export const ROW_LAND_OFFSET = 24;
export const SECTION_LAND_OFFSET = 0;

function isSectionId(id: string): id is SettingsSectionId {
  return SETTINGS_SECTIONS.some((section) => section.id === id);
}

/**
 * The section a target lives in: a section is itself, a row is in its registry section, a hub row in
 * Plugins, a family in Visualizers. Null for an id that names nothing, which leaves the shown section alone.
 */
export function sectionForTarget(target: string): SettingsSectionId | null {
  if (isSectionId(target)) return target;
  const entry = settingEntry(target);
  if (entry) return entry.section;
  if (target.startsWith("family-")) return "visualizers";
  return target.startsWith("hub-") ? "plugins" : null;
}

/**
 * The anchor a target lands on. A row that is not on the page (a Windows-only row elsewhere, a plugin
 * not loaded yet) lands on its section; a hub id with no row lands on Plugins. Null for an unknown id.
 */
export function resolveLanding(
  target: string,
  rowExists: (domId: string) => boolean,
): LandingAnchor | null {
  if (isSectionId(target)) return { kind: "section", section: target };
  const domId = settingAnchorId(target as SettingId | HubSettingId);
  if (rowExists(domId)) return { kind: "row", domId };
  const entry = settingEntry(target);
  if (entry) return { kind: "section", section: entry.section };
  if (target.startsWith("hub-")) return { kind: "section", section: "plugins" };
  if (target.startsWith("family-")) return { kind: "section", section: "visualizers" };
  return null;
}

/** The scrollTop that places an element `offset` pixels below the top of its scroller. */
export function landingScrollTop(
  elementTop: number,
  scrollerTop: number,
  scrollTop: number,
  offset: number,
): number {
  return elementTop - scrollerTop + scrollTop - offset;
}
