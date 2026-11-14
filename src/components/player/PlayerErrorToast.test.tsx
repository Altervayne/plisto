// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

// -- Unit Imports --
import { PlayerErrorToast } from "./PlayerErrorToast";

// -- Type Imports --
import type { StreamEndNotice, StreamEndReason } from "../../types";

const h = vi.hoisted(() => ({ end: null as StreamEndNotice | null }));

vi.mock("../../state/player/store", () => ({
  usePlayerError: () => null,
  useSetPlayerError: () => () => {},
  useStreamEnd: () => h.end,
  useSetStreamEnd: () => () => {},
}));
// Renders its children only while visible, so a silent end shows as an empty string.
vi.mock("../common/Toast/Toast", () => ({
  Toast: ({ visible, children }: { visible: boolean; children: ReactNode }) =>
    visible ? <div data-toast="">{children}</div> : null,
}));

const end = (reason: StreamEndReason, detail: string | null = null): StreamEndNotice => ({
  plugin_id: "night-radio",
  plugin_name: "Night Radio",
  reason,
  detail,
});
const render = () => renderToStaticMarkup(<PlayerErrorToast />);

beforeEach(() => {
  h.end = null;
});

describe("PlayerErrorToast for a stream end", () => {
  it.each([
    [end("network", "closed"), "Night Radio&#x27;s stream lost its connection."],
    [end("denied", "dev_only"), "points to an address Plisto does not allow"],
    [end("unsupported", "codec"), "Plisto cannot play the format of Night Radio&#x27;s stream."],
    [end("unsupported", "playlist"), "sent a playlist link"],
    [end("no_audio"), "stream sent no audio"],
    [end("stalled"), "stopped sending audio"],
    [end("producer_gone"), "stopped unexpectedly"],
    [end("plugin_gone", "update"), "was turned off"],
    [end("plugin_gone", "consent"), "needs your approval again"],
    [end("plugin_gone", "safe_mode"), "Plugins are off for this session"],
  ])("shows a toast for %j", (notice, text) => {
    h.end = notice;
    const html = render();
    expect(html).toContain("data-toast");
    expect(html).toContain(text);
  });

  it.each(["user", "replaced", "stopped", "finished"] as const)("shows nothing for %s", (reason) => {
    h.end = end(reason);
    expect(render()).toBe("");
  });

  it("shows nothing with no end", () => {
    expect(render()).toBe("");
  });
});
