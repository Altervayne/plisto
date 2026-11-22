// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { isValidElement, type ReactElement, type ReactNode } from "react";

// -- Unit Imports --
import { SheetFooter } from "./SheetFooter";
import { PluginKindControls } from "./PluginKindControls";

// -- State Imports --
import { usePluginsStore } from "../../../../state/plugins/store";
import { usePreferencesStore, PREF_KEYS } from "../../../../state/preferences/store";
import { visualizerDecl as decl, visualizerRow as visRow } from "../../../../state/plugins/fixtures";

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
// Every string reads as its own key, so the markup names what drew it.
vi.mock("../../../../i18n", () => ({
  useT: () => (pick: (d: unknown) => string) =>
    pick(new Proxy({}, { get: () => new Proxy({}, { get: (_u, b) => String(b) }) })),
}));

const WITH_SETTINGS = "com.example.rings/aurora-rings";
const NO_SETTINGS = "com.example.plain/plain-kind";

const markup = (picked: string) => renderToStaticMarkup(<SheetFooter picked={picked as never} />);

beforeEach(() => {
  usePreferencesStore.setState({ values: {} });
  usePluginsStore.setState({
    rows: [
      visRow("com.example.rings", "Rings", [
        decl({
          settings: [
            {
              id: "layout",
              label: "Ring layout",
              type: "choice",
              options: [
                { id: "left", label: "Left" },
                { id: "mirrored", label: "Mirrored" },
              ],
              default: "left",
            },
            { id: "glow", label: "Glow amount", type: "toggle", default: false },
            { id: "size", label: "Ring size", type: "range", min: 1, max: 10, step: 1, default: 4 },
            { id: "tint", label: "Tint color", type: "color", default: "cover" },
          ],
          presets: [{ id: "calm", label: "Calm blue", values: { layout: "mirrored" } }],
        }),
      ]),
      visRow("com.example.plain", "Plain", [decl({ id: "plain-kind" })]),
    ],
  });
});

describe("sheet footer", () => {
  it("draws a plugin kind's controls and presets from its manifest", () => {
    const html = markup(WITH_SETTINGS);
    for (const label of ["Ring layout", "Glow amount", "Ring size", "Tint color", "Calm blue"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('type="range"');
    expect(html).toContain('type="color"');
    expect(html).toContain('role="switch"');
    // Values match no preset, so the preset row reads as custom.
    expect(html).toContain("visualizerPresetCustom");
    expect(html).toContain("visualizerColorCover");
  });

  it("reads the stored value and names the matching preset", () => {
    usePreferencesStore.setState({
      values: {
        [PREF_KEYS.playerVisualizerSettings]: JSON.stringify({ [WITH_SETTINGS]: { layout: "mirrored" } }),
      },
    });
    const html = markup(WITH_SETTINGS);
    expect(html).not.toContain("visualizerPresetCustom");
  });

  it("keys the kind's controls by the kind, so a held write never reaches the next kind", () => {
    const controls = (picked: string) => {
      const found: ReactElement[] = [];
      const walk = (node: ReactNode) => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (!isValidElement(node)) return;
        if (node.type === PluginKindControls) found.push(node);
        walk((node.props as { children?: ReactNode }).children);
      };
      walk(SheetFooter({ picked: picked as never }));
      return found;
    };
    const [element] = controls(WITH_SETTINGS);
    expect(element.key).toBe(WITH_SETTINGS);
  });

  it("draws nothing extra for a plugin kind with no settings, a built-in or an unknown kind", () => {
    for (const picked of [NO_SETTINGS, "ridge", "dot-spectrum", "com.gone.plugin/missing"]) {
      const html = markup(picked);
      expect(html).not.toContain('type="range"');
      expect(html).not.toContain('type="color"');
      expect(html).not.toContain("visualizerPreset");
    }
  });
});
