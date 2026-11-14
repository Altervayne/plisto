// -- Component Imports --
import { NavItem } from "../../shell/NavItem";
import { PluginChips } from "../PluginChips";
import { PluginIcon } from "../PluginIcon";
import { PluginTag } from "../PluginTag";
import { StatusDot } from "../StatusDot";

// -- State Imports --
import { usePluginChips } from "../../../state/plugins/sidebarState";
import { useProbe } from "../../../state/plugins/sandboxStore";
import { usePluginStatusView } from "../../../state/plugins/usePluginStatusView";

// -- Utils Imports --
import { tagKind } from "../../../state/plugins/trust";

// -- Type Imports --
import type { ZonePlugin } from "../../shell/navVisibility";

/**
 * One plugin as a single row in the shared group: its icon, name and tag, plus its status dot when it
 * has one, and the chips the plugin set. Opens the plugin's page.
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
  const tag = tagKind(plugin.tier, useProbe());
  const name = plugin.manifest.name;
  const status = usePluginStatusView(plugin);
  const chips = usePluginChips(plugin.id);
  return (
    <NavItem
      icon={
        <PluginIcon source={{ kind: "installed", id: plugin.id, hash: plugin.manifest_hash }} size={17} />
      }
      label={name}
      tag={
        tag || status.dot ? (
          <>
            {tag ? <PluginTag kind={tag} /> : null}
            <StatusDot view={status} name={name} />
          </>
        ) : undefined
      }
      chips={chips.length > 0 ? <PluginChips chips={chips} /> : undefined}
      active={active}
      onClick={onOpen}
    />
  );
}
