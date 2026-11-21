/*
 * The plugin bridge as a visualizer frame sees it: a small client over the same window messages the
 * full SDK uses, carrying calls, logs and storage. Results and pongs come through
 * `handle`, which the runtime's one window listener feeds; nothing here listens on its own.
 */

/** The bridge protocol number the host routes. */
export const BRIDGE_PROTOCOL = 1;

// A call the host never answers rejects after this long.
const CALL_TIMEOUT_MS = 10000;

/** A rejected call, with the host's error code. */
export class BridgeError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message || code);
    this.name = "BridgeError";
    this.code = code;
  }
}

export interface BridgeClient {
  call: (method: string, args?: unknown) => Promise<unknown>;
  log: Record<"debug" | "info" | "warn" | "error", (text: unknown) => Promise<unknown>>;
  storage: {
    get: (key: string, fallback?: unknown) => Promise<unknown>;
    set: (key: string, value: unknown) => Promise<unknown>;
    remove: (key: string) => Promise<unknown>;
    keys: (prefix?: string) => Promise<unknown>;
    clear: () => Promise<unknown>;
    usage: () => Promise<unknown>;
  };
  // Takes one bridge message from the host; false when it is not one.
  handle: (data: Record<string, unknown>) => boolean;
}

export function createBridgeClient(postToParent: (msg: Record<string, unknown>) => void): BridgeClient {
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: number }>();
  let nextId = 1;

  const post = (msg: Record<string, unknown>) => postToParent({ ...msg, plisto: BRIDGE_PROTOCOL });

  const call = (method: string, args: unknown = {}) =>
    new Promise<unknown>((resolve, reject) => {
      let text: string;
      try {
        text = JSON.stringify(args ?? {});
      } catch {
        reject(new BridgeError("invalid_args", "The arguments could not be serialized."));
        return;
      }
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new BridgeError("timeout", "The call timed out."));
      }, CALL_TIMEOUT_MS) as unknown as number;
      pending.set(id, { resolve, reject, timer });
      post({ type: "plisto:call", id, method, args: text });
    });

  const logAt = (level: string) => (text: unknown) => call("log.write", { level, text: String(text) });

  const onResult = (data: Record<string, unknown>) => {
    const entry = pending.get(data.id as number);
    if (!entry) return;
    pending.delete(data.id as number);
    clearTimeout(entry.timer);
    if (data.ok === true) {
      entry.resolve(data.result);
      return;
    }
    const err = (data.error ?? {}) as Record<string, unknown>;
    entry.reject(
      new BridgeError(
        typeof err.code === "string" ? err.code : "unavailable",
        typeof err.message === "string" ? err.message : undefined,
      ),
    );
  };

  return {
    call,
    log: { debug: logAt("debug"), info: logAt("info"), warn: logAt("warn"), error: logAt("error") },
    storage: {
      get: (key, fallback) =>
        call("storage.get", { key }).then((r) => {
          const found = r as { found?: boolean; value?: unknown } | null;
          return found?.found ? found.value : fallback;
        }),
      set: (key, value) => call("storage.set", { key, value }),
      remove: (key) => call("storage.remove", { key }),
      keys: (prefix) => call("storage.keys", prefix === undefined ? {} : { prefix }),
      clear: () => call("storage.clear", {}),
      usage: () => call("storage.usage", {}),
    },
    handle(data) {
      switch (data.type) {
        case "plisto:ping":
          // Answered from the listener, so the heartbeat never waits on plugin code.
          post({ type: "plisto:pong", seq: data.seq });
          return true;
        case "plisto:result":
          onResult(data);
          return true;
        default:
          return false;
      }
    },
  };
}
