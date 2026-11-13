// -- Framework Imports --
import { useId } from "react";

// -- Icon Imports --
import { ChevronDown } from "lucide-react";

// -- Component Imports --
import { FrameMark } from "../FrameMark";
import { PluginIcon } from "../PluginIcon";
import { PluginTag } from "../PluginTag";
import { NavRowItem } from "./NavRowItem";
import { StatusLineItem } from "./StatusLineItem";
import { ProgressItem } from "./ProgressItem";
import { ToggleItem } from "./ToggleItem";
import { ActionItem } from "./ActionItem";

// -- Hook Imports --
import { usePluginCollapse } from "./usePluginCollapse";

// -- Utils Imports --
import { tagKind } from "../../../state/plugins/trust";
import { activeNavItemId } from "../../shell/navVisibility";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Type Imports --
import type { PluginSidebarItem } from "../../../types";
import type { ZoneSection } from "../../shell/navVisibility";

// -- Style Imports --
import shellStyles from "../../shell/Sidebar.module.css";
import styles from "./PluginSection.module.css";

/** One declared item in its fixed Plisto-drawn form, live once the plugin sets its state. */
function ItemRow({
  pluginId,
  pluginName,
  item,
  active,
  onOpen,
}: {
  pluginId: string;
  pluginName: string;
  item: PluginSidebarItem;
  active: boolean;
  onOpen: (route: string | null) => void;
}) {
  switch (item.type) {
    case "nav":
      return <NavRowItem pluginId={pluginId} item={item} active={active} onOpen={onOpen} />;
    case "status":
      return <StatusLineItem pluginId={pluginId} item={item} />;
    case "progress":
      return <ProgressItem pluginId={pluginId} item={item} />;
    case "toggle":
      return <ToggleItem pluginId={pluginId} pluginName={pluginName} item={item} />;
    case "action":
      return <ActionItem pluginId={pluginId} pluginName={pluginName} item={item} />;
  }
}

/**
 * A plugin-owned sidebar section. Plisto draws the heading (icon, manifest name, tag, fold chevron), so
 * a plugin never sets heading text. `onPage` says this plugin's page is open, and `route` is the route
 * it was opened on.
 */
export function PluginSection({
  section,
  onPage,
  route,
  onOpen,
}: {
  section: ZoneSection;
  onPage: boolean;
  route: string | null;
  onOpen: (route: string | null) => void;
}) {
  const t = useT();
  const { plugin, items } = section;
  const { collapsed, toggle } = usePluginCollapse(plugin.id, section.collapsed);
  const itemsId = useId();
  const tag = tagKind(plugin.tier);
  const name = plugin.manifest.name;
  const activeId = onPage ? activeNavItemId(items, route) : null;

  return (
    <div className={shellStyles.navgroup}>
      <div className={styles.head}>
        <span className={styles.title}>
          <PluginIcon source={{ kind: "installed", id: plugin.id, hash: plugin.manifest_hash }} size={16} />
          <span className={styles.name}>{name}</span>
          {tag ? (
            <span className={styles.tagWrap}>
              <PluginTag kind={tag} />
            </span>
          ) : null}
          <FrameMark id={plugin.id} name={name} />
        </span>
        <button
          type="button"
          className={collapsed ? `${styles.fold} ${styles.folded}` : styles.fold}
          aria-expanded={!collapsed}
          aria-controls={itemsId}
          aria-label={t((d) => (collapsed ? d.plugins.expandSection : d.plugins.collapseSection), { name })}
          onClick={toggle}
        >
          <ChevronDown size={14} strokeWidth={1.8} />
        </button>
      </div>
      {collapsed ? null : (
        <div id={itemsId} className={styles.items}>
          {items.map((item) => (
            <ItemRow
              key={item.id}
              pluginId={plugin.id}
              pluginName={name}
              item={item}
              active={item.id === activeId}
              onOpen={onOpen}
            />
          ))}
        </div>
      )}
    </div>
  );
}
