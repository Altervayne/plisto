// -- Component Imports --
import { NavItem } from "../../shell/NavItem";
import { PluginIcon } from "../PluginIcon";
import { PluginTag } from "../PluginTag";

// -- Utils Imports --
import { tagKind } from "../../../state/plugins/trust";

// -- Type Imports --
import type { ZonePlugin } from "../../shell/navVisibility";

/** One plugin as a single row in the shared group: its icon, name and tag. Opens the plugin's page. */
export function PluginCompactRow({
  plugin,
  active,
  onOpen,
}: {
  plugin: ZonePlugin;
  active: boolean;
  onOpen: () => void;
}) {
  const tag = tagKind(plugin.tier);
  return (
    <NavItem
      icon={
        <PluginIcon source={{ kind: "installed", id: plugin.id, hash: plugin.manifest_hash }} size={17} />
      }
      label={plugin.manifest.name}
      tag={tag ? <PluginTag kind={tag} /> : undefined}
      active={active}
      onClick={onOpen}
    />
  );
}
