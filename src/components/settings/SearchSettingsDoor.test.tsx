// -- Test Imports --
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { SearchSettingsDoor } from "./SearchSettingsDoor";

// -- i18n Imports --
import { en } from "../../i18n/en";
import { fr } from "../../i18n/fr";

// The locale lives in a store the server renderer cannot subscribe to, so the translator is bound by hand.
const state = vi.hoisted(() => ({ locale: "en" as "en" | "fr" }));
vi.mock("../../i18n", async (original) => {
  const actual = await original<typeof import("../../i18n")>();
  return { ...actual, useT: () => actual.createT(state.locale) };
});

const door = (locale: "en" | "fr") => {
  state.locale = locale;
  return renderToStaticMarkup(<SearchSettingsDoor onOpen={() => {}} />);
};

describe("SearchSettingsDoor", () => {
  it("is a dialog-opening button named by its visible text, in both locales", () => {
    for (const [locale, dict] of [["en", en], ["fr", fr]] as const) {
      const html = door(locale);
      expect(html).toContain("<button");
      expect(html).toContain('aria-haspopup="dialog"');
      expect(html).toContain(`<span>${dict.finder.scopePlaceholder}</span>`);
    }
  });

  it("hides the glyph from the accessible name", () => {
    expect(door("en")).toContain('aria-hidden="true"');
  });
});
