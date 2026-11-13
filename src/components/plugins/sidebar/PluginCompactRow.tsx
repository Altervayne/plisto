// -- Component Imports --
import { NavItem } from "../../shell/NavItem";
import { FrameMark, useFrameMarked } from "../FrameMark";
import { PluginIcon } from "../PluginIcon";
import { PluginTag } from "../PluginTag";

// -- Utils Imports --
import { tagKind } from "../../../state/plugins/trust";

// -- Type Imports --
import type { ZonePlugin } from "../../shell/navVisibility";

/**
 * One plugin as a single row in the shared group: its icon, name and tag, plus the frame mark while its
 * page is not answering. Opens the plugin's page.
 */
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
  const name = plugin.manifest.name;
  const marked = useFrameMarked(plugin.id);
  return (
    <NavItem
      icon={
        <PluginIcon source={{ kind: "installed", id: plugin.id, hash: plugin.manifest_hash }} size={17} />
      }
      label={name}
      tag={
        tag || marked ? (
          <>
            {tag ? <PluginTag kind={tag} /> : null}
            <FrameMark id={plugin.id} name={name} />
          </>
        ) : undefined
      }
      active={active}
      onClick={onOpen}
    />
  );
}
