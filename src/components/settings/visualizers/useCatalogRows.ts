/*
 * The catalog page's rows: one per kind the catalog names, grouped by family in registry order. A row
 * carries plain-string ids and accessors, so the page never reads the built-in kind union and a kind
 * from another source can join later with its own still and glyph.
 */

// -- Framework Imports --
import { createElement, useMemo } from "react";
import type { ReactNode } from "react";

// -- Icon Imports --
import { Waves } from "lucide-react";

// -- Component Imports --
import { VisualizerGlyph } from "../../player/visualizers/VisualizerGlyph";
import { VISUALIZER_VIEWS, thumbFor } from "../../player/visualizers/visualizerViews";

// -- State Imports --
import { pluginFamilyOf, pluginVisualizers } from "../../../state/player/pluginVisualizers";
import { GROUP_ORDER } from "../../../state/player/visualizerRegistry";
import { familyView, hasFamily, isMixed } from "../../../state/plugins/pluginFamily";
import { usePluginStatusStore } from "../../../state/plugins/pluginStatus";
import { usePlugins, usePluginsBoot } from "../../../state/plugins/store";

// -- Type Imports --
import type { Dict } from "../../../i18n/en";
import type { Catalog } from "../../../state/player/visualizerCatalog";
import type { BuiltinKind } from "../../../state/player/visualizerKind";
import type { FamilyView } from "../../../state/plugins/pluginFamily";
import type { IconSource } from "../../../state/plugins/iconCache";
import type { PluginBootState, PluginRow, PluginStatus } from "../../../types";

export interface CatalogRow {
  id: string;
  group: string;
  source: "builtin" | "plugin";
  label: (d: Dict) => string;
  /** The still for a theme, or null when none exists. */
  thumb: (theme: "light" | "dark") => string | null;
  /** The mark shown while no still exists. */
  glyph: ReactNode;
}

/** What a plugin's family carries beyond its rows: where its icon is read from and its status view. */
export interface PluginFamilyInfo {
  pluginId: string;
  name: string;
  icon: IconSource;
  mixed: boolean;
  view: FamilyView;
}

export interface CatalogFamily {
  id: string;
  rows: readonly CatalogRow[];
  /** Set on a plugin's family only. */
  plugin?: PluginFamilyInfo;
}

/** The plugin state the families read. */
export interface PluginCatalogInput {
  rows: readonly PluginRow[];
  boot: PluginBootState | null;
  statuses: Readonly<Record<string, PluginStatus>>;
}

const NO_PLUGINS: PluginCatalogInput = { rows: [], boot: null, statuses: {} };

/** A plugin kind has no shipped still: its tile reads the rendered one from the thumbnail store. */
const noThumb = (): string | null => null;

/**
 * A plugin's kinds as (id, name) pairs: the descriptor table while the plugin is enabled and ready, else
 * its manifest's declarations, so a family that is off or held still lists its kinds.
 */
function kindsOf(row: PluginRow): { id: string; name: string }[] {
  const live = pluginVisualizers().filter((d) => d.pluginId === row.id);
  if (live.length > 0) return live.map((d) => ({ id: d.id, name: d.name }));
  return (row.manifest?.visualizers ?? []).map((v) => ({ id: `${row.id}/${v.id}`, name: v.name }));
}

function pluginFamilies(catalog: Catalog, plugins: PluginCatalogInput): CatalogFamily[] {
  return plugins.rows
    .filter(hasFamily)
    .sort(
      (a, b) => (a.manifest?.name ?? "").localeCompare(b.manifest?.name ?? "") || a.id.localeCompare(b.id),
    )
    .map((row): CatalogFamily => {
      const family = pluginFamilyOf(row.id);
      const view = familyView(row, {
        boot: plugins.boot,
        status: plugins.statuses[row.id],
        groupsOff: catalog.state.groups,
      });
      return {
        id: family,
        rows: kindsOf(row).map(
          (kind): CatalogRow => ({
            id: kind.id,
            group: family,
            source: "plugin",
            label: () => kind.name,
            thumb: noThumb,
            glyph: createElement(Waves, { size: 26, strokeWidth: 1.6 }),
          }),
        ),
        plugin: {
          pluginId: row.id,
          name: row.manifest?.name ?? row.id,
          icon: { kind: "installed", id: row.id, hash: row.manifest_hash },
          mixed: isMixed(row),
          view,
        },
      };
    });
}

/**
 * The families of `catalog` in registry order, each with its rows, then one family per plugin by plugin
 * name. A built-in kind with no view is left out.
 */
export function catalogFamilies(catalog: Catalog, plugins: PluginCatalogInput = NO_PLUGINS): CatalogFamily[] {
  const groups = [...new Set<string>([...GROUP_ORDER, ...catalog.entries.map((e) => e.group)])];
  const builtins = groups
    .map((group) => {
      const rows = catalog.entries
        .filter((e) => e.group === group && e.id in VISUALIZER_VIEWS)
        .map((e): CatalogRow => {
          const kind = e.id as BuiltinKind;
          return {
            id: e.id,
            group,
            source: "builtin",
            label: VISUALIZER_VIEWS[kind].label,
            thumb: (theme) => thumbFor(kind, theme),
            glyph: createElement(VisualizerGlyph, { kind, size: 26 }),
          };
        });
      return { id: group, rows };
    })
    .filter((family) => family.rows.length > 0);
  return [...builtins, ...pluginFamilies(catalog, plugins)];
}

export function useCatalogRows(catalog: Catalog): CatalogFamily[] {
  const rows = usePlugins();
  const boot = usePluginsBoot();
  const statuses = usePluginStatusStore((s) => s.statuses);
  return useMemo(
    () => catalogFamilies(catalog, { rows, boot, statuses }),
    [catalog.entries, catalog.state.groups, rows, boot, statuses],
  );
}
