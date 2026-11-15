/*
 * Carries app event topics from Rust to plugin frames. Rust emits `plugins:event` for a plugin; the host
 * posts it only to that plugin's newest live, initialised frame, and only when the frame's own subscribe
 * accepted the topic. An event for a topic a subscribe in flight asked for is held until its reply;
 * otherwise nothing is queued, and a frame that opens later sees later events only.
 */

// -- Framework Imports --
import { useEffect } from "react";

// -- Library Imports --
import { listen } from "@tauri-apps/api/event";

// -- Utils Imports --
import { withRetry } from "../../lib/withRetry";

// -- State Imports --
import { pluginRuntimeReady } from "./frameModel";
import { sendTopicEvent } from "./pluginHost";
import { usePluginsBoot } from "./store";

// -- Type Imports --
import type { PluginTopicEvent } from "../../types";

/** The event Rust emits for an app event topic. */
export const EVENT_TOPIC = "plugins:event";

export interface TopicEventDeps {
  /** Subscribes to a Tauri event and resolves its removal. */
  listen: (name: string, handler: (event: { payload: unknown }) => void) => Promise<() => void>;
  /** Posts to the plugin's newest accepting frame; false when it has none. */
  send: (id: string, topic: string, data: unknown) => boolean;
}

/** Whether a payload has the shape Rust emits. Anything else is dropped. */
function isTopicEvent(payload: unknown): payload is PluginTopicEvent {
  if (typeof payload !== "object" || payload === null) return false;
  const { id, topic } = payload as Record<string, unknown>;
  return typeof id === "string" && typeof topic === "string";
}

/** Starts listening and returns the teardown. */
export function createTopicEventSync(deps: TopicEventDeps): () => void {
  let alive = true;
  let unlisten: (() => void) | null = null;

  // A rejected listen retries: an early rejection must not leave the frames deaf for the session.
  withRetry(() =>
    deps.listen(EVENT_TOPIC, (event) => {
      if (alive && isTopicEvent(event.payload)) deps.send(event.payload.id, event.payload.topic, event.payload.data);
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
export function browserTopicEventDeps(): TopicEventDeps {
  return { listen: (name, handler) => listen(name, handler), send: sendTopicEvent };
}

/** Keeps app event topics flowing to subscribed frames. Mounted once, at the top of the shell. */
export function usePluginEvents(): void {
  const runtime = pluginRuntimeReady(usePluginsBoot());

  useEffect(() => {
    if (!runtime) return;
    return createTopicEventSync(browserTopicEventDeps());
  }, [runtime]);
}
