// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { VisualizerPopover } from "./VisualizerPopover";
import { visualizerPopoverModel, type PopoverStored, type PopoverSubject } from "./visualizerPopoverModel";

// -- State Imports --
import { buildCatalog, serializeCatalog } from "../../../../state/player/visualizerCatalog";

const h = vi.hoisted(() => ({ state: null as unknown }));

vi.mock("./useVisualizerPopoverModel", () => ({ useVisualizerPopoverModel: () => h.state }));
vi.mock("../../../../theme", () => ({ useTheme: () => "system", isDarkTheme: () => false }));

const track: PopoverSubject = { kind: "track", place: { kind: "album", trackId: 3, albumId: 7 } };
const album: PopoverSubject = { kind: "album", albumId: 7 };
const none: PopoverStored = { trackDefault: null, albumDefault: null };

const off = (kinds: string[], groups: string[] = []) => buildCatalog(serializeCatalog({ kinds, groups }), false);

function render(subject: PopoverSubject, stored: PopoverStored, catalog = off([])): string {
  h.state = {
    model: visualizerPopoverModel(subject, stored, catalog),
    title: "Salt Flats at Dusk",
    subtitle: null,
    ready: true,
    pick: vi.fn(),
  };
  return renderToStaticMarkup(<VisualizerPopover scope={{ track: 3 }} close={vi.fn()} back={vi.fn()} />);
}

const tabs = (html: string) => [...html.matchAll(/role="tab"[^>]*>([^<]+)/g)].map((m) => m[1]);
const selected = (html: string) => /role="tab" aria-selected="true"[^>]*>([^<]+)/.exec(html)?.[1];

beforeEach(() => {
  h.state = null;
});

describe("VisualizerPopover quiet line", () => {
  it("names a turned-off stored kind first", () => {
    const html = render(track, { trackDefault: "train", albumDefault: "glass" }, off(["train"]));
    expect(html).toContain("Track default: Train, turned off");
    expect(html).not.toContain("Album default: Glass");
  });

  it("names a turned-off album default when the track holds none", () => {
    const html = render(track, { trackDefault: null, albumDefault: "train" }, off(["train"]));
    expect(html).toContain("Album default: Train, turned off");
    expect(html).toContain("Use global pick");
  });

  it("names the stored album kind on the album's own popover", () => {
    const html = render(album, { trackDefault: null, albumDefault: "train" }, off(["train"]));
    expect(html).toContain("Album default: Train, turned off");
  });

  it("falls to the album default a track follows", () => {
    const html = render(track, { trackDefault: null, albumDefault: "glass" });
    expect(html).toContain("Album default: Glass");
    expect(html).not.toContain("turned off");
  });

  it("draws no line with nothing stored", () => {
    expect(render(track, none)).not.toMatch(/default: /);
  });
});

describe("VisualizerPopover tabs", () => {
  it("lists the offered families only", () => {
    expect(tabs(render(album, none, off([], ["dots"])))).toEqual(["Classic", "Fluid", "Cozy"]);
  });

  it("drops a family with no offered kind", () => {
    const html = render(album, none, off(["halftone", "dot-spectrum", "dot-cover"]));
    expect(tabs(html)).not.toContain("Dots");
  });

  it("opens on the stored kind's family", () => {
    expect(selected(render(album, { trackDefault: null, albumDefault: "ink" }))).toBe("Fluid");
  });

  it("opens on the first offered family when the stored kind's family is off", () => {
    const html = render(album, { trackDefault: null, albumDefault: "glass" }, off([], ["classic", "cozy"]));
    expect(tabs(html)).toEqual(["Dots", "Fluid"]);
    expect(selected(html)).toBe("Dots");
  });
});
