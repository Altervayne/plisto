// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  pluginApprove: vi.fn(),
  pluginDiscard: vi.fn(),
  pluginEnable: vi.fn(),
  pluginInspect: vi.fn(),
  pluginInstall: vi.fn(),
  pluginUpdate: vi.fn(),
  pluginIcon: vi.fn(),
  pluginStagedIcon: vi.fn(),
}));
vi.mock("../../lib/ipc", () => ipc);
vi.mock("./usePluginsSync", () => ({ reloadPlugins: vi.fn() }));
const persist = vi.hoisted(() => vi.fn());
vi.mock("../preferences/store", async (orig) => ({
  ...(await orig<typeof import("../preferences/store")>()),
  persistVisualizerCatalog: persist,
}));

// -- Unit Imports --
import { createReviewFlow } from "./reviewFlow";
import { createLock } from "./operationLock";
import { currentPluginNotice, resetPluginNotice } from "./pluginNotice";
import { usePluginsStore } from "./store";
import { inspection, manifest, row } from "./fixtures";
import { PREF_KEYS, usePreferencesStore } from "../preferences/store";
import { serializeCatalog } from "../player/visualizerCatalog";

// -- Type Imports --
import type { PluginListing } from "../../types";

const installed = (listing: PluginListing, over = {}) =>
  row({
    id: "pulse",
    enabled: false,
    manifest: manifest({ name: "Pulse Lab", listing, entry: listing === "catalog" ? null : "index.html" }),
    ...over,
  });
const found = (listing: PluginListing, over = {}) =>
  inspection({ id: "pulse", name: "Pulse Lab", capabilities: ["visualizer"], origins: [], listing, ...over });

beforeEach(() => {
  Object.values(ipc).forEach((fn) => fn.mockReset());
  ipc.pluginDiscard.mockResolvedValue(undefined);
  resetPluginNotice();
  persist.mockReset();
  usePreferencesStore.setState({
    values: {
      [PREF_KEYS.playerVisualizerCatalog]: serializeCatalog({ kinds: ["a"], groups: ["plugin:pulse"] }),
    },
    failedKeys: new Set(),
    loaded: true,
  });
  usePluginsStore.setState({ rows: [], boot: null, status: "ready", epoch: 0 });
});

async function install(origin: PluginListing, listing: PluginListing) {
  const flow = createReviewFlow(createLock(), origin);
  ipc.pluginInspect.mockResolvedValue(found(listing, { installed: null }));
  await flow.inspect("C:/x/pulse.plistoplugin");
  ipc.pluginInstall.mockResolvedValue(installed(listing, { state: "needs_consent", granted: [] }));
  ipc.pluginApprove.mockResolvedValue(installed(listing));
  ipc.pluginEnable.mockResolvedValue(installed(listing, { enabled: true }));
  await flow.confirm(false);
}

describe("installing a plugin that only adds visualizers", () => {
  it("lands it turned on", async () => {
    await install("catalog", "catalog");
    expect(ipc.pluginEnable).toHaveBeenCalledTimes(1);
    expect(ipc.pluginApprove).not.toHaveBeenCalled();
    expect(usePluginsStore.getState().rows[0].enabled).toBe(true);
  });

  it("clears a stored off flag for its family in one write", async () => {
    await install("catalog", "catalog");
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith({ kinds: ["a"], groups: [] });
  });

  it("says where it went when it was added from the plugins list", async () => {
    await install("plugins", "catalog");
    expect(currentPluginNotice().notice).toEqual({ id: "pulse", kind: "listing", change: "added" });
  });

  it("says nothing when it was added from the catalog it lands in", async () => {
    await install("catalog", "catalog");
    expect(currentPluginNotice().notice).toBeNull();
  });
});

describe("installing a plugin with its own page", () => {
  it("leaves it turned off and leaves the flag", async () => {
    await install("catalog", "plugins");
    expect(persist).not.toHaveBeenCalled();
    expect(ipc.pluginApprove).toHaveBeenCalledTimes(1);
    expect(ipc.pluginEnable).not.toHaveBeenCalled();
  });

  it("says it was added to Plugins, turned off, when added from the catalog", async () => {
    await install("catalog", "plugins");
    expect(currentPluginNotice().notice).toEqual({ id: "pulse", kind: "listing", change: "addedToPlugins" });
  });

  it("says nothing when it was added from the plugins list", async () => {
    await install("plugins", "plugins");
    expect(currentPluginNotice().notice).toBeNull();
  });
});

describe("an update that moves a plugin between the listings", () => {
  async function update(origin: PluginListing, before: PluginListing, after: PluginListing) {
    usePluginsStore.setState({ rows: [installed(before, { enabled: true, state: "ready" })] });
    const flow = createReviewFlow(createLock(), origin);
    ipc.pluginInspect.mockResolvedValue(found(after, { installed: "1.0.0" }));
    await flow.inspect("C:/x/pulse.plistoplugin");
    ipc.pluginUpdate.mockResolvedValue({
      row: installed(after, { enabled: true, state: "ready" }),
      previous_version: "1.0.0",
      previous_author: "Lyric Works",
    });
    await flow.confirm(false);
  }

  it("says a plugin now has its own page when it left the catalog it was updated from", async () => {
    await update("catalog", "catalog", "plugins");
    expect(currentPluginNotice().notice).toEqual({ id: "pulse", kind: "listing", change: "ownPage" });
  });

  it("says a plugin is now managed in Visualizers when it left the plugins list", async () => {
    await update("plugins", "plugins", "catalog");
    expect(currentPluginNotice().notice).toEqual({ id: "pulse", kind: "listing", change: "managed" });
  });

  it("clears the family flag when the plugin moves into the catalog", async () => {
    await update("plugins", "plugins", "catalog");
    expect(persist).toHaveBeenCalledWith({ kinds: ["a"], groups: [] });
  });

  it("says nothing when the listing does not change", async () => {
    await update("plugins", "catalog", "catalog");
    expect(currentPluginNotice().notice).toBeNull();
  });
});
