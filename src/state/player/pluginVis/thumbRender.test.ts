// -- Test Imports --
import { beforeEach, describe, expect, it } from "vitest";

// -- Unit Imports --
import { contextFor } from "./thumbRender";

// -- State Imports --
import { pluginVisualizer } from "../pluginVisualizers";
import { usePluginsStore } from "../../plugins/store";
import { visualizerDecl as decl, visualizerRow as visRow } from "../../plugins/fixtures";

const LIGHT_KIND = "com.example.rings/aurora-rings";
const DARK_KIND = "com.example.rings/night";

beforeEach(() => {
  usePluginsStore.setState({
    rows: [visRow("com.example.rings", "Rings", [decl(), decl({ id: "night", dark_only: true })])],
  });
});

describe("thumbnail context", () => {
  it("backs a kind with a light look on the light surface in the light theme", () => {
    const context = contextFor(pluginVisualizer(LIGHT_KIND)!, "light");
    expect(context.light).toBe(true);
    expect(context.colors.backing[0]).toBeCloseTo(0xfa / 255);
  });

  it("backs a dark-only kind with the sunken tone in the light theme, on the light ground", () => {
    const context = contextFor(pluginVisualizer(DARK_KIND)!, "light");
    expect(context.light).toBe(false);
    expect(context.colors.backing[0]).toBeCloseTo(0xea / 255);
    expect(context.colors.ground[0]).toBeCloseTo(0xf4 / 255);
  });

  it("backs every kind with the sunken tone in the dark theme", () => {
    const context = contextFor(pluginVisualizer(LIGHT_KIND)!, "dark");
    expect(context.light).toBe(false);
    expect(context.colors.backing[0]).toBeCloseTo(0x10 / 255);
  });
});
