/*
 * Carries a plugin's playback-stream events from Rust to its frame. Rust emits `plugins:stream` for the
 * plugin that owns the seated stream; each event is posted to that plugin's newest live, initialised frame
 * and to no other, and dropped when there is none. Nothing is queued.
 */

// -- Framework Imports --
import { useEffect } from "react";

// -- Library Imports --
import { listen } from "@tauri-apps/api/event";

// -- Utils Imports --
import { withRetry } from "../../lib/withRetry";

// -- State Imports --
import { pluginRuntimeReady } from "./frameModel";
import { sendPlaybackStreamEvent } from "./pluginHost";
import { usePluginsBoot } from "./store";

// -- Type Imports --
import type { PluginStreamEvent, PluginStreamPayload } from "../../types";

/** The event Rust emits for the owner of the seated stream. */
export const EVENT_PLAYBACK_STREAM = "plugins:stream";

export interface StreamEventDeps {
  /** Subscribes to a Tauri event and resolves its removal. */
  listen: (name: string, handler: (event: { payload: unknown }) => void) => Promise<() => void>;
  /** Posts to the plugin's newest live frame; false when it has none. */
  send: (id: string, event: PluginStreamEvent) => boolean;
}

/** Whether a payload has the shape Rust emits. Anything else is dropped. */
function isStreamPayload(payload: unknown): payload is PluginStreamPayload {
  if (typeof payload !== "object" || payload === null) return false;
  const { id, event } = payload as Record<string, unknown>;
  return typeof id === "string" && typeof event === "object" && event !== null;
}

/** Starts listening and returns the teardown. */
export function createStreamEventSync(deps: StreamEventDeps): () => void {
  let alive = true;
  let unlisten: (() => void) | null = null;

  // A rejected listen retries: an early rejection must not leave the owner deaf for the session.
  withRetry(() =>
    deps.listen(EVENT_PLAYBACK_STREAM, (event) => {
      if (alive && isStreamPayload(event.payload)) deps.send(event.payload.id, event.payload.event);
    }),
  )
    .then((off) => {
      if (alive) unlisten = off;
      else off();
    })
    .catch(() => {
      // Still rejected after every retry: there is nothing to hear.
    });

  return () => {
    alive = false;
    unlisten?.();
    unlisten = null;
  };
}

/** The production dependencies: Tauri events and the host shim. */
export function browserStreamEventDeps(): StreamEventDeps {
  return { listen: (name, handler) => listen(name, handler), send: sendPlaybackStreamEvent };
}

/** Keeps playback-stream events flowing to their owners. Mounted once, at the top of the shell. */
export function usePluginStreamEvents(): void {
  const runtime = pluginRuntimeReady(usePluginsBoot());

  useEffect(() => {
    if (!runtime) return;
    return createStreamEventSync(browserStreamEventDeps());
  }, [runtime]);
}
