// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { GenreAdder } from "./GenreAdder";

const h = vi.hoisted(() => ({ query: "noir" }));

// Opens the suggestion list over a typed query: the text box is the first state, focus the second.
vi.mock("react", async (orig) => ({
  ...(await orig<typeof import("react")>()),
  useState: (init: unknown) => {
    if (init === "") return [h.query, () => {}];
    if (init === false) return [true, () => {}];
    return [init, () => {}];
  },
}));
vi.mock("./ScrollArea/ScrollArea", () => ({
  ScrollArea: ({ children }: { children: unknown }) => <div>{children as never}</div>,
}));
// Shows the tooltip label in the markup, which the real bubble only mounts on hover.
vi.mock("./Tooltip", () => ({
  Tooltip: (p: { label?: string; children: unknown }) => (
    <span data-tip={p.label}>{p.children as never}</span>
  ),
}));

const genres = [{ id: 1, name: "Rock", track_count: 2 }] as never;

const render = (createTip?: string) =>
  renderToStaticMarkup(
    <GenreAdder genres={genres} onPick={() => {}} onCreate={() => {}} placeholder="Add" createTip={createTip} />,
  );

beforeEach(() => {
  h.query = "noir";
});

describe("GenreAdder create row", () => {
  it("is a live button with no tooltip by default", () => {
    const html = render();
    expect(html).toContain("noir");
    expect(html).not.toContain("disabled");
    expect(html).not.toContain("data-tip=");
  });

  it("is disabled and carries the tooltip when a tip is given", () => {
    const html = render("Available once loaded");
    expect(html).toContain('data-tip="Available once loaded"');
    expect(html).toContain("disabled");
  });

  it("still offers an existing genre while the create row is disabled", () => {
    h.query = "rock";
    const html = render("Available once loaded");
    expect(html).toContain("Rock");
    expect(html).not.toContain("disabled");
  });
});
