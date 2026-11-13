// -- Framework Imports --
import { useEffect, useLayoutEffect, useRef, useState } from "react";

// -- Component Imports --
import { NotRespondingOverlay } from "./NotRespondingOverlay";

// -- State Imports --
import { useFrameHealthStore } from "../../../state/plugins/frameHealth";
import {
  attachFrame,
  detachFrame,
  frameLoaded,
  isFrameLoaded,
  sendInit,
  sendVisibility,
} from "../../../state/plugins/pluginHost";

// -- IPC Imports --
import { pluginFrameUrl } from "../../../lib/ipc";

// -- Utils Imports --
import { disablePlugin } from "./disablePlugin";
import { wrapperView } from "./wrapperView";

// -- Type Imports --
import type { FramePhase, FrameWant } from "../../../state/plugins/frameModel";
import type { FrameRect } from "./wrapperView";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Style Imports --
import styles from "./PluginFrame.module.css";

/**
 * One plugin frame: a wrapper and a sandboxed iframe, keyed by the caller on the mount key so a frame is
 * never reused for another plugin, version or restart. The frame URL is asked for on mount and never
 * cached. The iframe's `src` is set once, and the frame is registered with the host before its first load.
 */
export function PluginFrame({
  want,
  crashKey,
  phase,
  pageOpen,
  rect,
  route,
  onWait,
}: {
  want: FrameWant;
  crashKey: string;
  phase: FramePhase | undefined;
  /** Whether this frame's page is the open one. */
  pageOpen: boolean;
  rect: FrameRect | null;
  /** The route the plugin's page was opened on, handed over at init. */
  route: string | null;
  onWait: (mountKey: string) => void;
}) {
  const t = useT();
  const { mountKey, id, entry, name } = want;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const routeRef = useRef(route);
  routeRef.current = route;
  const [src, setSrc] = useState<string | null>(null);

  // A new mount starts over: whatever phase an earlier mount of this plugin left must not show for a frame.
  useLayoutEffect(() => {
    useFrameHealthStore.getState().setPhase(id, "loading");
  }, [id, mountKey]);

  useEffect(() => {
    let cancelled = false;
    const unavailable = () => {
      if (!cancelled) useFrameHealthStore.getState().setPhase(id, "unavailable");
    };
    pluginFrameUrl(id)
      .then((base) => {
        if (cancelled) return;
        if (base == null) unavailable();
        else setSrc((prev) => prev ?? `${base}${entry.replace(/^\/+/, "")}`);
      })
      .catch(unavailable);
    return () => {
      cancelled = true;
    };
  }, [id, mountKey, entry]);

  useLayoutEffect(() => {
    const win = iframeRef.current?.contentWindow;
    if (src == null || !win) return;
    attachFrame(mountKey, id, win);
    return () => detachFrame(mountKey);
  }, [src, mountKey, id]);

  // After the attach above, so the host has a record to hold the value for init.
  useLayoutEffect(() => {
    if (src != null) sendVisibility(mountKey, pageOpen);
  }, [src, mountKey, pageOpen]);

  const onLoad = () => {
    const health = useFrameHealthStore.getState();
    if (frameLoaded(mountKey) === "again") {
      health.crash(id, crashKey, "navigated");
      return;
    }
    void sendInit(mountKey, routeRef.current).then((ok) => {
      // Alive but never initialised: the host could not read its own app info.
      if (!ok && isFrameLoaded(mountKey)) health.crash(id, crashKey, "init");
    });
  };

  const view = wrapperView(want, phase, rect);

  return (
    <div
      className={view.shown ? styles.shown : styles.hidden}
      style={view.style}
      inert={view.inert}
      aria-hidden={view.ariaHidden ? true : undefined}
    >
      {src != null ? (
        <iframe
          ref={iframeRef}
          className={styles.frame}
          title={t((d) => d.plugins.frame.title, { name })}
          src={src}
          sandbox="allow-scripts"
          referrerPolicy="strict-origin"
          onLoad={onLoad}
        />
      ) : null}
      {view.shown && phase === "not_responding" ? (
        <NotRespondingOverlay
          name={name}
          focusInFrame={() => document.activeElement === iframeRef.current}
          onWait={() => onWait(mountKey)}
          onDisable={() => disablePlugin(id)}
        />
      ) : null}
    </div>
  );
}
