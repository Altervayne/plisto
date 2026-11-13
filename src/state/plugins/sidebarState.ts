/*
 * The live sidebar state plugins set: chips and item states per plugin, and which toggles wait for their
 * plugin's answer. Every event goes through the per-key coalescing of sidebarModel, so one item changes
 * visibly at most once per COALESCE_MS, and its appearance at most once per APPEARANCE_MS; the held value lands on one timer per key. Each plugin's entry
 * carries the crash key it was set under, so a disable, update or uninstall drops it through `prune`.
 */

// -- Library Imports --
import { create } from "zustand";

// -- State Imports --
import { useFrameHealthStore } from "./frameHealth";
import { TOGGLE_PENDING_MS, appearanceSig, chipsKey, coalesce, flush, itemKey } from "./sidebarModel";

// -- Type Imports --
import type { CoalesceState } from "./sidebarModel";
import type { PluginChip, PluginItemState, PluginSidebarEvent, PluginSidebarSnapshot } from "../../types";

/** One plugin's live state, set under the crash key (`id|version|manifest_hash`) of its row. */
export interface PluginLiveSidebar {
  key: string;
  chips: PluginChip[];
  items: Record<string, PluginItemState>;
}

interface SidebarStateStore {
  byPlugin: Record<string, PluginLiveSidebar>;
  /** Deadline per pending toggle, keyed `id|item`. */
  pending: Record<string, number>;
  /** Replaces every entry with the boot read. Snapshots without a key in `keys` are skipped. */
  applySnapshot: (snapshots: PluginSidebarSnapshot[], keys: ReadonlyMap<string, string>) => void;
  /** Takes one pushed change for the plugin whose row has crash key `key`. */
  applyEvent: (event: PluginSidebarEvent, key: string) => void;
  setPending: (id: string, itemId: string) => void;
  clearPending: (id: string, itemId: string) => void;
  /** Forgets everything held for one plugin. */
  drop: (id: string) => void;
  /** Drops every plugin whose stored key is not its live row's crash key. */
  prune: (liveKeys: ReadonlyMap<string, string>) => void;
}

/** A coalesced value: the event and the crash key it arrived under. */
interface Arrival {
  event: PluginSidebarEvent;
  key: string;
}

// Kept off the store: the coalescing clock and its timers are never rendered.
let coalesced: CoalesceState<Arrival> = {};
const flushTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

const isCrashed = (id: string) => useFrameHealthStore.getState().health[id]?.phase === "crashed";

const ownedBy = (id: string, key: string) => key.startsWith(`${id}|`);

function forgetTimers(id: string): void {
  for (const timers of [flushTimers, pendingTimers]) {
    for (const [key, timer] of timers) {
      if (!ownedBy(id, key)) continue;
      clearTimeout(timer);
      timers.delete(key);
    }
  }
  coalesced = without(coalesced, (key) => ownedBy(id, key));
}

/** The record without the matching keys; the same object when none match. */
function without<T>(rec: Record<string, T>, drop: (key: string) => boolean): Record<string, T> {
  return Object.keys(rec).some(drop) ? Object.fromEntries(Object.entries(rec).filter(([key]) => !drop(key))) : rec;
}

export const useSidebarState = create<SidebarStateStore>((set, get) => {
  /**
   * Draws one arrival. An item change also ends that item's pending state, at the moment it is drawn, so
   * a held confirming update does not undim the toggle before its knob moves.
   */
  const draw = ({ event, key }: Arrival) => {
    if (isCrashed(event.id)) return;
    if (event.kind === "item") get().clearPending(event.id, event.item_id);
    set((s) => {
      const prev = s.byPlugin[event.id];
      const base: PluginLiveSidebar = prev && prev.key === key ? prev : { key, chips: [], items: {} };
      const next: PluginLiveSidebar =
        event.kind === "chips"
          ? { ...base, chips: event.chips }
          : { ...base, items: { ...base.items, [event.item_id]: event.state } };
      return { byPlugin: { ...s.byPlugin, [event.id]: next } };
    });
  };

  const onFlush = (ckey: string) => {
    flushTimers.delete(ckey);
    const step = flush(coalesced, ckey, Date.now());
    coalesced = step.state;
    if (step.show) draw(step.show);
  };

  return {
    byPlugin: {},
    pending: {},

    applySnapshot: (snapshots, keys) => {
      const byPlugin: Record<string, PluginLiveSidebar> = {};
      for (const snap of snapshots) {
        const key = keys.get(snap.id);
        if (key == null || isCrashed(snap.id)) continue;
        const items: Record<string, PluginItemState> = {};
        for (const item of snap.items) items[item.item_id] = item.state;
        byPlugin[snap.id] = { key, chips: snap.chips, items };
      }
      set({ byPlugin });
    },

    applyEvent: (event, key) => {
      if (isCrashed(event.id)) return;
      const ckey = event.kind === "chips" ? chipsKey(event.id) : itemKey(event.id, event.item_id);
      const now = Date.now();
      // A user's press is answered at the content pace: the update that ends a pending toggle is not held.
      const quick = event.kind === "item" && itemKey(event.id, event.item_id) in get().pending;
      const incoming = { key: ckey, value: { event, key }, appearance: appearanceSig(event), quick };
      const step = coalesce(coalesced, incoming, now);
      coalesced = step.state;
      if (step.show) draw(step.show);
      // The due time of a held value can move either way, so the timer follows the latest one.
      const old = flushTimers.get(ckey);
      if (old && (step.flushAt != null || step.show)) {
        clearTimeout(old);
        flushTimers.delete(ckey);
      }
      if (step.flushAt != null) {
        flushTimers.set(ckey, setTimeout(() => onFlush(ckey), Math.max(0, step.flushAt - now)));
      }
    },

    setPending: (id, itemId) => {
      const key = itemKey(id, itemId);
      const deadline = Date.now() + TOGGLE_PENDING_MS;
      const old = pendingTimers.get(key);
      if (old) clearTimeout(old);
      pendingTimers.set(key, setTimeout(() => get().clearPending(id, itemId), TOGGLE_PENDING_MS));
      set((s) => ({ pending: { ...s.pending, [key]: deadline } }));
    },

    clearPending: (id, itemId) => {
      const key = itemKey(id, itemId);
      const timer = pendingTimers.get(key);
      if (timer) {
        clearTimeout(timer);
        pendingTimers.delete(key);
      }
      set((s) => {
        if (!(key in s.pending)) return s;
        const { [key]: _gone, ...pending } = s.pending;
        return { pending };
      });
    },

    drop: (id) => {
      forgetTimers(id);
      set((s) => {
        const byPlugin = without(s.byPlugin, (key) => key === id);
        const pending = without(s.pending, (key) => ownedBy(id, key));
        return byPlugin === s.byPlugin && pending === s.pending ? s : { byPlugin, pending };
      });
    },

    prune: (liveKeys) => {
      const gone = Object.entries(get().byPlugin)
        .filter(([id, entry]) => liveKeys.get(id) !== entry.key)
        .map(([id]) => id);
      gone.forEach((id) => get().drop(id));
    },
  };
});

const NO_CHIPS: PluginChip[] = [];

// -- Selectors (narrow: one value each, stable until it changes) --

export const usePluginChips = (id: string): PluginChip[] =>
  useSidebarState((s) => s.byPlugin[id]?.chips ?? NO_CHIPS);
export const useItemState = (id: string, itemId: string): PluginItemState | undefined =>
  useSidebarState((s) => s.byPlugin[id]?.items[itemId]);
export const useItemPending = (id: string, itemId: string): boolean =>
  useSidebarState((s) => itemKey(id, itemId) in s.pending);
