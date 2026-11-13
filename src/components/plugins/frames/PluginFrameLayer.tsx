// -- Framework Imports --
import { useEffect, useMemo, useRef, useState } from "react";

// -- Component Imports --
import { PluginFrame } from "./PluginFrame";

// -- Hook Imports --
import { useTrackedRect } from "./useTrackedRect";
import { useFrameHeartbeat } from "../../../state/plugins/useFrameHeartbeat";

// -- State Imports --
import { useFrameHealthStore } from "../../../state/plugins/frameHealth";
import { useFrameSlot } from "../../../state/plugins/frameSlot";
import {
  backgroundOrder,
  crashKey,
  nextRelease,
  pluginRuntimeReady,
  wantedFrames,
} from "../../../state/plugins/frameModel";
import { startPluginHost } from "../../../state/plugins/pluginHost";
import { usePlugins, usePluginsBoot } from "../../../state/plugins/store";
import { useAppMode } from "../../../state/player/store";
import { usePluginRoute } from "../../../state/shell/store";

// -- IPC Imports --
import { pluginPageState } from "../../../lib/ipc";

// -- Utils Imports --
import { livePlugins } from "../../shell/navVisibility";

// -- Style Imports --
import styles from "./PluginFrameLayer.module.css";

/** How often the stagger checks whether the next background frame is due, in ms. */
const STAGGER_CHECK_MS = 500;

const reportPage = (id: string, open: boolean) => {
  pluginPageState(id, open).catch(() => {
    // The report is best-effort: the next one overwrites a stale value.
  });
};

/**
 * Owns every plugin frame. It starts the host shim, runs the heartbeat, mounts the frames the model
 * wants (background ones staggered in install order, the page's frame at once), positions the shown one
 * over the page's slot and reports which page is open. Frames render only once the shim is listening,
 * because a child's attach runs before its parent's effects. `pageId` is the plugin whose page is the
 * shown destination, or null.
 */
export function PluginFrameLayer({ pageId }: { pageId: string | null }) {
  const rows = usePlugins();
  const boot = usePluginsBoot();
  const appMode = useAppMode();
  const route = usePluginRoute();
  const crashed = useFrameHealthStore((s) => s.crashed);
  const generation = useFrameHealthStore((s) => s.generation);
  const health = useFrameHealthStore((s) => s.health);
  const slot = useFrameSlot();

  const [hostReady, setHostReady] = useState(false);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [released, setReleased] = useState<ReadonlySet<string>>(() => new Set());
  const releasedRef = useRef(released);
  const mountedAt = useRef(new Map<string, number>());
  const prevOpen = useRef<string | null>(null);

  useEffect(() => {
    const stop = startPluginHost();
    setHostReady(true);
    return () => {
      stop();
      setHostReady(false);
    };
  }, []);

  const runtime = pluginRuntimeReady(boot);
  const order = useMemo(() => backgroundOrder(rows), [rows]);

  const wants = useMemo(
    () =>
      hostReady
        ? wantedFrames({ rows, appMode, pageId, runtime, crashed, released, generation })
        : [],
    [hostReady, rows, appMode, pageId, runtime, crashed, released, generation],
  );

  useEffect(() => {
    useFrameHealthStore.getState().prune(new Set(livePlugins(rows).map((row) => row.id)));
  }, [rows]);

  // Mount times, for the stagger.
  useEffect(() => {
    const now = performance.now();
    const ids = new Set(wants.map((want) => want.id));
    for (const id of ids) if (!mountedAt.current.has(id)) mountedAt.current.set(id, now);
    for (const id of [...mountedAt.current.keys()]) if (!ids.has(id)) mountedAt.current.delete(id);
  }, [wants]);

  // A plugin that left the background set starts the stagger over if it comes back.
  useEffect(() => {
    const keep = [...releasedRef.current].filter((id) => order.includes(id));
    if (keep.length === releasedRef.current.size) return;
    releasedRef.current = new Set(keep);
    setReleased(releasedRef.current);
  }, [order]);

  // Opening a background plugin's page releases it from the stagger, so leaving the page keeps its frame.
  useEffect(() => {
    if (pageId == null || !order.includes(pageId) || releasedRef.current.has(pageId)) return;
    releasedRef.current = new Set(releasedRef.current).add(pageId);
    setReleased(releasedRef.current);
  }, [pageId, order]);

  useEffect(() => {
    if (!hostReady || !runtime) return;
    let timer: number | undefined;
    const step = () => {
      const phases = useFrameHealthStore.getState().health;
      const next = nextRelease(
        order,
        releasedRef.current,
        (id) => phases[id]?.phase,
        (id) => mountedAt.current.get(id),
        performance.now(),
      );
      if (next != null) {
        releasedRef.current = new Set(releasedRef.current).add(next);
        setReleased(releasedRef.current);
      }
      if (order.every((id) => releasedRef.current.has(id)) && timer !== undefined) {
        window.clearInterval(timer);
        timer = undefined;
      }
    };
    step();
    if (!order.every((id) => releasedRef.current.has(id))) {
      timer = window.setInterval(step, STAGGER_CHECK_MS);
    }
    return () => {
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [hostReady, runtime, order]);

  const rowById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);
  const crashKeyOf = (id: string) => {
    const row = rowById.get(id);
    return row ? crashKey(row) : id;
  };
  const heartbeatFrames = wants.map((want) => ({
    mountKey: want.mountKey,
    id: want.id,
    crashKey: crashKeyOf(want.id),
  }));
  const onWait = useFrameHeartbeat(heartbeatFrames);

  const slotEl = slot && slot.id === pageId ? slot.el : null;
  const rect = useTrackedRect(slotEl, root?.parentElement ?? null);

  // The open page: the active frame while it is neither crashed nor unavailable.
  const active = wants.find((want) => want.active);
  const activePhase = active ? health[active.id]?.phase : undefined;
  const open = active && activePhase !== "crashed" && activePhase !== "unavailable" ? active : null;
  const openId = open?.id ?? null;
  const openKey = open?.mountKey ?? null;

  // Rust hears which page is open; each frame hears its own state from its PluginFrame.
  useEffect(() => {
    const prev = prevOpen.current;
    prevOpen.current = openId;
    if (prev === openId) return;
    if (prev != null) reportPage(prev, false);
    if (openId != null) reportPage(openId, true);
  }, [openId]);

  useEffect(
    () => () => {
      if (prevOpen.current != null) reportPage(prevOpen.current, false);
    },
    [],
  );

  return (
    <div ref={setRoot} className={styles.layer}>
      {wants.map((want) => (
        <PluginFrame
          key={want.mountKey}
          want={want}
          crashKey={crashKeyOf(want.id)}
          phase={health[want.id]?.phase}
          pageOpen={want.mountKey === openKey}
          rect={want.active ? rect : null}
          route={want.active ? route : null}
          onWait={onWait}
        />
      ))}
    </div>
  );
}
