// -- Test Imports --
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { ContextMenu } from "./ContextMenu";
import { PanelSchemeContext } from "../../../theme/scheme";

vi.mock("react-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-dom")>()),
  createPortal: (node: unknown) => node,
}));

// The menu portals into document.body; the portal is the identity, so only the body reference is needed.
vi.stubGlobal("document", { body: {} });

const render = (checked?: boolean) =>
  renderToStaticMarkup(
    <ContextMenu
      open
      x={0}
      y={0}
      onClose={() => {}}
      items={[{ label: "Keep", onSelect: () => {}, checked }]}
    />,
  );

describe("ContextMenu colour scheme", () => {
  const html = (scheme: "dark" | null) =>
    renderToStaticMarkup(
      <PanelSchemeContext.Provider value={scheme}>
        <ContextMenu open x={0} y={0} onClose={() => {}} items={[{ label: "Keep", onSelect: () => {} }]} />
      </PanelSchemeContext.Provider>,
    );

  it("stamps its root dark inside a dark island", () => {
    expect(html("dark")).toMatch(/<div[^>]*role="menu"[^>]*data-theme="dark"/);
  });

  it("carries no stamp without an island", () => {
    expect(html(null)).not.toContain("data-theme");
    expect(render()).not.toContain("data-theme");
  });
});

describe("ContextMenu setting row", () => {
  it("is a checkbox item whose state follows the prop", () => {
    const on = render(true);
    expect(on).toContain('role="menuitemcheckbox"');
    expect(on).toContain('aria-checked="true"');
    expect(render(false)).toContain('aria-checked="false"');
  });

  it("stays a plain menu item without the prop", () => {
    const html = render(undefined);
    expect(html).toContain('role="menuitem"');
    expect(html).not.toContain("menuitemcheckbox");
    expect(html).not.toContain("aria-checked");
  });
});
