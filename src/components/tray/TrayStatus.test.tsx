// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { TrayStatus } from "./TrayStatus";
import { streamNowFixture } from "../../state/player/streamFixtures";

// -- Type Imports --
import type { StreamNow } from "../../types";

const h = vi.hoisted(() => ({ now: null as StreamNow | null }));

vi.mock("../../state/player/store", () => ({
  useCurrentTrackId: () => -41,
  usePlayerSync: () => {},
  useSeatedStream: () => h.now,
}));
vi.mock("../../state/preferences/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/preferences/store")>()),
  useLoadPreferences: () => () => Promise.resolve(),
}));
vi.mock("../../theme", () => ({ useApplyTheme: () => {} }));
vi.mock("../../lib/ipc", () => ({
  getExportStatus: () => Promise.resolve({ running: false, progress: null }),
  quitApp: () => {},
  showMainWindow: () => {},
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
vi.mock("../tracks/useTrackCover", () => ({ useTrackCover: () => ({ cover: null }) }));
vi.mock("../player/useTrackDisplay", () => ({ useTrackDisplay: () => ({ title: null, artist: null }) }));
vi.mock("../common/Cover/Cover", () => ({ Cover: () => <i data-cover="" /> }));
vi.mock("../scan/StaffSpinner", () => ({ StaffSpinner: () => null }));
vi.mock("../player/PopOutButton", () => ({ PopOutButton: () => null }));
vi.mock("../player/Transport", () => ({ Transport: () => null }));

const render = () => renderToStaticMarkup(<TrayStatus />);

beforeEach(() => {
  h.now = streamNowFixture();
});

describe("TrayStatus with a stream seated", () => {
  it("names the plugin and shows the now line, else the title", () => {
    const html = render();
    expect(html).toContain("Night Radio");
    expect(html).toContain("Marlo Fenn - Slow Harbor");
    h.now = streamNowFixture({ now: null });
    expect(render()).toContain("Lowlight Jazz");
  });

  it("puts one static word in place of the line while waiting, with the plugin name kept", () => {
    h.now = streamNowFixture({ state: "reconnecting" });
    const html = render();
    expect(html).toContain("Reconnecting");
    expect(html).toContain("Night Radio");
  });

  it("renders no Live text", () => {
    for (const live of [true, false]) {
      h.now = streamNowFixture({ live });
      expect(render()).not.toMatch(/\blive\b/i);
    }
  });
});
