/*
 * The host's own calls at frame init (`app.info`, `app.methods`). A rate limit is retried after the
 * reply's hint, clamped, up to a fixed number of attempts; any other refusal or failure reads as null.
 */

// -- Type Imports --
import type { PluginCallReply } from "../../types";

const HOST_CALL_ATTEMPTS = 5;
const RETRY_DEFAULT_MS = 500;
const RETRY_MIN_MS = 50;
const RETRY_MAX_MS = 2000;

export const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface HostCallDeps {
  invoke: (id: string, method: string, args: string) => Promise<PluginCallReply>;
  sleep?: (ms: number) => Promise<void>;
}

/** Runs one host call for a plugin. `isLive` is checked after each wait so a gone frame stops retrying. */
export async function hostCall(
  deps: HostCallDeps,
  pluginId: string,
  method: string,
  isLive: () => boolean,
): Promise<unknown> {
  const sleep = deps.sleep ?? defaultSleep;
  for (let attempt = 1; attempt <= HOST_CALL_ATTEMPTS; attempt += 1) {
    let reply: PluginCallReply;
    try {
      reply = await deps.invoke(pluginId, method, "{}");
    } catch {
      return null;
    }
    if (reply?.ok) return reply.result;
    if (reply?.error?.code !== "rate_limited" || attempt === HOST_CALL_ATTEMPTS) return null;
    const hint = reply.error.retry_after_ms;
    const wait = typeof hint === "number" ? Math.min(RETRY_MAX_MS, Math.max(RETRY_MIN_MS, hint)) : RETRY_DEFAULT_MS;
    await sleep(wait);
    if (!isLive()) return null;
  }
  return null;
}
