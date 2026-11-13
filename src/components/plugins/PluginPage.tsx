// -- Component Imports --
import { PluginIcon } from "./PluginIcon";
import { PluginTag } from "./PluginTag";

// -- State Imports --
import { usePlugin } from "../../state/plugins/store";

// -- Utils Imports --
import { tagKind } from "../../state/plugins/trust";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./PluginPage.module.css";

/**
 * A plugin's page: the Plisto-drawn header (icon, name, tag) over the page body. The body is a quiet
 * line until the plugin's own content can be shown here. Draws nothing for a plugin that is gone; the
 * shell leaves the page for its landing in that case.
 */
export function PluginPage({ id }: { id: string }) {
  const t = useT();
  const plugin = usePlugin(id);
  if (!plugin || !plugin.manifest) return null;
  const tag = tagKind(plugin.tier);
  const name = plugin.manifest.name;

  return (
    <div className={styles.view}>
      <div className={styles.head}>
        <PluginIcon source={{ kind: "installed", id, hash: plugin.manifest_hash }} size={32} />
        <h1 className={styles.title}>{name}</h1>
        {tag ? <PluginTag kind={tag} /> : null}
      </div>
      <p className={styles.line}>{t((d) => d.plugins.pageUnavailable, { name })}</p>
    </div>
  );
}
