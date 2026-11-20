// -- Test Imports --
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The server renderer needs a server snapshot these hooks do not give, so the plugin flow hooks are stubbed.
vi.mock("./plugins/useOperationLock", async () => {
  const { createLock } = await import("../../state/plugins/operationLock");
  return { useOperationLock: () => createLock() };
});
// A static render has no document, which the stills read to pick a theme.
vi.mock("../../theme", async (original) => ({
  ...(await original<typeof import("../../theme")>()),
  isDarkTheme: () => false,
}));
let installed: PluginRow[] = [];
vi.mock("../../state/plugins/store", async (original) => ({
  ...(await original<typeof import("../../state/plugins/store")>()),
  usePlugins: () => installed,
}));
vi.mock("./plugins/useReviewFlow", () => ({
  useReviewFlow: () => ({
    sheet: null,
    openReview: () => {},
    inspect: async () => {},
    confirm: async () => {},
    close: () => {},
  }),
}));

// -- Unit Imports --
import { SettingsView } from "./SettingsView";
import { SettingRow } from "./SettingRow";
import {
  SETTINGS_REGISTRY,
  hubSettingId,
  settingAnchorId,
  settingEntry,
  visibleSettings,
} from "./settingsRegistry";
import { SETTINGS_SECTIONS } from "./settingsSections";

// -- State Imports --
import { row } from "../../state/plugins/fixtures";

// -- i18n Imports --
import { en } from "../../i18n/en";
import { fr } from "../../i18n/fr";

// -- Type Imports --
import type { PluginRow } from "../../types";

const dicts = [
  ["en", en],
  ["fr", fr],
] as const;

const renderView = (userAgent: string) => {
  vi.stubGlobal("navigator", { userAgent });
  return renderToStaticMarkup(<SettingsView />);
};

const stampedIds = (html: string) =>
  [...html.matchAll(/data-setting-id="([^"]+)"/g)].map((m) => m[1]);

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source"]);

/**
 * The text of every element whose class contains `rowLabel` that has no `data-setting-id` ancestor.
 * Static markup is well formed, so a tag scan with an open-element stack gives ancestry exactly.
 */
function unstampedLabels(html: string): string[] {
  const stack: { tag: string; stamped: boolean }[] = [];
  const found: string[] = [];
  const tag = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(html))) {
    const [whole, closing, name, attrs, selfClosing] = m;
    if (closing) {
      stack.pop();
      continue;
    }
    if (/class="[^"]*rowLabel/.test(attrs) && !stack.some((e) => e.stamped)) {
      const end = html.indexOf("</", m.index + whole.length);
      found.push(html.slice(m.index + whole.length, end).replace(/<[^>]*>/g, ""));
    }
    if (selfClosing || VOID_TAGS.has(name)) continue;
    stack.push({ tag: name, stamped: attrs.includes("data-setting-id=") });
  }
  return found;
}

afterEach(() => {
  vi.unstubAllGlobals();
  installed = [];
});

describe("settings registry", () => {
  it("has unique ids", () => {
    const ids = SETTINGS_REGISTRY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("files every entry under a listed section, in section order", () => {
    const order = SETTINGS_SECTIONS.map((s) => s.id);
    const sections = SETTINGS_REGISTRY.map((e) => order.indexOf(e.section));
    expect(sections.every((i) => i >= 0)).toBe(true);
    expect(sections).toEqual([...sections].sort((a, b) => a - b));
  });

  it("lists every section once, in the page order", () => {
    expect(SETTINGS_SECTIONS.map((s) => s.id)).toEqual([
      "folders",
      "genres",
      "restorePoints",
      "playback",
      "sound",
      "visualizers",
      "appearance",
      "system",
      "plugins",
      "updates",
    ]);
  });

  it.each(dicts)("resolves every label, sublabel and section name in %s", (_name, dict) => {
    for (const entry of SETTINGS_REGISTRY) {
      expect(entry.label(dict).trim()).not.toBe("");
      if (entry.sublabel) expect(entry.sublabel(dict).trim()).not.toBe("");
    }
    for (const section of SETTINGS_SECTIONS) expect(section.label(dict).trim()).not.toBe("");
  });

  it.each(dicts)("gives every entry a non-empty synonym list in %s", (_name, dict) => {
    for (const entry of SETTINGS_REGISTRY) {
      const words = entry.synonyms(dict);
      expect(words.length).toBeGreaterThan(0);
      expect(words.every((w) => w.trim() !== "")).toBe(true);
    }
  });

  it("builds anchors and hub ids from one place", () => {
    expect(hubSettingId("tandem")).toBe("hub-tandem");
    expect(settingAnchorId("theme")).toBe("setting-theme");
    expect(settingEntry("theme")?.section).toBe("appearance");
    expect(settingEntry("hub-tandem")).toBeUndefined();
  });
});

describe("visible predicates", () => {
  it("shows the Windows-only row only on Windows", () => {
    const onWindows = visibleSettings({ windows: true }).map((e) => e.id);
    const elsewhere = visibleSettings({ windows: false }).map((e) => e.id);
    expect(onWindows).toContain("defaultApp");
    expect(elsewhere).not.toContain("defaultApp");
    expect(onWindows.filter((id) => id !== "defaultApp")).toEqual(elsewhere);
  });
});

describe("SettingRow", () => {
  it("stamps the id and a scroll anchor without adding style", () => {
    const html = renderToStaticMarkup(
      <SettingRow id="theme" className="pref">
        <span>x</span>
      </SettingRow>,
    );
    expect(html).toBe('<div id="setting-theme" data-setting-id="theme" class="pref"><span>x</span></div>');
  });
});

describe("Settings view stamping", () => {
  it("renders and stamps every visible entry on Windows", () => {
    const html = renderView("Windows");
    const ids = stampedIds(html);
    const expected = visibleSettings({ windows: true }).map((e) => e.id);
    expect(expected).toContain("defaultApp");
    for (const id of expected) expect(ids).toContain(id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("leaves out the Windows-only row elsewhere and stamps nothing unregistered", () => {
    const html = renderView("Linux");
    const ids = stampedIds(html);
    expect(ids).not.toContain("defaultApp");
    for (const id of visibleSettings({ windows: false }).map((e) => e.id)) {
      expect(ids).toContain(id);
    }
    for (const id of ids) expect(id.startsWith("hub-") || settingEntry(id) !== undefined).toBe(true);
  });

  it("stamps exactly the installed plugins' hub rows with their hub ids", () => {
    installed = [row({ id: "lyrics" }), row({ id: "tandem" })];
    const hubs = stampedIds(renderView("Linux")).filter((id) => id.startsWith("hub-"));
    expect(hubs).toEqual(installed.map((r) => hubSettingId(r.id)));
  });

  it("puts every row label under a stamped row", () => {
    installed = [row({ id: "lyrics" })];
    for (const agent of ["Windows", "Linux"]) {
      const html = renderView(agent);
      // Guard against the scan matching nothing: the stamped labels must be seen too.
      expect([...html.matchAll(/rowLabel/g)].length).toBeGreaterThan(10);
      expect(unstampedLabels(html)).toEqual([]);
    }
  });

  it("flags a row label rendered outside a stamped row", () => {
    expect(unstampedLabels('<div><span class="x_rowLabel_1">Loose</span></div>')).toEqual(["Loose"]);
    expect(
      unstampedLabels('<div data-setting-id="theme"><div><span class="rowLabel">Ok</span></div></div>'),
    ).toEqual([]);
  });

  it("tags every section with its id, in order", () => {
    const html = renderView("Windows");
    const found = [...html.matchAll(/data-settings-section="([^"]+)"/g)].map((m) => m[1]);
    expect(found).toEqual(SETTINGS_SECTIONS.map((s) => s.id));
  });
});
