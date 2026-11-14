// -- Framework Imports --
import { useLayoutEffect, useRef } from "react";

// -- Component Imports --
import { Tooltip } from "../common/Tooltip";
import { PluginIcon } from "./PluginIcon";
import { PluginPageBody } from "./PluginPageBody";
import { PluginTag } from "./PluginTag";

// -- State Imports --
import { useFrameHealth } from "../../state/plugins/frameHealth";
import { useFrameSlotStore } from "../../state/plugins/frameSlot";
import { pluginRuntimeReady } from "../../state/plugins/frameModel";
import { usePluginStatusOf } from "../../state/plugins/pluginStatus";
import { crashDetail, pageState, statusView } from "../../state/plugins/statusModel";
import { usePlugin, usePluginsBoot } from "../../state/plugins/store";

// -- Utils Imports --
import { statusLabel } from "./statusText";
import { tagKind } from "../../state/plugins/trust";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./PluginPage.module.css";

/** The header's status words, cut to one line; the full text is in the tooltip. */
function HeadStatus({ text }: { text: string }) {
  return (
    <Tooltip label={text}>
      <span className={styles.statusText}>{text}</span>
    </Tooltip>
  );
}

/**
 * A plugin's page: the Plisto-drawn header (icon, name, tag, one status line) over a soft recess. The
 * recess is where the plugin's frame sits: it registers itself as the frame slot, and the frame layer
 * positions the shown frame over it. While the frame is not showing, the recess holds what the plugin's
 * state calls for (see PluginPageBody). Draws nothing for a plugin that is gone; the shell leaves the
 * page for its landing in that case.
 */
export function PluginPage({ id }: { id: string }) {
  const t = useT();
  const plugin = usePlugin(id);
  const health = useFrameHealth(id);
  const boot = usePluginsBoot();
  const status = usePluginStatusOf(id);
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
  const runtimeReady = pluginRuntimeReady(boot);
  const cannotOpen = framed && (!runtimeReady || health?.phase === "unavailable");
  // No health entry yet: the frame is about to mount.
  const page = pageState(
    statusView(boot?.runtime ?? null, plugin, status),
    framed,
    health?.phase ?? "loading",
  );
  const head = cannotOpen ? null : page.head;
  const detail = crashDetail(status?.crash ?? null, health?.reason ?? null);

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
            {page.warn && !cannotOpen ? <span className={styles.warnDot} aria-hidden="true" /> : null}
            {head ? <HeadStatus text={statusLabel(head, t)} /> : null}
            <span>{t((d) => d.plugins.frame.version, { version: plugin.version })}</span>
          </p>
        </div>
      </div>
      <div className={styles.recess} ref={recess}>
        {cannotOpen ? (
          <p className={styles.line}>{t((d) => d.plugins.frame.unavailable, { name })}</p>
        ) : (
          <PluginPageBody plugin={plugin} body={page.body} framed={framed} detail={detail} />
        )}
      </div>
    </div>
  );
}
