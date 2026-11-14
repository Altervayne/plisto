// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { NowPlayingWidget } from "./NowPlayingWidget";
import { streamNowFixture } from "../../state/player/streamFixtures";

// -- Type Imports --
import type { StreamNow } from "../../types";

const h = vi.hoisted(() => ({ now: null as StreamNow | null }));

vi.mock("../../state/player/store", () => ({
  useCurrentTrackId: () => -41,
  usePlayerActions: () => ({ seek: () => {}, setRepeat: () => {} }),
  usePlayerStatus: () => ({ position_secs: 90, duration_secs: 0, repeat: "off", volume: 1 }),
  usePlayerSync: () => {},
  useSeatedStream: () => h.now,
}));
vi.mock("../../state/player/spectrum", () => ({ useSpectrumSync: () => {} }));
vi.mock("../../state/preferences/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/preferences/store")>()),
  useLoadPreferences: () => () => Promise.resolve(),
}));
vi.mock("../../lib/ipc", () => ({ hideNowPlayingWidget: () => {}, settleNowPlayingWidget: () => {} }));
vi.mock("../../lib/appWindow", () => ({ onWindowMoved: () => Promise.resolve(() => {}) }));
vi.mock("../tracks/useTrackCover", () => ({ useTrackCover: () => ({ cover: null }) }));
vi.mock("./useTrackDisplay", () => ({ useTrackDisplay: () => ({ title: null, artist: null }) }));
vi.mock("../common/Cover/Cover", () => ({ Cover: () => <i data-cover="" /> }));
vi.mock("./CoverBackdrop", () => ({ CoverBackdrop: () => null }));
vi.mock("./SpectrumRidge", () => ({ SpectrumRidge: () => null }));
vi.mock("./Transport", () => ({ Transport: () => null }));
vi.mock("./Volume", () => ({ Volume: () => null }));

const render = () => renderToStaticMarkup(<NowPlayingWidget />);

beforeEach(() => {
  h.now = streamNowFixture();
});

describe("NowPlayingWidget with a stream seated", () => {
  it.each(["connecting", "buffering", "playing", "paused", "reconnecting"] as const)(
    "names the plugin and the stream in %s",
    (state) => {
      h.now = streamNowFixture({ state });
      const html = render();
      expect(html).toContain("Night Radio");
      expect(html).toContain("Marlo Fenn - Slow Harbor");
    },
  );

  it("shows the listened time in place of a scrubber, and the waiting word", () => {
    expect(render()).toContain("1:30 listened");
    h.now = streamNowFixture({ state: "buffering" });
    expect(render()).toContain("Buffering");
  });

  it("renders no Live text", () => {
    for (const live of [true, false]) {
      h.now = streamNowFixture({ live });
      expect(render()).not.toMatch(/\blive\b/i);
    }
  });
});
