// -- Test Imports --
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { FamilyMark } from "./FamilyMark";

// -- State Imports --
import { GROUP_ORDER, groupMark } from "../../../../state/player/visualizerRegistry";

// -- i18n Imports --
import { en } from "../../../../i18n/en";

vi.mock("../../../../theme", () => ({ useTheme: () => "system", isDarkTheme: () => false }));

const labelOf = { flash: en.player.markCanFlash, calm: en.player.markCalmer } as const;

describe("FamilyMark", () => {
  it("renders the label the registry's mark names, for every family that has one", () => {
    for (const id of GROUP_ORDER) {
      const mark = groupMark(id);
      const html = renderToStaticMarkup(<FamilyMark id={id} />);
      if (mark) expect(html).toContain(labelOf[mark]);
      else expect(html).toBe("");
    }
  });

  it("renders nothing for a family with no mark and for an unknown id", () => {
    expect(renderToStaticMarkup(<FamilyMark id="classic" />)).toBe("");
    expect(renderToStaticMarkup(<FamilyMark id="plugin-x" />)).toBe("");
  });

  it("marks Cyber and Cosmic as can flash and Cozy as calmer", () => {
    expect(renderToStaticMarkup(<FamilyMark id="cyber" />)).toContain("Can flash");
    expect(renderToStaticMarkup(<FamilyMark id="cosmic" />)).toContain("Can flash");
    expect(renderToStaticMarkup(<FamilyMark id="cozy" />)).toContain("Calmer");
  });

  it("exposes the label as the accessible name of the icon-only variant, with no visible text", () => {
    const html = renderToStaticMarkup(<FamilyMark id="cyber" iconOnly />);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Can flash"');
    expect(html.replace(/<[^>]*>/g, "")).toBe("");
  });
});
