// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { PlayerHero } from "./PlayerHero";
import { streamNowFixture } from "../../state/player/streamFixtures";

// -- Type Imports --
import type { PlayerStatus, StreamNow } from "../../types";

const h = vi.hoisted(() => ({
  seated: true,
  now: null as StreamNow | null,
  position: 2538,
  duration: 0,
  requestPage: vi.fn(),
  stop: vi.fn(),
  folded: false,
}));

type Found = { type: unknown; props: Record<string, unknown> };

/** Finds the first element in an unrendered tree that satisfies `match`. */
function findElement(node: unknown, match: (el: Found) => boolean): Found | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findElement(child, match);
      if (hit) return hit;
    }
    return null;
  }
  if (node == null || typeof node !== "object") return null;
  const el = node as Found;
  if (match(el)) return el;
  return findElement(el.props?.children, match);
}

vi.mock("../../state/player/store", () => ({
  useSeatedStream: () => (h.seated ? h.now : null),
  usePlayerActions: () => ({ seek: () => {}, stop: h.stop }),
  usePlayerStatus: () =>
    ({ position_secs: h.position, duration_secs: h.duration, volume: 1 }) as PlayerStatus,
  usePlayingFrom: () => ({ kind: "album", id: 1, label: "Salt Flats at Dusk" }),
}));
vi.mock("../../state/shell/store", () => ({ useRequestPluginPage: () => h.requestPage }));
// A fixed English translator, so the component can also be called as a plain function.
vi.mock("../../i18n", async (orig) => {
  const real = await orig<typeof import("../../i18n")>();
  return { ...real, useT: () => real.createT("en") };
});
vi.mock("../tracks/useTrackCover", () => ({ useTrackCover: () => ({ cover: null }) }));
vi.mock("./useTrackDisplay", () => ({
  useTrackDisplay: () => ({ title: "Harbor Lights", artist: "Ines Varga" }),
}));
vi.mock("../common/Cover/Cover", () => ({ Cover: () => <i data-cover="" /> }));
vi.mock("../sound/SoundMenu", () => ({ SoundMenu: () => null }));
vi.mock("./ambient/AmbientButton", () => ({ AmbientButton: () => null }));
vi.mock("./Volume", () => ({ Volume: () => null }));
vi.mock("./Transport", () => ({ Transport: () => <i data-transport="" /> }));
vi.mock("./SequenceToggle", () => ({ SequenceToggle: ({ kind }: { kind: string }) => <i data-seq={kind} /> }));
vi.mock("./VisualizerButton", () => ({ VisualizerButton: () => <i data-viz="" /> }));
vi.mock("./useFoldedRow", async (orig) => ({
  ...(await orig<typeof import("./useFoldedRow")>()),
  useFoldedRow: () => [{ current: null }, h.folded],
}));
vi.mock("../common/Tooltip", () => ({ Tooltip: ({ children }: { children: unknown }) => children as never }));

const render = () => renderToStaticMarkup(<PlayerHero trackId={-41} onNavigate={() => {}} />);

beforeEach(() => {
  h.seated = true;
  h.now = streamNowFixture();
  h.position = 2538;
  h.duration = 0;
  h.folded = false;
});

describe("PlayerHero with a stream seated", () => {
  it("names the plugin in the source line, as a link, under the Streaming from label", () => {
    const html = render();
    expect(html).toContain("Streaming from");
    expect(html).toMatch(/<button[^>]*>Night Radio<\/button>/);
    expect(html).not.toContain("Salt Flats at Dusk");
    expect(html).not.toContain("Playing from");
  });

  it("leads with the now line and puts the title beneath it", () => {
    const html = render();
    expect(html.indexOf("Marlo Fenn - Slow Harbor")).toBeLessThan(html.indexOf("Lowlight Jazz"));
    expect(html).not.toContain("Harbor Lights");
  });

  it("leads with the title over the artist when there is no now line", () => {
    h.now = streamNowFixture({ now: null, title: "Glass Orchard", artist: "Mira Okonkwo" });
    const html = render();
    expect(html.indexOf("Glass Orchard")).toBeLessThan(html.indexOf("Mira Okonkwo"));
  });

  it("keeps an empty second line when the plugin gives no artist, so the block holds its height", () => {
    h.now = streamNowFixture({ now: null, artist: null });
    const html = render();
    expect(html).not.toContain("Unknown Artist");
    expect(html).toMatch(/<p class="[^"]*artist[^"]*"> <\/p>/);
  });

  it("shows the wait word in the scrubbable item's times for connecting and reconnecting too", () => {
    h.duration = 2900;
    for (const [state, word] of [
      ["connecting", "Connecting"],
      ["reconnecting", "Reconnecting"],
    ] as const) {
      h.now = streamNowFixture({ live: false, seekable: true, state });
      const html = render();
      expect(html).toContain('role="slider"');
      expect(html).toContain(word);
    }
  });

  it("requests the plugin's page from the source link", () => {
    const tree = PlayerHero({ trackId: -41, onNavigate: () => {} });
    const line = findElement(tree, (el) => (el.type as { name?: string }).name === "StreamSourceLine");
    const source = (line?.type as (p: unknown) => unknown)(line?.props);
    const link = findElement(source, (el) => el.type === "button");
    (link?.props.onClick as () => void)();
    expect(h.requestPage).toHaveBeenCalledWith("night-radio", null);
  });

  it("shows no scrubber for a stream with no known length, only the time listened", () => {
    const html = render();
    expect(html).not.toContain('role="slider"');
    expect(html).toContain("42:18 listened");
  });

  it("shows no scrubber for a known length that is not seekable", () => {
    h.duration = 2900;
    h.now = streamNowFixture({ live: false, seekable: false });
    const html = render();
    expect(html).not.toContain('role="slider"');
    expect(html).toContain("42:18 listened");
  });

  it("keeps the scrubber and both times for a seekable item of known length", () => {
    h.duration = 2900;
    h.position = 761;
    h.now = streamNowFixture({ live: false, seekable: true, now: null });
    const html = render();
    expect(html).toContain('role="slider"');
    expect(html).toContain("12:41");
    expect(html).toContain("48:20");
  });

  it.each([
    ["connecting", "Connecting"],
    ["buffering", "Buffering"],
    ["reconnecting", "Reconnecting"],
  ] as const)("shows the word %s in the listened slot", (state, word) => {
    h.now = streamNowFixture({ state });
    const html = render();
    expect(html).toContain(word);
    expect(html).not.toContain(" listened");
  });

  it("shows Buffering between the times of a seek that waits on the download", () => {
    h.duration = 2900;
    h.position = 1798;
    h.now = streamNowFixture({ live: false, seekable: true, state: "buffering" });
    const html = render();
    expect(html).toContain('role="slider"');
    expect(html.indexOf("29:58")).toBeLessThan(html.indexOf("Buffering"));
    expect(html.indexOf("Buffering")).toBeLessThan(html.indexOf("48:20"));
  });

  it("leads the trailing group with Stop, which stops the stream", () => {
    const html = render();
    expect(html.indexOf('data-transport=""')).toBeLessThan(html.indexOf('aria-label="Stop"'));
    const tree = PlayerHero({ trackId: -41, onNavigate: () => {} });
    const stop = findElement(tree, (el) => el.props?.["aria-label"] === "Stop");
    (stop?.props.onClick as () => void)();
    expect(h.stop).toHaveBeenCalledTimes(1);
  });

  it("renders no Live text for a live item", () => {
    h.now = streamNowFixture({ live: true });
    expect(render()).not.toMatch(/\blive\b/i);
  });

  it("puts no animation class on the phase word", () => {
    h.now = streamNowFixture({ state: "reconnecting" });
    expect(render()).not.toMatch(/class="[^"]*(anim|pulse|blink|fade|spin|shimmer|flash)/i);
  });
});

describe("PlayerHero transport row", () => {
  it.each([true, false])("flanks the cluster with shuffle then repeat and leads with the visualizer (stream %s)", (seated) => {
    h.seated = seated;
    h.now = seated ? streamNowFixture() : null;
    const html = render();
    const order = [html.indexOf("data-viz"), html.indexOf('data-seq="shuffle"'), html.indexOf("data-transport"), html.indexOf('data-seq="repeat"')];
    expect(order.every((at) => at > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("has no Stop outside a stream", () => {
    h.seated = false;
    h.now = null;
    expect(render()).not.toContain('aria-label="Stop"');
  });
});

describe("PlayerHero with no stream", () => {
  it("is the library hero: the playing-from line, the track and its artist", () => {
    h.seated = false;
    h.now = null;
    h.duration = 266;
    h.position = 72;
    const html = render();
    expect(html).toContain("Playing from");
    expect(html).toContain("Salt Flats at Dusk");
    expect(html).toContain("Harbor Lights");
    expect(html).toContain("Ines Varga");
    expect(html).toContain('role="slider"');
  });
});

describe("PlayerHero transport row order", () => {
  it("keeps Sound and Visualizer before the transport at normal width", () => {
    const html = render();
    expect(html.indexOf("data-viz")).toBeLessThan(html.indexOf("data-transport"));
  });

  it("puts the transport before Sound and Visualizer when the row is folded", () => {
    h.folded = true;
    const html = render();
    expect(html.indexOf("data-transport")).toBeLessThan(html.indexOf("data-viz"));
    expect(html.indexOf("data-viz")).toBeLessThan(html.indexOf('aria-label="Stop"'));
  });
});
