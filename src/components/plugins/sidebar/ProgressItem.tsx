// -- Component Imports --
import { Tooltip } from "../../common/Tooltip/Tooltip";
import { TruncatedText } from "../../common/TruncatedText/TruncatedText";

// -- Hook Imports --
import { useItemView } from "./useItemView";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Type Imports --
import type { PluginSidebarItem } from "../../../types";

// -- Style Imports --
import styles from "./PluginItems.module.css";

/**
 * A declared progress bar. At rest it is its label over an empty track. Live, it shows the plugin's text
 * (or the declared label) over a track that is filled to the value, or sweeps slowly when the value is
 * unknown.
 */
export function ProgressItem({ pluginId, item }: { pluginId: string; item: PluginSidebarItem }) {
  const t = useT();
  const view = useItemView(pluginId, item);
  if (view.kind === "hidden") return null;

  if (view.kind === "progress") {
    const label = view.text ?? item.label;
    const percent = view.value == null ? null : Math.round(Math.min(1, Math.max(0, view.value)) * 100);
    return (
      <div
        className={styles.progress}
        role="progressbar"
        aria-label={
          percent == null
            ? t((d) => d.plugins.ui.progressBusy, { label })
            : t((d) => d.plugins.ui.progressLabel, { label, percent })
        }
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
      >
        <TruncatedText text={label} className={styles.label} />
        <div className={styles.track} aria-hidden="true">
          {percent == null ? (
            <i className={styles.sweep} />
          ) : (
            <i className={styles.fill} style={{ width: `${percent}%` }} />
          )}
        </div>
      </div>
    );
  }

  return (
    <Tooltip label={t((d) => d.plugins.itemUnavailable)}>
      <div className={styles.progress}>
        <span className={styles.label}>{item.label}</span>
        <div className={styles.track} aria-hidden="true" />
      </div>
    </Tooltip>
  );
}
