// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { landingScrollTop, resolveLanding, sectionForTarget } from "./settingsTarget";
import { hubSettingId, settingAnchorId } from "./settingsRegistry";

const none = () => false;

describe("resolveLanding", () => {
  it("lands on a section id", () => {
    expect(resolveLanding("sound", none)).toEqual({ kind: "section", section: "sound" });
  });

  it("lands on a row that is on the page", () => {
    const domId = settingAnchorId("theme");
    expect(resolveLanding("theme", (id) => id === domId)).toEqual({ kind: "row", domId });
  });

  it("falls back to the section when the row is not on the page", () => {
    expect(resolveLanding("defaultApp", none)).toEqual({ kind: "section", section: "system" });
  });

  it("lands on a hub row that exists", () => {
    const id = hubSettingId("tandem");
    expect(resolveLanding(id, (domId) => domId === settingAnchorId(id))).toEqual({
      kind: "row",
      domId: settingAnchorId(id),
    });
  });

  it("lands on Plugins for a hub row that is not there", () => {
    expect(resolveLanding(hubSettingId("gone"), none)).toEqual({ kind: "section", section: "plugins" });
  });

  it("returns null for an unknown id", () => {
    expect(resolveLanding("nope", none)).toBeNull();
  });
});

describe("the visualizer catalog target", () => {
  it("lands on its row and files it under the Visualizers section", () => {
    const domId = settingAnchorId("visualizerCatalog");
    expect(resolveLanding("visualizerCatalog", (id) => id === domId)).toEqual({ kind: "row", domId });
    expect(sectionForTarget("visualizerCatalog")).toBe("visualizers");
    expect(resolveLanding("visualizers", none)).toEqual({ kind: "section", section: "visualizers" });
  });

  it("falls back to the section while the row is not on the page", () => {
    expect(resolveLanding("visualizerCatalog", none)).toEqual({ kind: "section", section: "visualizers" });
  });
});

describe("landingScrollTop", () => {
  it("places the element the offset below the scroller top", () => {
    // Element 300 below the scroller top while scrolled 200: it sits at 500 in the content.
    expect(landingScrollTop(400, 100, 200, 24)).toBe(476);
  });
});
