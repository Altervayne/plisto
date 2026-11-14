/*
 * Carries streamed-response and socket events from Rust to the plugin's page. Each `plugins:net` event is
 * decoded to binary and posted to that plugin's newest live, initialised frame, and dropped when there is
 * none. Chunks of one stream must arrive with `seq` 1, 2, 3...; a gap (a main-window reload mid-stream)
 * ends the stream for the page as `network` / `protocol` and asks Rust once to cancel it. An ended stream
 * or socket stays ended: late events for it are dropped.
 */

// -- Framework Imports --
import { useEffect } from "react";

// -- Library Imports --
import { listen } from "@tauri-apps/api/event";

// -- State Imports --
import { pluginRuntimeReady } from "./frameModel";
import { base64ToBuffer } from "./netFrame";
import { sendSocket, sendStream } from "./pluginHost";
import { usePluginsBoot } from "./store";

// -- IPC Imports --
import { pluginCall } from "../../lib/ipc";

// -- Type Imports --
import type { SocketDelivery, StreamDelivery } from "./bridge";

/** The event Rust emits for stream chunks and socket messages. */
export const EVENT_NET = "plugins:net";

export interface NetSyncDeps {
  /** Subscribes to a Tauri event and resolves its removal. */
  listen: (name: string, handler: (event: { payload: unknown }) => void) => Promise<() => void>;
  /** Posts to the plugin's newest live frame; false when it has none. */
  sendStream: (id: string, delivery: StreamDelivery) => boolean;
  sendSocket: (id: string, delivery: SocketDelivery) => boolean;
  /** Asks Rust to end one of the plugin's streams. Best-effort. */
  cancelStream: (id: string, stream: string) => void;
  /** Asks Rust to close one of the plugin's sockets. Best-effort. */
  closeSocket: (id: string, socket: string) => void;
}

/** The most streams and sockets tracked at once; the plugin caps keep far fewer open. */
export const TRACKED_MAX = 64;

/** The close code a page sees for a socket that ended without a close frame. */
const ABNORMAL_CLOSE = 1006;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Starts listening and returns the teardown. */
export function createNetSync(deps: NetSyncDeps): () => void {
  let alive = true;
  let unlisten: (() => void) | null = null;
  // The next chunk seq per stream, or null once the stream or a socket has ended; later events for a null
  // key are dropped. Insertion order is recency, so the oldest key goes first past the cap.
  const tracked = new Map<string, number | null>();
  const remember = (key: string, value: number | null) => {
    tracked.delete(key);
    tracked.set(key, value);
    if (tracked.size > TRACKED_MAX) tracked.delete(tracked.keys().next().value as string);
  };

  const onStream = (id: string, stream: string, e: Record<string, unknown>) => {
    const key = `t\n${id}\n${stream}`;
    const expected = tracked.get(key);
    if (expected === null) return;
    if (e.kind === "end" || e.kind === "error") {
      remember(key, null);
      if (e.kind === "end") deps.sendStream(id, { stream, kind: "end" });
      else {
        deps.sendStream(id, {
          stream,
          kind: "error",
          code: typeof e.code === "string" ? e.code : "network",
          reason: typeof e.reason === "string" ? e.reason : null,
        });
      }
      return;
    }
    if (e.kind !== "chunk") return;
    // Zero is never an expected seq, so a missing or non-number seq reads as a gap.
    const seq = typeof e.seq === "number" ? e.seq : 0;
    const data = typeof e.data_b64 === "string" ? base64ToBuffer(e.data_b64) : null;
    if (seq !== (expected ?? 1) || data === null) {
      remember(key, null);
      deps.sendStream(id, { stream, kind: "error", code: "network", reason: "protocol" });
      deps.cancelStream(id, stream);
      return;
    }
    // With no frame to take it, nothing is kept: Rust ends the stream when the frame goes.
    if (deps.sendStream(id, { stream, kind: "chunk", seq, data })) remember(key, seq + 1);
    else tracked.delete(key);
  };

  const onSocket = (id: string, socket: string, e: Record<string, unknown>) => {
    const key = `s\n${id}\n${socket}`;
    if (tracked.get(key) === null) return;
    const close = (code: number, reason: string, clean: boolean) => {
      remember(key, null);
      deps.sendSocket(id, { socket, kind: "close", code, reason, clean });
    };
    if (e.kind === "text" && typeof e.data === "string") {
      deps.sendSocket(id, { socket, kind: "text", data: e.data });
    } else if (e.kind === "binary") {
      const data = typeof e.data_b64 === "string" ? base64ToBuffer(e.data_b64) : null;
      if (data) {
        deps.sendSocket(id, { socket, kind: "binary", data });
        return;
      }
      // A lost message ends the socket for the page, and Rust is told so it frees the socket.
      close(ABNORMAL_CLOSE, "", false);
      deps.closeSocket(id, socket);
    } else if (e.kind === "close") {
      close(
        typeof e.code === "number" ? e.code : ABNORMAL_CLOSE,
        typeof e.reason === "string" ? e.reason : "",
        e.clean === true,
      );
    }
  };

  const receive = (payload: unknown) => {
    if (!alive || !isRecord(payload) || typeof payload.id !== "string") return;
    if (typeof payload.stream === "string") onStream(payload.id, payload.stream, payload);
    else if (typeof payload.socket === "string") onSocket(payload.id, payload.socket, payload);
  };

  deps
    .listen(EVENT_NET, (event) => receive(event.payload))
    .then((off) => {
      if (alive) unlisten = off;
      else off();
    })
    .catch(() => {
      // Without Tauri there is nothing to hear.
    });

  return () => {
    alive = false;
    unlisten?.();
    unlisten = null;
    tracked.clear();
  };
}

/** Starts the sync only while the plugin runtime runs. Returns its teardown, or undefined when it did not start. */
export function startNetSync(runtime: boolean, deps: () => NetSyncDeps): (() => void) | undefined {
  return runtime ? createNetSync(deps()) : undefined;
}

/** The production dependencies: Tauri events, the host shim and `plugin_call`. */
export function browserNetDeps(): NetSyncDeps {
  return {
    listen: (name, handler) => listen(name, handler),
    sendStream,
    sendSocket,
    cancelStream: (id, stream) => {
      pluginCall(id, "net.stream.cancel", JSON.stringify({ stream })).catch(() => {});
    },
    closeSocket: (id, socket) => {
      pluginCall(id, "net.socket.close", JSON.stringify({ socket })).catch(() => {});
    },
  };
}

/** Keeps plugin network events flowing to their pages. Mounted once, at the top of the shell. */
export function usePluginNet(): void {
  const runtime = pluginRuntimeReady(usePluginsBoot());

  useEffect(() => startNetSync(runtime, browserNetDeps), [runtime]);
}
