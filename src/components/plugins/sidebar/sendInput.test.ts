// -- Test Imports --
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { sendInput } from "./sendInput";
import { useSidebarState } from "../../../state/plugins/sidebarState";
import { hasLiveFrame, sendSidebar } from "../../../state/plugins/pluginHost";
import { pluginSidebarInput } from "../../../lib/ipc";
import { usePluginsStore } from "../../../state/plugins/store";
import { row } from "../../../state/plugins/fixtures";

// -- Type Imports --
import type { PluginSidebarInputReply } from "../../../types";

vi.mock("../../../lib/ipc", () => ({ pluginSidebarInput: vi.fn() }));
vi.mock("../../../state/plugins/pluginHost", () => ({ hasLiveFrame: vi.fn(), sendSidebar: vi.fn() }));

const delivery = { item_id: "auto", value: true, gesture: "g1.abc" };
const reply = (over: Partial<PluginSidebarInputReply>): PluginSidebarInputReply => ({
  accepted: true,
  frame: delivery,
  ...over,
});

const isPending = () => "lyrics|auto" in useSidebarState.getState().pending;

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(hasLiveFrame).mockReturnValue(true);
  vi.mocked(sendSidebar).mockReturnValue(true);
  useSidebarState.getState().setPending("lyrics", "auto");
});

afterEach(() => {
  useSidebarState.getState().clearPending("lyrics", "auto");
  vi.useRealTimers();
  vi.resetAllMocks();
  usePluginsStore.setState({ rows: [] });
});

describe("sendInput", () => {
  it("posts an accepted click to the frame and leaves the toggle pending", async () => {
    vi.mocked(pluginSidebarInput).mockResolvedValue(reply({}));
    await sendInput("lyrics", "auto", true);
    expect(pluginSidebarInput).toHaveBeenCalledWith("lyrics", "auto", true);
    expect(sendSidebar).toHaveBeenCalledWith("lyrics", delivery);
    expect(isPending()).toBe(true);
  });

  it("posts nothing for an accepted click with no frame delivery, and stays pending", async () => {
    vi.mocked(pluginSidebarInput).mockResolvedValue(reply({ frame: null }));
    await sendInput("lyrics", "auto", true);
    expect(sendSidebar).not.toHaveBeenCalled();
    expect(isPending()).toBe(true);
  });

  it("clears pending when the frame cannot take the delivery", async () => {
    vi.mocked(pluginSidebarInput).mockResolvedValue(reply({}));
    vi.mocked(sendSidebar).mockReturnValue(false);
    await sendInput("lyrics", "auto", true);
    expect(isPending()).toBe(false);
  });

  it("clears pending when Rust refuses the click", async () => {
    vi.mocked(pluginSidebarInput).mockResolvedValue(reply({ accepted: false, frame: null }));
    await sendInput("lyrics", "auto", true);
    expect(sendSidebar).not.toHaveBeenCalled();
    expect(isPending()).toBe(false);
  });

  it("clears pending when the call itself fails", async () => {
    vi.mocked(pluginSidebarInput).mockRejectedValue(new Error("gone"));
    await sendInput("lyrics", "auto", true);
    expect(isPending()).toBe(false);
  });

  it("does not call Rust when the plugin has no live frame, and clears pending", async () => {
    vi.mocked(hasLiveFrame).mockReturnValue(false);
    await sendInput("lyrics", "auto", null);
    expect(pluginSidebarInput).not.toHaveBeenCalled();
    expect(isPending()).toBe(false);
  });

  describe("a native plugin", () => {
    beforeEach(() => {
      usePluginsStore.setState({ rows: [row({ id: "lyrics", tier: "native" })] });
      vi.mocked(hasLiveFrame).mockReturnValue(false);
    });

    it("calls Rust with no frame and stays pending once accepted", async () => {
      vi.mocked(pluginSidebarInput).mockResolvedValue(reply({ frame: null }));
      await sendInput("lyrics", "auto", true);
      expect(pluginSidebarInput).toHaveBeenCalledWith("lyrics", "auto", true);
      expect(sendSidebar).not.toHaveBeenCalled();
      expect(isPending()).toBe(true);
    });

    it("clears pending when Rust refuses or the call fails", async () => {
      vi.mocked(pluginSidebarInput).mockResolvedValue(reply({ accepted: false, frame: null }));
      await sendInput("lyrics", "auto", true);
      expect(isPending()).toBe(false);
      useSidebarState.getState().setPending("lyrics", "auto");
      vi.mocked(pluginSidebarInput).mockRejectedValue(new Error("not built"));
      await sendInput("lyrics", "auto", true);
      expect(isPending()).toBe(false);
    });
  });
});
