// -- Test Imports --
import { afterEach, describe, expect, it } from "vitest";

// -- Unit Imports --
import { browserHostDeps } from "./hostBrowser";
import { usePluginsStore } from "./store";

// -- Type Imports --
import type { PluginRow } from "../../types";

afterEach(() => {
  usePluginsStore.setState({ rows: [] });
});

describe("granted", () => {
  it("reads the plugin's row and reads an unknown plugin as no grants", () => {
    const row = { id: "plug-a", granted: ["storage", "library.read"] } as unknown as PluginRow;
    usePluginsStore.setState({ rows: [row] });
    const { granted } = browserHostDeps();
    expect(granted?.("plug-a")).toEqual(["storage", "library.read"]);
    expect(granted?.("plug-b")).toEqual([]);
  });
});
