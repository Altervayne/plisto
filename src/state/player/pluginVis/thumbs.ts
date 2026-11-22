/*
 * The thumbnails of plugin kinds: one still per theme for each kind, rendered by Plisto in the background
 * and stored through the backend under the kind's build. A kind is checked when it first appears, when its
 * version, manifest or install time changes, and whenever the backend holds no image for it; a missing
 * image is rendered, stored and shown, one at a time. The shown images are object URLs, revoked as soon as
 * a build changes or a kind goes away, so a surface reads a still of the current build or none. A recheck
 * keeps the shown images until the store answers again, then swaps them; a read that fails keeps them and
 * marks nothing. A replaced build is rendered again without reading the store, so its new image overwrites
 * whatever a render of the old build stored meanwhile. A render that started before a build change, a
 * recheck or a replaced build is dropped unstored. A kind the stage nets hold or stop is never mounted for
 * a thumbnail. A thumbnail that cannot be stored is still shown.
 */

// -- Library Imports --
import { create } from "zustand";

// -- Type Imports --
import type { PluginVisTheme } from "../../../types";

export type ThumbTheme = PluginVisTheme;

const THEMES: readonly ThumbTheme[] = ["light", "dark"];

/** A plugin kind to keep thumbnails for, with a signature that changes with its build. */
export interface ThumbEntry {
  id: string;
  pluginId: string;
  kindId: string;
  sig: string;
}

/** What the engine touches outside itself. */
export interface ThumbDeps {
  get: (pluginId: string, kindId: string, theme: ThumbTheme) => Promise<ArrayBuffer | null>;
  put: (pluginId: string, kindId: string, theme: ThumbTheme, png: Uint8Array) => Promise<void>;
  // Renders and encodes one still; null when the kind has none. The signal aborts the mount.
  render: (id: string, theme: ThumbTheme, signal: AbortSignal) => Promise<Uint8Array | null>;
  // Whether the stage nets hold or stop the kind, so it is not mounted.
  held: (id: string) => boolean;
  makeUrl: (bytes: BlobPart) => string;
  revokeUrl: (url: string) => void;
  // Shows a kind's thumbnail URL, or removes it when null.
  publish: (key: string, url: string | null) => void;
  // Runs a job after the page has had a quiet moment.
  later: (run: () => void) => void;
}

export const thumbKey = (id: string, theme: ThumbTheme) => `${id}|${theme}`;

export interface Thumbs {
  // Brings the thumbnails in line with the kinds now installed.
  sync: (entries: readonly ThumbEntry[]) => void;
  // Checks a plugin's thumbnails against the store again, keeping the shown ones until it answers.
  recheck: (pluginId: string) => void;
  // Renders a plugin's thumbnails again without reading the store, as its build was replaced.
  rebuild: (pluginId: string) => void;
  // Settles once every queued job is done.
  idle: () => Promise<void>;
  // Stops all work and revokes every shown URL.
  dispose: () => void;
}

export function createThumbs(deps: ThumbDeps): Thumbs {
  // The build signature each kind was last handled under.
  const sigs = new Map<string, string>();
  const urls = new Map<string, string>();
  // Jobs that came back empty under their signature are not tried again until the build changes.
  const failed = new Set<string>();
  const queued = new Set<string>();
  // The job running now, so a sync does not queue it twice.
  let running: string | null = null;
  // Bumped by each recheck or rebuild of a plugin, so a job begun before it stores and shows nothing.
  const epochs = new Map<string, number>();
  // The epoch of each plugin's last rebuild: its jobs under that epoch render without reading the store.
  const rebuilt = new Map<string, number>();
  let entries = new Map<string, ThumbEntry>();
  let queue: { entry: ThumbEntry; theme: ThumbTheme }[] = [];
  let draining: Promise<void> | null = null;
  let disposed = false;
  const abort = new AbortController();

  const drop = (key: string) => {
    const url = urls.get(key);
    if (url) deps.revokeUrl(url);
    urls.delete(key);
    deps.publish(key, null);
  };

  const current = (entry: ThumbEntry) => entries.get(entry.id)?.sig === entry.sig;
  const epochOf = (pluginId: string) => epochs.get(pluginId) ?? 0;

  const job = async (entry: ThumbEntry, theme: ThumbTheme) => {
    const key = thumbKey(entry.id, theme);
    const epoch = epochOf(entry.pluginId);
    // A build that changed meanwhile, a recheck or a rebuild has its own jobs.
    const fresh = () => !disposed && current(entry) && epochOf(entry.pluginId) === epoch;
    let bytes: ArrayBuffer | Uint8Array | null = null;
    if (rebuilt.get(entry.pluginId) !== epoch) {
      try {
        bytes = await deps.get(entry.pluginId, entry.kindId, theme);
      } catch {
        // A failed read says nothing of the image: the shown one stays and the next sync tries again.
        return;
      }
    }
    try {
      if (!bytes) {
        const png = await deps.render(entry.id, theme, abort.signal);
        // Checked before the store, so a still of an older build is never stored under the new one.
        if (!fresh()) return;
        if (png) {
          bytes = png;
          // A failed store only means the next session renders it again.
          await deps.put(entry.pluginId, entry.kindId, theme, png).catch(() => {});
        }
      }
    } catch {
      bytes = null;
    }
    if (!fresh()) return;
    if (!bytes) {
      failed.add(`${key}|${entry.sig}`);
      if (urls.has(key)) drop(key);
      return;
    }
    // The new image is shown before the old one is revoked, so the tile never falls back to its glyph.
    const old = urls.get(key);
    const url = deps.makeUrl(bytes as BlobPart);
    urls.set(key, url);
    deps.publish(key, url);
    if (old) deps.revokeUrl(old);
  };

  const drain = () => {
    if (draining) return;
    draining = new Promise<void>((resolve) => {
      deps.later(async () => {
        while (queue.length > 0 && !disposed) {
          const next = queue.shift()!;
          const attempt = `${thumbKey(next.entry.id, next.theme)}|${next.entry.sig}`;
          queued.delete(attempt);
          if (!current(next.entry) || deps.held(next.entry.id)) continue;
          running = attempt;
          try {
            await job(next.entry, next.theme);
          } finally {
            running = null;
          }
        }
        draining = null;
        resolve();
      });
    });
  };

  const enqueue = (entry: ThumbEntry, theme: ThumbTheme) => {
    if (deps.held(entry.id)) return;
    queued.add(`${thumbKey(entry.id, theme)}|${entry.sig}`);
    queue.push({ entry, theme });
  };

  // Queues a plugin's kinds again under a new epoch, reading the store first or not.
  const again = (pluginId: string, read: boolean) => {
    if (disposed) return;
    const epoch = epochOf(pluginId) + 1;
    epochs.set(pluginId, epoch);
    if (read) rebuilt.delete(pluginId);
    else rebuilt.set(pluginId, epoch);
    for (const entry of entries.values()) {
      if (entry.pluginId !== pluginId) continue;
      for (const theme of THEMES) {
        const attempt = `${thumbKey(entry.id, theme)}|${entry.sig}`;
        failed.delete(attempt);
        if (!queued.has(attempt)) enqueue(entry, theme);
      }
    }
    if (queue.length > 0) drain();
  };

  const forgetAll = () => {
    for (const key of [...urls.keys()]) drop(key);
    sigs.clear();
    queue = [];
    queued.clear();
  };

  const api: Thumbs = {
    sync(next) {
      if (disposed) return;
      entries = new Map(next.map((e) => [e.id, e]));
      for (const id of [...sigs.keys()]) {
        if (entries.has(id)) continue;
        sigs.delete(id);
        for (const theme of THEMES) drop(thumbKey(id, theme));
      }
      for (const entry of next) {
        if (sigs.get(entry.id) !== entry.sig) {
          sigs.set(entry.id, entry.sig);
          for (const theme of THEMES) drop(thumbKey(entry.id, theme));
        }
        for (const theme of THEMES) {
          const key = thumbKey(entry.id, theme);
          const attempt = `${key}|${entry.sig}`;
          if (urls.has(key) || queued.has(attempt) || running === attempt || failed.has(attempt)) continue;
          enqueue(entry, theme);
        }
      }
      if (queue.length > 0) drain();
    },
    recheck: (pluginId) => again(pluginId, true),
    rebuild: (pluginId) => again(pluginId, false),
    idle: () => draining ?? Promise.resolve(),
    dispose() {
      disposed = true;
      abort.abort();
      forgetAll();
    },
  };
  return api;
}

// -- Shown thumbnails --

interface ThumbStore {
  urls: Readonly<Record<string, string>>;
}

export const useThumbStore = create<ThumbStore>(() => ({ urls: {} }));

/** The object URL of a plugin kind's thumbnail in a theme, or null until one is rendered. */
export function pluginThumb(id: string, theme: ThumbTheme): string | null {
  return useThumbStore.getState().urls[thumbKey(id, theme)] ?? null;
}

/** The thumbnail of a plugin kind in a theme, following its render and any build change. */
export function usePluginThumb(id: string, theme: ThumbTheme): string | null {
  return useThumbStore((s) => s.urls[thumbKey(id, theme)] ?? null);
}

export function publishThumb(key: string, url: string | null): void {
  useThumbStore.setState((s) => {
    if ((s.urls[key] ?? null) === url) return s;
    const { [key]: _old, ...rest } = s.urls;
    return { urls: url ? { ...rest, [key]: url } : rest };
  });
}
