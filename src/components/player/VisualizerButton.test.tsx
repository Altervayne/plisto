// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { VisualizerButton } from "./VisualizerButton";

const h = vi.hoisted(() => ({ open: false, toggle: vi.fn() }));

vi.mock("../../state/player/visualizerSheet", () => ({
  useVisualizerSheetOpen: () => h.open,
  useVisualizerSheet: { getState: () => ({ toggle: h.toggle }) },
}));
vi.mock("../common/Tooltip", () => ({ Tooltip: ({ children }: { children: unknown }) => children as never }));
// A fixed English translator, so the component can also be called as a plain function.
vi.mock("../../i18n", async (orig) => {
  const real = await orig<typeof import("../../i18n")>();
  return { ...real, useT: () => real.createT("en") };
});

type Found = { type: unknown; props: Record<string, unknown> };

/** Finds the first element in an unrendered tree that satisfies `match`. */
function findElement(node: unknown, match: (el: Found) => boolean): Found | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findElement(child, match);
      if (hit) return hit;
    }
    return null;
  }
  if (node == null || typeof node !== "object") return null;
  const el = node as Found;
  if (match(el)) return el;
  return findElement(el.props?.children, match);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.open = false;
});

describe("VisualizerButton", () => {
  it("is a labelled menu button, closed and unpressed while the sheet is shut", () => {
    const html = renderToStaticMarkup(<VisualizerButton />);
    expect(html).toContain('aria-label="Visualizer"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-pressed="false"');
  });

  it("reads expanded and pressed while the sheet is open", () => {
    h.open = true;
    const html = renderToStaticMarkup(<VisualizerButton />);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-pressed="true"');
  });

  it("toggles the sheet anchored on itself, so focus can return to it", () => {
    const tree = VisualizerButton();
    const button = findElement(tree, (el) => typeof el.props?.onClick === "function");
    const anchor = {} as HTMLElement;
    (button?.props.onClick as (event: unknown) => void)({ currentTarget: anchor });
    expect(h.toggle).toHaveBeenCalledWith(anchor);
  });
});
