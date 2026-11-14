// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { streamEndKey } from "./streamEnd";

// -- Type Imports --
import type { StreamEndNotice, StreamEndReason } from "../../types";

const end = (reason: StreamEndReason, detail: string | null = null): StreamEndNotice => ({
  plugin_id: "night-radio",
  plugin_name: "Night Radio",
  reason,
  detail,
});

describe("streamEndKey", () => {
  it.each([
    [end("network", "closed"), "network"],
    [end("denied", "blocked_address"), "denied"],
    [end("unsupported", "format"), "unsupported"],
    [end("unsupported", "playlist"), "playlist"],
    [end("no_audio"), "noAudio"],
    [end("stalled"), "stalled"],
    [end("producer_gone"), "producerGone"],
    [end("plugin_gone", "update"), "pluginOff"],
    [end("plugin_gone", "consent"), "consent"],
    [end("plugin_gone", "safe_mode"), "safeMode"],
  ] as const)("maps %j to a toast line", (notice, key) => {
    expect(streamEndKey(notice)).toBe(key);
  });

  it.each(["user", "replaced", "stopped", "finished"] as const)("is silent for %s", (reason) => {
    expect(streamEndKey(end(reason))).toBeNull();
  });

  it("is silent for a plugin the user turned off or removed", () => {
    expect(streamEndKey(end("plugin_gone"))).toBeNull();
    expect(streamEndKey(end("plugin_gone", "disabled"))).toBeNull();
  });
});
