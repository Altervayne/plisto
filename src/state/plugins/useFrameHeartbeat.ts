/*
 * Runs the liveness machine of every mounted plugin frame on one shared interval: pings each loaded frame,
 * feeds accepted pongs back, pauses every machine while the main document is hidden and resumes them with
 * a fresh silence budget. Only phase changes reach the health store, never a plain tick. A frame whose
 * phase was settled elsewhere (crashed by navigation, or unavailable) is left alone.
 */

// -- Framework Imports --
import { useCallback, useEffect, useRef } from "react";

// -- State Imports --
import { useFrameHealthStore } from "./frameHealth";
import { PING_MS, hide, pong, show, start, tick, wait } from "./heartbeat";
import { isFrameLoaded, onPong, sendPing } from "./pluginHost";

// -- Type Imports --
import type { Heartbeat, HeartbeatPhase } from "./heartbeat";

/** One mounted frame as the heartbeat needs it. */
export interface HeartbeatFrame {
  mountKey: string;
  id: string;
  /** The key the crash set records, `id|version|manifest_hash`. */
  crashKey: string;
}

interface Machine {
  frame: HeartbeatFrame;
  hb: Heartbeat;
}

function settledElsewhere(id: string): boolean {
  const phase = useFrameHealthStore.getState().health[id]?.phase;
  return phase === "crashed" || phase === "unavailable";
}

function publish(machine: Machine, before: HeartbeatPhase): void {
  const { frame, hb } = machine;
  if (hb.phase === before || settledElsewhere(frame.id)) return;
  const health = useFrameHealthStore.getState();
  if (hb.phase === "crashed") health.crash(frame.id, frame.crashKey, "silent");
  else health.setPhase(frame.id, hb.phase);
}

/**
 * Keeps one machine per frame in `frames` (matched by mount key) and returns the overlay's Wait action,
 * which restarts both silence clocks of that frame.
 */
export function useFrameHeartbeat(frames: readonly HeartbeatFrame[]): (mountKey: string) => void {
  const machines = useRef(new Map<string, Machine>());
  const latest = useRef(frames);
  latest.current = frames;
  const keys = frames.map((frame) => frame.mountKey).join("\n");

  useEffect(() => {
    const now = performance.now();
    const wanted = new Map(latest.current.map((frame) => [frame.mountKey, frame]));
    for (const key of [...machines.current.keys()]) {
      const machine = machines.current.get(key);
      if (wanted.has(key) || !machine) continue;
      machines.current.delete(key);
      useFrameHealthStore.getState().release(machine.frame.id);
    }
    for (const [key, frame] of wanted) {
      if (machines.current.has(key)) continue;
      const hb = start(now);
      machines.current.set(key, { frame, hb: document.hidden ? hide(hb) : hb });
      // A new mount starts over, whatever an earlier mount of this plugin left behind.
      useFrameHealthStore.getState().setPhase(frame.id, "loading");
    }
  }, [keys]);

  useEffect(() => {
    const onVisibility = () => {
      const now = performance.now();
      for (const machine of machines.current.values()) {
        machine.hb = document.hidden ? hide(machine.hb) : show(machine.hb, now);
      }
    };
    const stopPongs = onPong((mountKey, seq) => {
      const machine = machines.current.get(mountKey);
      if (!machine) return;
      const before = machine.hb.phase;
      machine.hb = pong(machine.hb, seq, performance.now());
      publish(machine, before);
    });
    const timer = window.setInterval(() => {
      const now = performance.now();
      for (const machine of machines.current.values()) {
        if (settledElsewhere(machine.frame.id)) continue;
        const before = machine.hb.phase;
        const next = tick(machine.hb, now, isFrameLoaded(machine.frame.mountKey));
        machine.hb = next.hb;
        if (next.ping !== null) sendPing(machine.frame.mountKey, next.ping);
        publish(machine, before);
      }
    }, PING_MS);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      stopPongs();
    };
  }, []);

  return useCallback((mountKey: string) => {
    const machine = machines.current.get(mountKey);
    if (!machine) return;
    const before = machine.hb.phase;
    machine.hb = wait(machine.hb, performance.now());
    publish(machine, before);
  }, []);
}
