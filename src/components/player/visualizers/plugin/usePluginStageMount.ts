// -- Framework Imports --
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";

// -- State Imports --
import { attachFrame, detachFrame, frameLoaded } from "../../../../state/plugins/pluginHost";
import { usePluginRuntime } from "../../../../state/plugins/store";
import {
  createStageMount,
  type StageMount,
  type StagePhase,
} from "../../../../state/player/pluginVis/stageMount";
import {
  leavePhase,
  registerStage,
  reportPhase,
  type StageSurface,
} from "../../../../state/player/pluginVis/frameCache";
import { meterWanted } from "../../../../state/player/pluginVis/netPolicy";
import { kindValues } from "../../../../state/player/pluginVis/kindSettings";
import { usePlayerVisualizerSettings } from "../../../../state/preferences/store";
import type { PluginVisualizerDescriptor } from "../../../../state/player/pluginVisualizers";

// -- IPC Imports --
import { pluginVisUrl } from "../../../../lib/ipc";

// -- Local Imports --
import { readStageContext, type StageInputs } from "./stageContext";

// -- Type Imports --
import type { VisContext, VisPointer } from "../../../../visRuntime/protocol";

// Layout, theme and colors are re-read on this frame interval rather than every frame.
const SYNC_EVERY = 30;

export interface PluginStageProps extends StageInputs {
  descriptor: PluginVisualizerDescriptor;
  surface: StageSurface;
  // Whether this kind is the stage's shown kind; a frame that is not stays hidden.
  shown: boolean;
  // The frame reported an error or lost its context.
  onFail: () => void;
}

export interface PluginStageView {
  slotRef: RefObject<HTMLDivElement | null>;
  iframeRef: RefObject<HTMLIFrameElement | null>;
  src: string | null;
  phase: StagePhase;
  onLoad: () => void;
}

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Mounts one plugin frame on a stage under `mountKey`: asks for its URL once the plugin runtime runs,
 * registers it with the host as a visualizer before its first load, sends init with the port on that
 * load, and ticks it from the page's frame loop from then on, including while it compiles under the dip.
 * A second load, a closed runtime or a refused URL gives the mount up. Nothing here touches frame health,
 * so a hung or crashed visualizer never raises a page's overlay or crash card.
 */
export function usePluginStageMount(props: PluginStageProps, mountKey: string): PluginStageView {
  const { descriptor, surface, shown } = props;
  const { id: kind, pluginId } = descriptor;
  const runtime = usePluginRuntime();
  const slotRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const live = useRef(props);
  live.current = props;
  const settingsRaw = usePlayerVisualizerSettings();
  const rawRef = useRef(settingsRaw);
  rawRef.current = settingsRaw;
  const mountRef = useRef<StageMount | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [phase, setPhase] = useState<StagePhase>("mounting");

  useEffect(() => {
    const pointerAt: { current: VisPointer | null } = { current: null };
    const context = (): VisContext => {
      const settings = kindValues(descriptor, rawRef.current);
      return readStageContext(slotRef.current, live.current, descriptor, settings, reducedMotion());
    };
    const mount = createStageMount({
      descriptor,
      context,
      reactivity: () => live.current.reactivity,
      pointer: () => pointerAt.current,
      onPhase: (next) => {
        reportPhase(surface, kind, next);
        setPhase(next);
      },
      onFail: () => live.current.onFail(),
      meter: () => meterWanted(kind),
    });
    mountRef.current = mount;
    reportPhase(surface, kind, "mounting");
    const unregister = registerStage({
      surface,
      kind,
      phase: mount.phase,
      visible: mount.visible,
      shown: () => live.current.shown,
      stats: mount.stats,
      url: () => iframeRef.current?.src || null,
      metered: mount.metered,
      flash: mount.flash,
      setMeter: mount.setMeter,
      hold: mount.hold,
      end: mount.end,
    });

    let raf = 0;
    let frames = 0;
    const loop = (now: number) => {
      mount.step(now);
      if (++frames % SYNC_EVERY === 0) mount.sync();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    const onVisibility = () => mount.setInputs({ documentVisible: document.visibilityState === "visible" });
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) mount.setInputs({ intersecting: entry.isIntersecting });
    });
    if (slotRef.current) observer.observe(slotRef.current);

    // The pointer is read from the stage, so the frame never needs pointer events of its own.
    const onPointer = (event: PointerEvent) => {
      const box = slotRef.current?.getBoundingClientRect();
      if (!box || box.width <= 0 || box.height <= 0) return;
      const x = (event.clientX - box.left) / box.width;
      const y = (event.clientY - box.top) / box.height;
      pointerAt.current = { x, y, inside: x >= 0 && x <= 1 && y >= 0 && y <= 1 };
    };
    if (descriptor.needs.pointer) window.addEventListener("pointermove", onPointer);

    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVisibility);
      observer.disconnect();
      window.removeEventListener("pointermove", onPointer);
      unregister();
      mount.dispose();
      mountRef.current = null;
      leavePhase(surface, kind);
    };
    // One mount per key; the props it reads later come through `live`.
  }, [mountKey]);

  useEffect(() => {
    if (runtime === "held" || runtime === "safe") {
      mountRef.current?.end();
      return;
    }
    if (runtime !== "running") return;
    let cancelled = false;
    pluginVisUrl(pluginId, descriptor.kindId)
      .then((url) => {
        if (!cancelled) setSrc((prev) => prev ?? url);
      })
      .catch(() => {
        if (!cancelled) mountRef.current?.end();
      });
    return () => {
      cancelled = true;
    };
  }, [runtime, mountKey, pluginId, descriptor.kindId]);

  useLayoutEffect(() => {
    const win = iframeRef.current?.contentWindow;
    if (src == null || !win) return;
    attachFrame(mountKey, pluginId, win, "visualizer");
    return () => detachFrame(mountKey);
  }, [src, mountKey, pluginId]);

  // A changed setting reaches the frame at once rather than at the next periodic sync.
  useEffect(() => {
    mountRef.current?.sync();
  }, [settingsRaw]);

  // Ticks flow while compiling at opacity 0; once drawn, only while the frame is the one on the stage.
  useEffect(() => {
    mountRef.current?.setInputs({ opacity: shown && phase === "ready" ? 1 : 0 });
  }, [shown, phase]);

  const onLoad = () => {
    const win = iframeRef.current?.contentWindow;
    const mount = mountRef.current;
    if (!mount) return;
    if (frameLoaded(mountKey) === "again" || !win) {
      mount.end();
      return;
    }
    mount.start((init, port) => win.postMessage(init, "*", [port]));
  };

  return { slotRef, iframeRef, src, phase, onLoad };
}
