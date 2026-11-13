// -- Framework Imports --
import { useLayoutEffect, useRef } from "react";

// -- Component Imports --
import { CrashCard } from "./CrashCard";
import { disablePlugin } from "./frames/disablePlugin";
import { PluginIcon } from "./PluginIcon";
import { PluginTag } from "./PluginTag";

// -- State Imports --
import { useFrameHealth, useFrameHealthStore } from "../../state/plugins/frameHealth";
import { useFrameSlotStore } from "../../state/plugins/frameSlot";
import { pluginRuntimeReady } from "../../state/plugins/frameModel";
import { usePlugin, usePluginsBoot } from "../../state/plugins/store";

// -- Utils Imports --
import { tagKind } from "../../state/plugins/trust";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./PluginPage.module.css";

/**
 * A plugin's page: the Plisto-drawn header (icon, name, tag, one status line) over a soft recess. The
 * recess is where the plugin's frame sits: it registers itself as the frame slot, and the frame layer
 * positions the shown frame over it. While the frame is not showing, the recess holds the Starting
 * card, the crash card or the unavailable line. Draws nothing for a plugin that is gone; the shell
 * leaves the page for its landing in that case.
 */
export function PluginPage({ id }: { id: string }) {
  const t = useT();
  const plugin = usePlugin(id);
  const health = useFrameHealth(id);
  const boot = usePluginsBoot();
  const recess = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = recess.current;
    if (!el) return;
    const slot = { id, el };
    useFrameSlotStore.getState().setSlot(slot);
    return () => useFrameSlotStore.getState().clearSlot(slot);
  }, [id]);

  if (!plugin || !plugin.manifest) return null;
  const tag = tagKind(plugin.tier);
  const name = plugin.manifest.name;
  const framed = plugin.tier === "ui";
  // No health entry yet: the frame is about to mount.
  const runtimeReady = pluginRuntimeReady(boot);
  const phase = health?.phase ?? "loading";
  const cannotOpen = framed && (!runtimeReady || phase === "unavailable");
  const warn = framed && (phase === "not_responding" || phase === "crashed");
  const status =
    !framed || cannotOpen
      ? null
      : phase === "loading"
        ? t((d) => d.plugins.frame.statusStarting)
        : phase === "not_responding"
          ? t((d) => d.plugins.frame.statusNotResponding)
          : phase === "crashed"
            ? t((d) => d.plugins.frame.statusStopped)
            : null;

  return (
    <div className={styles.view}>
      <div className={styles.head}>
        <PluginIcon source={{ kind: "installed", id, hash: plugin.manifest_hash }} size={32} />
        <div className={styles.ttl}>
          <div className={styles.titleRow}>
            <h1 className={styles.title}>{name}</h1>
            {tag ? <PluginTag kind={tag} /> : null}
          </div>
          <p className={styles.sub}>
            {warn ? <span className={styles.warnDot} aria-hidden="true" /> : null}
            {status ? <span>{status}</span> : null}
            <span>{t((d) => d.plugins.frame.version, { version: plugin.version })}</span>
          </p>
        </div>
      </div>
      <div className={styles.recess} ref={recess}>
        {!framed ? (
          <p className={styles.line}>{t((d) => d.plugins.pageUnavailable, { name })}</p>
        ) : cannotOpen ? (
          <p className={styles.line}>{t((d) => d.plugins.frame.unavailable, { name })}</p>
        ) : phase === "loading" ? (
          <div className={styles.card}>
            <h2 className={styles.cardTitle}>{t((d) => d.plugins.frame.starting, { name })}</h2>
            <p className={styles.cardLine}>{t((d) => d.plugins.frame.startingLine)}</p>
          </div>
        ) : phase === "crashed" ? (
          <CrashCard
            name={name}
            reason={health?.reason}
            onRestart={() => useFrameHealthStore.getState().restart(id)}
            onDisable={() => disablePlugin(id)}
          />
        ) : null}
      </div>
    </div>
  );
}
