// -- Test Imports --
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { MenuSidePanel } from "./MenuSidePanel";
import { PanelSchemeContext } from "../../../theme/scheme";

vi.mock("react-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-dom")>()),
  createPortal: (node: unknown) => node,
}));

vi.stubGlobal("document", { body: {} });

const html = (scheme: "dark" | null) =>
  renderToStaticMarkup(
    <PanelSchemeContext.Provider value={scheme}>
      <MenuSidePanel
        open
        label="Panel"
        menuRef={{ current: null }}
        panelRef={{ current: null }}
        row={{} as HTMLElement}
        onBack={() => {}}
      >
        <span>body</span>
      </MenuSidePanel>
    </PanelSchemeContext.Provider>,
  );

describe("MenuSidePanel colour scheme", () => {
  it("stamps its root dark inside a dark island", () => {
    expect(html("dark")).toMatch(/<div[^>]*role="dialog"[^>]*data-theme="dark"/);
  });

  it("carries no stamp without an island", () => {
    expect(html(null)).not.toContain("data-theme");
  });
});
