// -- Component Imports --
import { QuietButton } from "../../common/QuietButton";
import { PluginIcon } from "../../plugins/PluginIcon";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Type Imports --
import type { PluginInboxItem, PluginRow } from "../../../types";

// -- Style Imports --
import { installedFrom } from "./rowModel";
import rowStyles from "./PluginRow.module.css";
import styles from "./PluginsSection.module.css";
import settingsStyles from "../SettingsView.module.css";

/**
 * The plugins waiting in the inbox folder, each with a Review action that inspects it. Nothing here has
 * been read as a plugin yet, so a row names the file or folder and what kind it is. Renders nothing
 * when the inbox is empty.
 */
export function InboxList({
  items,
  rows,
  busy,
  onReview,
}: {
  items: PluginInboxItem[];
  /** The installed rows, to tell which items are already installed. */
  rows: PluginRow[];
  busy: boolean;
  onReview: (item: PluginInboxItem) => void;
}) {
  const t = useT();
  if (items.length === 0) return null;

  return (
    <div className={styles.group}>
      <span className={styles.sub}>{t((d) => d.plugins.availableLabel)}</span>
      <div className={settingsStyles.list}>
        {items.map((item) => (
          <div key={item.path} className={rowStyles.row}>
            <PluginIcon source={null} size={32} />
            <div className={rowStyles.main}>
              <div className={rowStyles.name}>
                <span className={`${rowStyles.nameText} ${rowStyles.mono}`}>{item.name}</span>
              </div>
              <div className={rowStyles.status}>
                {installedFrom(item, rows)
                  ? item.kind === "folder"
                    ? t((d) => d.plugins.inboxInstalledFolder)
                    : t((d) => d.plugins.inboxInstalledFile)
                  : item.kind === "folder"
                    ? t((d) => d.plugins.inboxFolder)
                    : t((d) => d.plugins.inboxFile)}
              </div>
            </div>
            <div className={rowStyles.acts}>
              <QuietButton onClick={() => onReview(item)} disabled={busy}>
                {t((d) => d.plugins.inboxReview)}
              </QuietButton>
            </div>
          </div>
        ))}
      </div>
      <p className={styles.hint}>{t((d) => d.plugins.availableHint)}</p>
    </div>
  );
}
