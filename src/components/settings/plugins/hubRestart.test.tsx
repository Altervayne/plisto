// -- Test Imports --
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The server renderer reads a store's initial state, so the status hook is fed through the real model here.
let current: PluginStatus = status({ host: "running" });
vi.mock("../../../state/plugins/usePluginStatusView", async () => {
  const { statusView } = await import("../../../state/plugins/statusModel");
  return { usePluginStatusView: (r: PluginRow) => statusView("running", r, current) };
});

// -- Unit Imports --
import { PluginRowPanel } from "./PluginRowPanel";
import { row, status } from "../../../state/plugins/fixtures";

// -- i18n Imports --
import { en } from "../../../i18n/en";

// -- Type Imports --
import type { PluginRow, PluginStatus } from "../../../types";

const running = (over: Partial<PluginStatus> = {}) => {
  current = status({ host: "running", ...over } as Partial<PluginStatus>);
};

const panel = (over: Partial<PluginRow>) =>
  renderToStaticMarkup(<PluginRowPanel row={row(over)} busy={false} onToggle={() => {}} onUninstall={() => {}} />);

describe("hub Restart", () => {
  it("shows for a running native plugin", () => {
    running();
    expect(panel({ tier: "native" })).toContain(en.plugins.frame.restart);
  });

  it("does not show for a running UI plugin", () => {
    running();
    expect(panel({ tier: "ui" })).not.toContain(en.plugins.frame.restart);
  });

  it("still shows for a UI plugin that is not responding", () => {
    running({ host: "not_responding" });
    expect(panel({ tier: "ui" })).toContain(en.plugins.frame.restart);
  });
});
