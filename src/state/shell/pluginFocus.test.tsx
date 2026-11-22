// -- Test Imports --
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// A static render reads a store's initial state; hooks read the live state instead.
vi.mock("zustand", async (orig) => {
  const real = await orig<typeof import("zustand")>();
  const create = ((init: never) => {
    const store = real.create(init);
    const hook = (select: (s: unknown) => unknown = (s) => s) => select(store.getState());
    return Object.assign(hook, store);
  }) as unknown as typeof real.create;
  return { ...real, create };
});

// -- Unit Imports --
import {
  openPluginFamily,
  openPluginHub,
  useClearPluginFamilyFocus,
  useClearPluginHubFocus,
  usePluginFamilyFocus,
  usePluginHubFocus,
} from "./store";
import { usePluginsStore } from "../plugins/store";
import { manifest, row, visualizerDecl, visualizerRow } from "../plugins/fixtures";

function focus(): { hub: string | null; family: string | null } {
  let out = { hub: null as string | null, family: null as string | null };
  function Probe() {
    out = { hub: usePluginHubFocus(), family: usePluginFamilyFocus() };
    useClearPluginHubFocus()();
    useClearPluginFamilyFocus()();
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return out;
}

describe("where a plugin's open request unfolds", () => {
  const rows = [
    visualizerRow("pulse", "Pulse", [visualizerDecl()]),
    row({ id: "setlist", manifest: manifest({ name: "Setlist", visualizers: [visualizerDecl()] }) }),
  ];

  it("unfolds only the catalog family for a plugin the catalog lists", () => {
    usePluginsStore.setState({ rows });
    openPluginHub("pulse");
    expect(focus()).toEqual({ hub: null, family: "pulse" });
  });

  it("unfolds only the hub row for a plugin with its own page, leaving the family folded", () => {
    usePluginsStore.setState({ rows });
    openPluginHub("setlist");
    expect(focus()).toEqual({ hub: "setlist", family: null });
  });

  it("unfolds the family of a plugin with its own page when asked for it", () => {
    usePluginsStore.setState({ rows });
    openPluginFamily("setlist");
    expect(focus()).toEqual({ hub: null, family: "setlist" });
  });
});
