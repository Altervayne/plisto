// -- Test Imports --
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { ContextMenu } from "./ContextMenu";

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
