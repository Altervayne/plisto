// -- Test Imports --
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { PluginNoticeHost } from "./PluginNoticeHost";

// -- State Imports --
import { currentPluginNotice, resetPluginNotice, showPluginNotice } from "../../state/plugins/pluginNotice";
import { usePluginsStore } from "../../state/plugins/store";
import { visualizerDecl, visualizerRow } from "../../state/plugins/fixtures";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
// The shared toast pill needs a DOM and a mount transition; the stand-in draws its children when visible.
vi.mock("../common/Toast/Toast", () => ({
  Toast: ({ visible, children }: { visible: boolean; children: unknown }) => (visible ? <>{children}</> : null),
}));

beforeEach(() => {
  vi.useFakeTimers();
  resetPluginNotice();
});
afterEach(() => {
  resetPluginNotice();
  vi.useRealTimers();
});

describe("PluginNoticeHost", () => {
  it("draws the takeover notice with the plugin id as the name and no Show action", () => {
    showPluginNotice({ id: "tandem", kind: "takeover_returned" });
    const html = renderToStaticMarkup(<PluginNoticeHost />);
    expect(html).toContain("tandem stopped mirroring. Plisto&#x27;s own speakers are playing again.");
    expect(html).not.toContain("<button");
  });

  it("draws the neutral variant when no holder is known", () => {
    showPluginNotice({ id: null, kind: "takeover_returned" });
    expect(renderToStaticMarkup(<PluginNoticeHost />)).toContain("Mirroring stopped.");
  });

  it("keeps the auto-disabled notice with its Show action", () => {
    showPluginNotice({ id: "tap", kind: "auto_disabled" });
    const html = renderToStaticMarkup(<PluginNoticeHost />);
    expect(html).toContain("tap was turned off after repeated crashes.");
    expect(html).toContain("<button");
  });

  it("names a stopped visualizer kind and the fallback it shows", () => {
    usePluginsStore.setState({ rows: [visualizerRow("com.example.rings", "Rings", [visualizerDecl()])] });
    const visualizer = "com.example.rings/aurora-rings";
    showPluginNotice({ id: "com.example.rings", kind: "visualizer_stopped", visualizer, cause: "hang" });
    const html = renderToStaticMarkup(<PluginNoticeHost />);
    expect(html).toContain("Aurora rings stopped responding: showing Ridge");
    expect(html).not.toContain("<button");
    usePluginsStore.setState({ rows: [] });
  });

  it("replaces a stopped-visualizer notice for another kind, not a repeat of the same one", () => {
    const first = { id: "p", kind: "visualizer_stopped", visualizer: "p/a", cause: "flashing" } as const;
    showPluginNotice(first);
    showPluginNotice({ ...first });
    expect(currentPluginNotice().notice).toBe(first);
    const other = { ...first, visualizer: "p/b" };
    showPluginNotice(other);
    expect(currentPluginNotice().notice).toBe(other);
  });
});
