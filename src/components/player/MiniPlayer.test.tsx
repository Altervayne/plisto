// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { MiniPlayer } from "./MiniPlayer";
import { streamNowFixture } from "../../state/player/streamFixtures";

// -- Type Imports --
import type { StreamNow } from "../../types";

const h = vi.hoisted(() => ({
  trackId: -41 as number | null,
  seated: true,
  now: null as StreamNow | null,
  position: 0,
  duration: 0,
}));

vi.mock("../../state/player/store", () => ({
  useCurrentTrackId: () => h.trackId,
  useSeatedStream: () => (h.seated ? h.now : null),
  usePlayerStore: (select: (s: unknown) => unknown) =>
    select({ status: { position_secs: h.position, duration_secs: h.duration } }),
}));
vi.mock("../../state/store", () => ({ useTrack: () => undefined }));
vi.mock("../tracks/useTrackCover", () => ({ useTrackCover: () => ({ cover: null }) }));
vi.mock("./useTrackDisplay", () => ({ useTrackDisplay: () => ({ title: null, artist: null }) }));
vi.mock("../common/Cover/Cover", () => ({ Cover: () => <i data-cover="" /> }));
vi.mock("../sound/SoundMenu", () => ({ SoundMenu: () => null }));
vi.mock("./CoverBackdrop", () => ({ CoverBackdrop: () => null }));
vi.mock("./PopOutButton", () => ({ PopOutButton: () => null }));
vi.mock("./StopButton", () => ({ StopButton: () => <button type="button">stop</button> }));
vi.mock("./Transport", () => ({ Transport: () => null }));

const render = () => renderToStaticMarkup(<MiniPlayer onExpand={() => {}} />);

beforeEach(() => {
  h.trackId = -41;
  h.seated = true;
  h.now = streamNowFixture();
  h.position = 0;
  h.duration = 0;
});

describe("MiniPlayer with a stream seated", () => {
  it.each(["connecting", "buffering", "playing", "paused", "reconnecting"] as const)(
    "names the plugin in %s",
    (state) => {
      h.now = streamNowFixture({ state });
      expect(render()).toContain("Night Radio");
    },
  );

  it("shows the now line, else the title", () => {
    expect(render()).toContain("Marlo Fenn - Slow Harbor");
    h.now = streamNowFixture({ now: null });
    expect(render()).toContain("Lowlight Jazz");
  });

  it.each([
    ["connecting", "Connecting"],
    ["buffering", "Buffering"],
    ["reconnecting", "Reconnecting"],
  ] as const)("puts the static word %s in place of line 1", (state, word) => {
    h.now = streamNowFixture({ state });
    const html = render();
    expect(html).toContain(word);
    expect(html).not.toContain("Marlo Fenn");
    expect(html).toContain("Night Radio");
  });

  it("adds the Paused word only while paused", () => {
    h.now = streamNowFixture({ state: "paused" });
    expect(render()).toContain("Paused");
    h.now = streamNowFixture({ state: "playing" });
    expect(render()).not.toContain("Paused");
  });

  it("adds the elapsed time only with a known length", () => {
    h.position = 761.4;
    expect(render()).not.toContain("12:41");
    h.duration = 2900;
    expect(render()).toContain("12:41");
  });

  it("pins the Stop control visible instead of hover-only", () => {
    expect(render()).toMatch(/class="[^"]*sidePinned/);
    h.seated = false;
    h.now = null;
    h.trackId = 5;
    expect(render()).not.toMatch(/sidePinned/);
  });

  it("renders no Live text, with a live item or any other", () => {
    for (const live of [true, false]) {
      h.now = streamNowFixture({ live });
      expect(render()).not.toMatch(/\blive\b/i);
    }
  });

  it("puts no animation class on the phase word", () => {
    h.now = streamNowFixture({ state: "buffering" });
    expect(render()).not.toMatch(/class="[^"]*(anim|pulse|blink|fade|spin|shimmer|flash)/i);
  });

  it("renders as text, never markup, for a hostile plugin name", () => {
    h.now = streamNowFixture({ plugin_name: "<b>x</b>" });
    expect(render()).not.toContain("<b>x");
  });
});

describe("MiniPlayer with nothing seated", () => {
  it("renders nothing without a track id", () => {
    h.trackId = null;
    expect(render()).toBe("");
  });
});
