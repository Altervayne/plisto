// -- Test Imports --
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { NotRespondingOverlay } from "./NotRespondingOverlay";

// -- i18n Imports --
import { en } from "../../../i18n/en";
import { fr } from "../../../i18n/fr";

// -- Type Imports --
import type { PluginTier } from "../../../types";

const overlay = (tier: PluginTier, takeoverLine = false) =>
  renderToStaticMarkup(
    <NotRespondingOverlay
      name="Tap"
      tier={tier}
      takeoverLine={takeoverLine}
      focusInFrame={() => false}
      onWait={() => {}}
      onDisable={() => {}}
    />,
  );

describe("the not-responding sentence", () => {
  it("says the page for a UI plugin and the plugin for a native one", () => {
    expect(overlay("ui")).toContain(en.plugins.frame.notRespondingLine);
    expect(overlay("ui")).not.toContain(en.plugins.frame.notRespondingPluginLine);
    expect(overlay("native")).toContain(en.plugins.frame.notRespondingPluginLine);
    expect(overlay("native")).not.toContain(en.plugins.frame.notRespondingLine);
  });

  it("opens the native sentence as the plugin, in both locales", () => {
    expect(en.plugins.frame.notRespondingPluginLine).toMatch(/^The plugin has not answered for a few seconds\./);
    expect(fr.plugins.frame.notRespondingPluginLine).toMatch(/^Le plugin n'a pas répondu depuis quelques secondes\./);
  });

  it("gives the takeover line for either tier", () => {
    expect(overlay("native", true)).toContain("Plisto&#x27;s own speakers");
  });
});
