// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { useFrameHealthStore } from "./frameHealth";
import { pageRestartScope, restartFromPage, restartPlugin } from "./restartPlugin";

// -- Type Imports --
import type { PluginStatus } from "../../types";

const pluginRestart = vi.hoisted(() => vi.fn());
vi.mock("../../lib/ipc", () => ({ pluginRestart }));

const status = (host: PluginStatus["host"]) => ({ host }) as PluginStatus;
const KEY = "p|1.0.0|h1";

beforeEach(() => {
  pluginRestart.mockReset();
  pluginRestart.mockResolvedValue(undefined);
  useFrameHealthStore.setState({ health: {}, crashed: new Set(), generation: {} });
  useFrameHealthStore.getState().crash("p", KEY, "init");
});

describe("restartFromPage", () => {
  it("remounts only the frame of a native plugin whose process runs", () => {
    restartFromPage({ id: "p", tier: "native" }, status("running"));
    expect(pluginRestart).not.toHaveBeenCalled();
    const s = useFrameHealthStore.getState();
    expect(s.crashed.has(KEY)).toBe(false);
    expect(s.generation.p).toBe(1);
    expect(s.health.p).toEqual({ phase: "loading" });
  });

  it.each(["stopped", "restarting", "not_responding"] as const)(
    "restarts the process of a native plugin that is %s",
    (host) => {
      restartFromPage({ id: "p", tier: "native" }, status(host));
      expect(pluginRestart).toHaveBeenCalledWith("p");
      expect(useFrameHealthStore.getState().generation.p).toBe(1);
    },
  );

  it("restarts the process of a native plugin with no status yet", () => {
    restartFromPage({ id: "p", tier: "native" }, undefined);
    expect(pluginRestart).toHaveBeenCalledWith("p");
  });

  it("keeps a UI plugin's restart as both the frame and the process", () => {
    restartFromPage({ id: "p", tier: "ui" }, status("running"));
    expect(pluginRestart).toHaveBeenCalledWith("p");
    expect(useFrameHealthStore.getState().generation.p).toBe(1);
  });
});

describe("hub restart", () => {
  it("restarts the process of a running native plugin", () => {
    restartPlugin({ id: "p" });
    expect(pluginRestart).toHaveBeenCalledWith("p");
  });
});

describe("pageRestartScope", () => {
  it("is frame only for a native plugin with a running process", () => {
    expect(pageRestartScope({ tier: "native" }, status("running"))).toBe("frame");
    expect(pageRestartScope({ tier: "native" }, status("stopped"))).toBe("process");
    expect(pageRestartScope({ tier: "ui" }, status("running"))).toBe("process");
  });
});
