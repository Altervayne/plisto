// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { AmbientText } from "./AmbientText";
import { streamNowFixture } from "../../../state/player/streamFixtures";

// -- Type Imports --
import type { StreamNow } from "../../../types";

const h = vi.hoisted(() => ({ now: null as StreamNow | null }));

vi.mock("../../../state/player/store", () => ({
  usePlayingFrom: () => null,
  useSeatedStream: () => h.now,
}));
vi.mock("../../../state/organize/store", () => ({ useAlbum: () => undefined }));
vi.mock("../useTrackDisplay", () => ({ useTrackDisplay: () => ({ title: null, artist: null }) }));

const render = (faded = false) => renderToStaticMarkup(<AmbientText trackId={-41} faded={faded} />);

beforeEach(() => {
  h.now = streamNowFixture();
});

describe("AmbientText with a stream seated", () => {
  it("shows the stream's lines and the plugin name", () => {
    const html = render();
    expect(html).toContain("Marlo Fenn - Slow Harbor");
    expect(html).toContain("Lowlight Jazz");
    expect(html).toContain("Streaming from Night Radio");
  });

  it("keeps the plugin name out of the fading lines, so it stays when the chrome fades", () => {
    expect(render(true)).not.toContain("data-faded");
    expect(render(true)).toContain("Night Radio");
  });

  it("renders no Live text", () => {
    for (const live of [true, false]) {
      h.now = streamNowFixture({ live });
      expect(render()).not.toMatch(/\blive\b/i);
    }
  });
});
