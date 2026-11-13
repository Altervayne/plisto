// -- Component Imports --
import { PluginSection } from "./PluginSection";
import { PluginCompactRow } from "./PluginCompactRow";

// -- Hook Imports --
import { usePluginZone } from "./usePluginZone";

// -- State Imports --
import { usePluginRoute } from "../../../state/shell/store";

// -- Unit Imports --
import { isZoneEmpty, pluginMode } from "../../shell/navVisibility";
import type { Mode } from "../../shell/navVisibility";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Style Imports --
import shellStyles from "../../shell/Sidebar.module.css";

/**
 * The plugin zone of the rail, between Library and Utilities: each plugin that chose a section owns
 * one, in install order, then the plugins that chose a single row share one "Plugins" group. Renders
 * nothing, label included, when no enabled plugin shows under the app mode.
 */
export function PluginSidebarZone({
  mode,
  onOpenPlugin,
}: {
  mode: Mode;
  onOpenPlugin: (id: string, route: string | null) => void;
}) {
  const t = useT();
  const zone = usePluginZone();
  const route = usePluginRoute();
  if (isZoneEmpty(zone)) return null;

  return (
    <>
      {zone.sections.map((section) => (
        <PluginSection
          key={section.plugin.id}
          section={section}
          onPage={mode === pluginMode(section.plugin.id)}
          route={route}
          onOpen={(to) => onOpenPlugin(section.plugin.id, to)}
        />
      ))}
      {zone.compact.length > 0 ? (
        <div className={shellStyles.navgroup}>
          <div className={shellStyles.navlabel}>{t((d) => d.plugins.zoneLabel)}</div>
          {zone.compact.map((plugin) => (
            <PluginCompactRow
              key={plugin.id}
              plugin={plugin}
              active={mode === pluginMode(plugin.id)}
              onOpen={() => onOpenPlugin(plugin.id, null)}
            />
          ))}
        </div>
      ) : null}
    </>
  );
}
