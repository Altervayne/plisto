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
import { STAGE_FALLBACK } from "../../state/player/pluginVis/frameCache";
import { pluginVisualizer } from "../../state/player/pluginVisualizers";

// -- Utils Imports --
import { kindName } from "../player/visualizers/kindName";

// -- Type Imports --
import type { ListingNotice, ListingNoticeKind } from "../../state/plugins/pluginNotice";
import type { PluginNotice, VisualizerStopCause } from "../../types";
import type { Dict } from "../../i18n/en";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./PluginNoticeHost.module.css";

const STOP_LINE: Record<VisualizerStopCause, (d: Dict) => string> = {
  hang: (d) => d.plugins.status.noticeVisHang,
  slow: (d) => d.plugins.status.noticeVisSlow,
  graphics_reset: (d) => d.plugins.status.noticeVisReset,
  flashing: (d) => d.plugins.status.noticeVisFlash,
};

const LISTING_LINE: Record<ListingNoticeKind, (d: Dict) => string> = {
  added: (d) => d.plugins.vis.noticeAdded,
  addedToPlugins: (d) => d.plugins.vis.noticeAddedPlugins,
  ownPage: (d) => d.plugins.vis.noticeOwnPage,
  managed: (d) => d.plugins.vis.noticeManaged,
};

/**
 * Plisto's own toast for a plugin it turned off after repeated crashes: the plugin's name, the sentence
 * and a Show action that opens its row in Settings; also the line for a visualizer kind Plisto stopped,
 * and the lines that say where a plugin was listed after an install or an update, each with a Show
 * action that opens it there. This is the common pill, not the plugin toast, so nothing in it is
 * plugin-authored beyond declared names drawn as text. The last notice stays through the fade-out.
 */
export function PluginNoticeHost() {
  const t = useT();
  const { notice, visible } = usePluginNotice();
  const rows = usePlugins();
  const last = useRef<PluginNotice | ListingNotice | null>(null);

  useEffect(() => startPluginNoticeListener(), []);

  if (notice) last.current = notice;
  const shown = notice ?? last.current;
  if (!shown) return null;
  const name = shown.id == null ? null : (rows.find((row) => row.id === shown.id)?.manifest?.name ?? shown.id);

  if (shown.kind === "listing") {
    return (
      <Toast visible={visible} className={styles.pill}>
        <span className={styles.text}>{t(LISTING_LINE[shown.change], { name: name ?? shown.id })}</span>
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

  if (shown.kind === "visualizer_stopped") {
    const kind = pluginVisualizer(shown.visualizer)?.name ?? shown.visualizer;
    const vars = { name: kind, fallback: kindName(STAGE_FALLBACK, t) };
    return (
      <Toast visible={visible} className={styles.pill}>
        <span className={styles.text}>{t(STOP_LINE[shown.cause], vars)}</span>
      </Toast>
    );
  }

  if (shown.kind === "takeover_returned") {
    return (
      <Toast visible={visible} className={styles.pill}>
        <span className={styles.text}>
          {name == null
            ? t((d) => d.plugins.status.noticeTakeoverReturnedUnknown)
            : t((d) => d.plugins.status.noticeTakeoverReturned, { name })}
        </span>
      </Toast>
    );
  }

  return (
    <Toast visible={visible} className={styles.pill}>
      <span className={styles.text}>{t((d) => d.plugins.status.noticeAutoDisabled, { name: name ?? shown.id })}</span>
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
