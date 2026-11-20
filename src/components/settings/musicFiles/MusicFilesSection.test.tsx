// -- Test Imports --
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The static renderer has no portal target, and the section reads the preferences through a stand-in.
const prefs = vi.hoisted(() => ({ stamp: false, trim: false, days: "30", stampEnabled: false }));
vi.mock("../../../lib/features", () => ({
  get STAMP_ENABLED() {
    return prefs.stampEnabled;
  },
}));
vi.mock("../../../state/preferences/store", async (original) => ({
  ...(await original<typeof import("../../../state/preferences/store")>()),
  useStampFiles: () => prefs.stamp,
  useSetStampFiles: () => () => {},
  useTrimReplace: () => prefs.trim,
  useSetTrimReplace: () => () => {},
  useTrimBackupDays: () => prefs.days,
  useSetTrimBackupDays: () => () => {},
}));
vi.mock("../../../lib/ipc", () => ({}));

// -- Unit Imports --
import { MusicFilesSection } from "./MusicFilesSection";

// -- i18n Imports --
import { en } from "../../../i18n/en";

const render = (stamp: boolean, trim: boolean, stampEnabled = true) => {
  prefs.stampEnabled = stampEnabled;
  prefs.stamp = stamp;
  prefs.trim = trim;
  return renderToStaticMarkup(<MusicFilesSection />);
};

describe("MusicFilesSection", () => {
  it("shows both warnings with the switches off, and nothing that needs a switch", () => {
    const html = render(false, false);
    expect(html).toContain(en.fileWrites.settings.stampNote);
    expect(html).toContain(en.fileWrites.settings.trimNote);
    expect(html.match(/role="switch"/g)).toHaveLength(2);
    expect(html.match(/aria-checked="false"/g)).toHaveLength(2);
    expect(html).not.toContain(en.fileWrites.settings.keepLabel);
    expect(html).not.toContain(en.fileWrites.settings.differLabel);
  });

  it("shows the backup limit with its three choices once replace is on", () => {
    const html = render(false, true);
    expect(html).toContain(en.fileWrites.settings.keepLabel);
    expect(html).toContain(en.fileWrites.settings.keep7);
    expect(html).toContain(en.fileWrites.settings.keep30);
    expect(html).toContain(en.fileWrites.settings.keepNever);
  });

  it("holds the differ row in its checking state until the backend answers", () => {
    const html = render(true, false);
    expect(html).toContain(en.fileWrites.settings.differChecking);
    expect(html).not.toContain(en.fileWrites.settings.lastWriteLabel);
  });

  it("stamps both rows for the finder", () => {
    const html = render(false, false);
    expect(html).toContain('data-setting-id="stampFiles"');
    expect(html).toContain('data-setting-id="trimReplace"');
  });

  it("hides the tag-write rows while the feature is off and keeps the replace ones", () => {
    const html = render(true, true, false);
    expect(html).not.toContain('data-setting-id="stampFiles"');
    expect(html).not.toContain(en.fileWrites.settings.stampNote);
    expect(html).not.toContain(en.fileWrites.settings.differLabel);
    expect(html.match(/role="switch"/g)).toHaveLength(1);
    expect(html).toContain('data-setting-id="trimReplace"');
    expect(html).toContain(en.fileWrites.settings.keepLabel);
  });
});
