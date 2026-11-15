// -- Test Imports --
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { SectionsMenu, SettingsRail } from "./SettingsRail";
import { SETTINGS_SECTIONS } from "./settingsSections";

// -- i18n Imports --
import { en } from "../../i18n/en";

const noop = () => {};

describe("SettingsRail", () => {
  it("lists every section and marks only the active one", () => {
    const html = renderToStaticMarkup(<SettingsRail active="sound" onPick={noop} />);
    expect(html.match(/<button/g)).toHaveLength(SETTINGS_SECTIONS.length);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(new RegExp(`aria-current="page"[^>]*>${en.settings.sectionSound}<`));
  });
});

describe("SectionsMenu", () => {
  it("names the current section in the trigger's accessible name and starts closed", () => {
    const html = renderToStaticMarkup(<SectionsMenu active="sound" onPick={noop} />);
    expect(html).toContain(`aria-label="Sections, ${en.settings.sectionSound}"`);
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="menu"');
    expect(html).toContain(`>${en.settings.sectionSound}</span>`);
  });
});
