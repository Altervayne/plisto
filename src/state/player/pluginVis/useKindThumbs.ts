/*
 * Keeps the thumbnails of plugin kinds current for the app: reads the plugins store's rows and, while the
 * plugin runtime runs, hands the engine the kinds installed with a signature of their build. A plugin whose
 * host starts again has its thumbnails checked against the backend store again; one whose build is
 * replaced (a reload or an update) has them rendered again without reading the store first, so the new
 * build's images overwrite any an old-build render stored. Mounted by the shell once.
 */

// -- Framework Imports --
import { useEffect } from "react";

// -- State Imports --
import { usePluginsStore } from "../../plugins/store";
import { pluginVisualizer } from "../pluginVisualizers";
import { onBuildReplaced } from "../../plugins/buildReplaced";
import { startingEdges, usePluginStatusStore } from "../../plugins/pluginStatus";
import { isKindStopped, useNetPolicy } from "./netPolicy";
import { buildSig } from "./offscreenCrumbs";

// -- Local Imports --
import { renderThumbPng } from "./thumbRender";
import { createThumbs, publishThumb, type ThumbDeps, type ThumbEntry } from "./thumbs";

// -- IPC Imports --
import { pluginVisThumbGet, pluginVisThumbPut } from "../../../lib/ipc";

// -- Type Imports --
import type { PluginRow } from "../../../types";

// How long a render waits after a change, so thumbnails never compete with startup or a burst of edits.
const QUIET_MS = 2000;

/** The kinds of the enabled, ready plugins, each with the signature of the build that declares it. */
export function thumbEntries(rows: readonly PluginRow[]): ThumbEntry[] {
  return rows.flatMap((row) => {
    if (!row.enabled || row.state !== "ready" || !row.manifest) return [];
    const sig = buildSig(row);
    return row.manifest.visualizers.map((v) => ({
      id: `${row.id}/${v.id}`,
      pluginId: row.id,
      kindId: v.id,
      sig,
    }));
  });
}

const liveDeps: ThumbDeps = {
  get: pluginVisThumbGet,
  put: pluginVisThumbPut,
  render: async (id, theme, signal) => {
    const descriptor = pluginVisualizer(id);
    return descriptor ? renderThumbPng(descriptor, theme, signal) : null;
  },
  held: isKindStopped,
  makeUrl: (bytes) => URL.createObjectURL(new Blob([bytes], { type: "image/png" })),
  revokeUrl: (url) => URL.revokeObjectURL(url),
  publish: publishThumb,
  later: (run) => void setTimeout(run, QUIET_MS),
};

export function useKindThumbs(): void {
  useEffect(() => {
    const thumbs = createThumbs(liveDeps);
    const sync = () => {
      const { rows, boot } = usePluginsStore.getState();
      // Frames are unavailable until the runtime runs; the kinds are read again when it does.
      if (boot?.runtime !== "running") return;
      thumbs.sync(thumbEntries(rows));
    };
    sync();
    const stops = [
      usePluginsStore.subscribe(sync),
      // A kind the nets held may be free again once the marks change.
      useNetPolicy.subscribe((state, prev) => {
        if (state.marks !== prev.marks || state.pending !== prev.pending) sync();
      }),
      onBuildReplaced((id) => thumbs.rebuild(id)),
      usePluginStatusStore.subscribe((state, prev) => {
        if (state.statuses === prev.statuses) return;
        for (const id of startingEdges(prev.statuses, state.statuses)) thumbs.recheck(id);
      }),
    ];
    return () => {
      for (const stop of stops) stop();
      thumbs.dispose();
    };
  }, []);
}
