// -- Framework Imports --
import { useEffect, useState } from "react";

// -- Component Imports --
import { CrashCard } from "./CrashCard";
import { NotRespondingOverlay } from "./frames/NotRespondingOverlay";

// -- Utils Imports --
import { disablePlugin } from "./frames/disablePlugin";
import { restartPlugin } from "../../state/plugins/restartPlugin";

// -- Type Imports --
import type { CrashDetail, PageBody } from "../../state/plugins/statusModel";
import type { PluginRow } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./PluginPage.module.css";

/**
 * What the page's recess holds in place of the plugin's own content: the Starting card, the crash card,
 * the could-not-start card, the not-responding overlay of a plugin without a frame, or the unavailable
 * line. A framed plugin's content is its frame, drawn over the recess by the frame layer, so a running
 * one leaves the recess empty. A plugin without a frame has no page to show yet, so it reads as
 * unavailable while running.
 */
export function PluginPageBody({
  plugin,
  body,
  framed,
  detail,
}: {
  plugin: PluginRow;
  body: PageBody;
  framed: boolean;
  detail: CrashDetail | null;
}) {
  const t = useT();
  const name = plugin.manifest?.name ?? plugin.id;
  const [waited, setWaited] = useState(false);

  // Wait lasts until the plugin leaves the not-responding state.
  useEffect(() => {
    if (body.kind !== "notResponding") setWaited(false);
  }, [body.kind]);

  const unavailable = framed ? null : <p className={styles.line}>{t((d) => d.plugins.pageUnavailable, { name })}</p>;

  switch (body.kind) {
    case "starting":
      return (
        <div className={styles.card}>
          <h2 className={styles.cardTitle}>{t((d) => d.plugins.frame.starting, { name })}</h2>
          <p className={styles.cardLine}>{t((d) => d.plugins.frame.startingLine)}</p>
        </div>
      );
    case "stopped":
    case "restarting":
      return (
        <CrashCard
          name={name}
          variant={body.kind}
          detail={detail}
          onRestart={() => restartPlugin(plugin)}
          onDisable={() => disablePlugin(plugin.id)}
        />
      );
    case "failed": {
      const reason = body.reason;
      return (
        <div className={styles.card}>
          <h2 className={styles.cardTitle}>{t((d) => d.plugins.frame.failedTitle, { name })}</h2>
          <p className={styles.cardLine}>{t((d) => d.plugins.status.failLine[reason])}</p>
        </div>
      );
    }
    case "notResponding":
      if (framed || waited) return unavailable;
      return (
        <NotRespondingOverlay
          name={name}
          tier={plugin.tier}
          takeoverLine={body.takeoverLine}
          focusInFrame={() => false}
          onWait={() => setWaited(true)}
          onDisable={() => disablePlugin(plugin.id)}
        />
      );
    case "gone":
      return null;
    case "frame":
    case "none":
      return unavailable;
  }
}
