// -- Framework Imports --
import { useEffect, useRef } from "react";

// -- Component Imports --
import { Toast } from "../common/Toast/Toast";
import { QuietButton } from "../common/QuietButton";

// -- State Imports --
import {
  dismissPluginNotice,
  startPluginNoticeListener,
  usePluginNotice,
} from "../../state/plugins/pluginNotice";
import { usePlugins } from "../../state/plugins/store";
import { openPluginHub } from "../../state/shell/store";

// -- Type Imports --
import type { PluginNotice } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./PluginNoticeHost.module.css";

/**
 * Plisto's own toast for a plugin it turned off after repeated crashes: the plugin's name, the sentence
 * and a Show action that opens its row in Settings. This is the common pill, not the plugin toast, so
 * nothing in it is plugin-authored beyond the manifest name drawn as text. The last notice stays through
 * the fade-out.
 */
export function PluginNoticeHost() {
  const t = useT();
  const { notice, visible } = usePluginNotice();
  const rows = usePlugins();
  const last = useRef<PluginNotice | null>(null);

  useEffect(() => startPluginNoticeListener(), []);

  if (notice) last.current = notice;
  const shown = notice ?? last.current;
  if (!shown) return null;
  const name = rows.find((row) => row.id === shown.id)?.manifest?.name ?? shown.id;

  return (
    <Toast visible={visible} className={styles.pill}>
      <span className={styles.text}>{t((d) => d.plugins.status.noticeAutoDisabled, { name })}</span>
      <QuietButton
        onClick={() => {
          dismissPluginNotice();
          openPluginHub(shown.id);
        }}
      >
        {t((d) => d.plugins.status.noticeShow)}
      </QuietButton>
    </Toast>
  );
}
