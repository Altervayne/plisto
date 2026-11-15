/*
 * Carries a native plugin's page events from Rust to its page. Rust emits `plugins:page_event` only while
 * the page is open; each event is posted to that plugin's newest live, initialised frame and to no other,
 * and dropped when there is none. Nothing is queued: a page that opens later sees later events only.
 */

// -- Framework Imports --
import { useEffect } from "react";

// -- Library Imports --
import { listen } from "@tauri-apps/api/event";

// -- Utils Imports --
import { withRetry } from "../../lib/withRetry";

// -- State Imports --
import { pluginRuntimeReady } from "./frameModel";
import { sendPluginEvent } from "./pluginHost";
import { usePluginsBoot } from "./store";

// -- Type Imports --
import type { PluginPageEvent } from "../../types";

/** The event Rust emits for a native plugin's page event. */
export const EVENT_PAGE = "plugins:page_event";

export interface PageEventDeps {
  /** Subscribes to a Tauri event and resolves its removal. */
  listen: (name: string, handler: (event: { payload: unknown }) => void) => Promise<() => void>;
  /** Posts to the plugin's newest live frame; false when it has none. */
  send: (id: string, topic: string, data: unknown) => boolean;
}

/** Whether a payload has the shape Rust emits. Anything else is dropped. */
function isPageEvent(payload: unknown): payload is PluginPageEvent {
  if (typeof payload !== "object" || payload === null) return false;
  const { id, topic } = payload as Record<string, unknown>;
  return typeof id === "string" && typeof topic === "string";
}

/** Starts listening and returns the teardown. */
export function createPageEventSync(deps: PageEventDeps): () => void {
  let alive = true;
  let unlisten: (() => void) | null = null;

  // A rejected listen retries: an early rejection must not leave the page deaf for the session.
  withRetry(() =>
    deps.listen(EVENT_PAGE, (event) => {
      if (alive && isPageEvent(event.payload)) deps.send(event.payload.id, event.payload.topic, event.payload.data);
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
export function browserPageEventDeps(): PageEventDeps {
  return { listen: (name, handler) => listen(name, handler), send: sendPluginEvent };
}

/** Keeps native page events flowing to their pages. Mounted once, at the top of the shell. */
export function usePluginPageEvents(): void {
  const runtime = pluginRuntimeReady(usePluginsBoot());

  useEffect(() => {
    if (!runtime) return;
    return createPageEventSync(browserPageEventDeps());
  }, [runtime]);
}
