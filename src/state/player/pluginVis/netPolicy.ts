/*
 * Which plugin visualizer kinds the stage stops, and when the flash meter runs. A kind stops for the
 * session once it hung or ran too slow, and across launches while it carries a mark: a graphics reset
 * always, flashing only while the stop-flashing setting is on and the user has not turned the kind back
 * on. Until the first marks read answers every plugin kind is held, so none mounts; reads retry, and a
 * failed read keeps what was known and never reads as no marks. A mark written here counts at once and
 * until a read issued after the write lands.
 */

// -- Library Imports --
import { create } from "zustand";

// -- State Imports --
import { isPluginKindId, type PluginKindId } from "../pluginVisualizers";
import { usePluginsStore } from "../../plugins/store";
import { selectStopFlashing, usePreferencesStore } from "../../preferences/store";

// -- IPC Imports --
import { pluginVisMark, pluginVisMarks } from "../../../lib/ipc";

// -- Utils Imports --
import { withRetry, type RetryRun } from "../../../lib/withRetry";

// -- Type Imports --
import type { PluginVisKindState, PluginVisMark } from "../../../types";
import type { VisualizerKind } from "../visualizerKind";

/** Why a kind stopped for this session only. */
export type SessionStop = "hang" | "slow";

/** A mark written here: counted until a read issued after the write settled (`after`) lands. */
interface PendingMark {
  mark: PluginVisMark;
  after: number | null;
}

interface NetPolicyState {
  // Whether a marks read has answered once.
  loaded: boolean;
  // By kind id.
  session: Readonly<Record<string, SessionStop>>;
  marks: Readonly<Record<string, PluginVisKindState>>;
  pending: Readonly<Record<string, PendingMark>>;
}

const EMPTY: NetPolicyState = { loaded: false, session: {}, marks: {}, pending: {} };

export const useNetPolicy = create<NetPolicyState>(() => EMPTY);

/** A kind's stored state with any mark written here folded in. */
export function markOf(state: NetPolicyState, kind: string): PluginVisKindState | undefined {
  const stored = state.marks[kind];
  const pending = state.pending[kind];
  if (!pending) return stored;
  const slash = kind.indexOf("/");
  const base = stored ?? {
    id: kind.slice(0, slash),
    kind: kind.slice(slash + 1),
    flashing: false,
    graphics_reset: false,
    turned_back_on: false,
    trialed: false,
  };
  const turnedBackOn = pending.mark === "flashing" ? false : base.turned_back_on;
  return { ...base, [pending.mark]: true, turned_back_on: turnedBackOn };
}

/** Whether a mark stops its kind: a reset always, flashing under the setting unless turned back on. */
export function markStops(mark: PluginVisKindState | undefined, stopFlashing: boolean): boolean {
  if (!mark) return false;
  return mark.graphics_reset || (mark.flashing && stopFlashing && !mark.turned_back_on);
}

/** Whether a kind may not mount: the marks are not read yet, or its mark stops it. */
export function kindHeld(state: NetPolicyState, kind: string, stopFlashing: boolean): boolean {
  return !state.loaded || markStops(markOf(state, kind), stopFlashing);
}

/** Whether the stage stops a kind: held, or stopped for the session. */
export function kindStopped(state: NetPolicyState, kind: string, stopFlashing: boolean): boolean {
  return state.session[kind] !== undefined || kindHeld(state, kind, stopFlashing);
}

/** What a tripped flash meter leads to: a stop under the setting, a log in dev mode, else nothing. */
export function flashAction(input: {
  stopFlashing: boolean;
  devMode: boolean;
  turnedBackOn: boolean;
}): "stop" | "log" | "ignore" {
  if (input.stopFlashing && !input.turnedBackOn) return "stop";
  return input.devMode ? "log" : "ignore";
}

/** Whether a kind's frame runs the flash meter: in dev mode, or under the setting unless turned back on. */
export function meterFor(
  state: NetPolicyState,
  kind: string,
  stopFlashing: boolean,
  devMode: boolean,
): boolean {
  return devMode || (stopFlashing && !markOf(state, kind)?.turned_back_on);
}

const stopFlashingNow = () => selectStopFlashing(usePreferencesStore.getState());
const devModeNow = () => usePluginsStore.getState().devMode;

/** Whether a kind's frame should run the flash meter now. */
export const meterWanted = (kind: string): boolean =>
  meterFor(useNetPolicy.getState(), kind, stopFlashingNow(), devModeNow());

/** What a tripped meter on a kind leads to now; a stop waits until the marks say if it was turned back on. */
export function flashActionNow(kind: string): "stop" | "log" | "ignore" | "wait" {
  const state = useNetPolicy.getState();
  const turnedBackOn = markOf(state, kind)?.turned_back_on ?? false;
  const action = flashAction({ stopFlashing: stopFlashingNow(), devMode: devModeNow(), turnedBackOn });
  return action === "stop" && !state.loaded ? "wait" : action;
}

/** Whether a kind is stopped now. */
export const isKindStopped = (kind: string): boolean =>
  kindStopped(useNetPolicy.getState(), kind, stopFlashingNow());

/** Whether the stage stops a kind; false for a built-in kind. */
export function useKindStopped(kind: VisualizerKind | null): boolean {
  const stopFlashing = usePreferencesStore(selectStopFlashing);
  return useNetPolicy((s) => kind != null && isPluginKindId(kind) && kindStopped(s, kind, stopFlashing));
}

/** Whether a kind may not mount, as of this render. */
export function useKindHeld(): (kind: string) => boolean {
  const stopFlashing = usePreferencesStore(selectStopFlashing);
  const state = useNetPolicy();
  return (kind) => kindHeld(state, kind, stopFlashing);
}

/** Stops a kind until the app restarts, writing nothing; false when it was already stopped so. */
export function stopForSession(kind: PluginKindId, cause: SessionStop): boolean {
  if (useNetPolicy.getState().session[kind]) return false;
  useNetPolicy.setState((s) => ({ session: { ...s.session, [kind]: cause } }));
  return true;
}

// -- Marks reads --

let epoch = 0;
let run: RetryRun | null = null;

/** Reads the marks again, replacing a read still running; the last answer to land wins. */
export function reloadVisMarks(): number {
  run?.cancel();
  const mine = ++epoch;
  run = withRetry(pluginVisMarks, {
    nextSeq: () => mine,
    onAnswer: (rows) => {
      if (mine !== epoch) return;
      const marks: Record<string, PluginVisKindState> = {};
      for (const row of rows) marks[`${row.id}/${row.kind}`] = row;
      useNetPolicy.setState((s) => {
        const pending = Object.fromEntries(
          Object.entries(s.pending).filter(([, p]) => p.after == null || p.after > mine),
        );
        return { loaded: true, marks, pending };
      });
    },
  });
  return mine;
}

/** Writes a mark, which counts at once; a failed write keeps it for the session. */
export function writeVisMark(
  kind: PluginKindId,
  pluginId: string,
  kindId: string,
  mark: PluginVisMark,
): Promise<void> {
  useNetPolicy.setState((s) => ({ pending: { ...s.pending, [kind]: { mark, after: null } } }));
  return pluginVisMark(pluginId, kindId, mark).then(
    () => {
      const after = reloadVisMarks();
      useNetPolicy.setState((s) =>
        s.pending[kind]?.mark === mark ? { pending: { ...s.pending, [kind]: { mark, after } } } : s,
      );
    },
    () => {},
  );
}

/** Reads the marks now and again whenever the plugin rows change, until the returned teardown runs. */
export function startVisMarks(): () => void {
  reloadVisMarks();
  const unsubscribe = usePluginsStore.subscribe((state, prev) => {
    if (state.rows !== prev.rows) reloadVisMarks();
  });
  return () => {
    unsubscribe();
    run?.cancel();
    run = null;
  };
}

/** Forgets every stop and mark. For tests, which share the module. */
export function resetNetPolicy(): void {
  run?.cancel();
  run = null;
  useNetPolicy.setState(EMPTY);
}
