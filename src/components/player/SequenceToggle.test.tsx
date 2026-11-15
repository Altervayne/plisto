// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { SequenceToggle } from "./SequenceToggle";
import { streamNowFixture } from "../../state/player/streamFixtures";

// -- Type Imports --
import type { RepeatMode, StreamNow } from "../../types";

const h = vi.hoisted(() => ({
  repeat: "off" as RepeatMode,
  shuffle: false,
  stream: null as StreamNow | null,
  actions: { setRepeat: vi.fn(), setShuffle: vi.fn() },
}));

vi.mock("../../state/player/store", () => ({
  usePlayerStatus: () => ({ repeat: h.repeat, shuffle: h.shuffle }),
  usePlayerActions: () => h.actions,
  useSeatedStream: () => h.stream,
}));
// A fixed English translator, so the component can also be called as a plain function.
vi.mock("../../i18n", async (orig) => {
  const real = await orig<typeof import("../../i18n")>();
  return { ...real, useT: () => real.createT("en") };
});
// The tooltip bubble needs a DOM and a hover; the stand-in prints its label where a test can read it.
vi.mock("../common/Tooltip", () => ({
  Tooltip: ({ label, children }: { label: string; children: unknown }) => (
    <span data-tip={label}>{children as never}</span>
  ),
}));

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

const render = (kind: "shuffle" | "repeat") => renderToStaticMarkup(<SequenceToggle kind={kind} />);

/** Presses the toggle of an unrendered tree through its onClick. */
const press = (kind: "shuffle" | "repeat") => {
  const tree = SequenceToggle({ kind });
  const toggle = findElement(tree, (el) => typeof el.props?.onClick === "function");
  (toggle?.props.onClick as () => void)();
};

beforeEach(() => {
  vi.clearAllMocks();
  h.repeat = "off";
  h.shuffle = false;
  h.stream = null;
});

describe("SequenceToggle shuffle", () => {
  it("reads off, then pressed once shuffle is on", () => {
    expect(render("shuffle")).toContain('aria-pressed="false"');
    h.shuffle = true;
    expect(render("shuffle")).toContain('aria-pressed="true"');
  });

  it("flips the engine flag", () => {
    press("shuffle");
    expect(h.actions.setShuffle).toHaveBeenCalledWith(true);
    h.shuffle = true;
    press("shuffle");
    expect(h.actions.setShuffle).toHaveBeenLastCalledWith(false);
  });
});

describe("SequenceToggle repeat", () => {
  it.each([
    ["off", "Play once", false],
    ["all", "Repeat queue", true],
    ["one", "Repeat current", true],
  ] as const)("names %s as %s and presses it as %s", (repeat, label, pressed) => {
    h.repeat = repeat;
    const html = render("repeat");
    expect(html).toContain(`aria-label="${label}"`);
    expect(html).toContain(`aria-pressed="${pressed}"`);
  });

  it("draws the Repeat-1 glyph only for repeat one", () => {
    expect(render("repeat")).not.toContain("lucide-repeat-1");
    h.repeat = "all";
    expect(render("repeat")).not.toContain("lucide-repeat-1");
    h.repeat = "one";
    expect(render("repeat")).toContain("lucide-repeat-1");
  });

  it("cycles off, all, one, off", () => {
    press("repeat");
    expect(h.actions.setRepeat).toHaveBeenLastCalledWith("all");
    h.repeat = "all";
    press("repeat");
    expect(h.actions.setRepeat).toHaveBeenLastCalledWith("one");
    h.repeat = "one";
    press("repeat");
    expect(h.actions.setRepeat).toHaveBeenLastCalledWith("off");
  });
});

describe("SequenceToggle with a stream seated", () => {
  beforeEach(() => {
    h.stream = streamNowFixture();
  });

  it.each(["shuffle", "repeat"] as const)("dims %s, unpresses it and names the plugin in the tooltip", (kind) => {
    h.shuffle = true;
    h.repeat = "all";
    const html = render(kind);
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('data-tip="Night Radio does not shuffle or repeat"');
    expect(html).not.toMatch(/<button[^>]* disabled/);
  });

  it.each(["shuffle", "repeat"] as const)("does nothing when %s is pressed", (kind) => {
    press(kind);
    expect(h.actions.setShuffle).not.toHaveBeenCalled();
    expect(h.actions.setRepeat).not.toHaveBeenCalled();
  });
});
