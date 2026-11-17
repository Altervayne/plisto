/*
 * The catalog page's rows: one per kind the catalog names, grouped by family in registry order. A row
 * carries plain-string ids and accessors, so the page never reads the built-in kind union and a kind
 * from another source can join later with its own still and glyph.
 */

// -- Framework Imports --
import { createElement, useMemo } from "react";
import type { ReactNode } from "react";

// -- Component Imports --
import { VisualizerGlyph } from "../../player/visualizers/VisualizerGlyph";
import { VISUALIZER_VIEWS, thumbFor } from "../../player/visualizers/visualizerViews";

// -- State Imports --
import { GROUP_LABELS, GROUP_ORDER } from "../../../state/player/visualizerRegistry";

// -- Type Imports --
import type { Dict } from "../../../i18n/en";
import type { Catalog } from "../../../state/player/visualizerCatalog";
import type { VisualizerKind } from "../../../state/player/visualizerKind";
import type { VisualizerGroupId } from "../../../state/player/visualizerRegistry";

export interface CatalogRow {
  id: string;
  group: string;
  source: "builtin";
  label: (d: Dict) => string;
  /** The still for a theme, or null when none exists. */
  thumb: (theme: "light" | "dark") => string | null;
  /** The mark shown while no still exists. */
  glyph: ReactNode;
}

export interface CatalogFamily {
  id: string;
  label: (d: Dict) => string;
  rows: readonly CatalogRow[];
}

/** The families of `catalog` in registry order, each with its rows. A kind with no view is left out. */
export function catalogFamilies(catalog: Catalog): CatalogFamily[] {
  const groups = [...new Set<string>([...GROUP_ORDER, ...catalog.entries.map((e) => e.group)])];
  return groups
    .map((group) => {
      const rows = catalog.entries
        .filter((e) => e.group === group && e.id in VISUALIZER_VIEWS)
        .map((e): CatalogRow => {
          const kind = e.id as VisualizerKind;
          return {
            id: e.id,
            group,
            source: "builtin",
            label: VISUALIZER_VIEWS[kind].label,
            thumb: (theme) => thumbFor(kind, theme),
            glyph: createElement(VisualizerGlyph, { kind, size: 26 }),
          };
        });
      const label = GROUP_LABELS[group as VisualizerGroupId] ?? (() => group);
      return { id: group, label, rows };
    })
    .filter((family) => family.rows.length > 0);
}

export function useCatalogRows(catalog: Catalog): CatalogFamily[] {
  return useMemo(() => catalogFamilies(catalog), [catalog.entries]);
}
