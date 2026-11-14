// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { SoundPopover } from "./SoundPopover";

const h = vi.hoisted(() => ({
  name: null as string | null,
  view: null as object | null,
}));

vi.mock("../../state/player/store", () => ({
  useCurrentTrackId: () => 5,
  usePlayerStore: (select: (s: unknown) => unknown) => select({ status: { output_taken_over: false } }),
  useStreamPluginName: () => h.name,
}));
vi.mock("../../state/plugins/pluginStatus", () => ({
  usePluginStatusStore: (select: (s: unknown) => unknown) => select({ statuses: {} }),
}));
vi.mock("../../state/plugins/store", () => ({ usePlugins: () => [] }));
vi.mock("../../state/shell/store", () => ({ useOpenSettings: () => () => {} }));
vi.mock("../../state/sound/useSoundSettings", () => ({
  useSoundSettings: () => ({ eq: { on: true, gains: [] }, preampDb: 0 }),
  useSoundActions: () => ({ setOn: () => {}, setGain: () => {}, reset: () => {} }),
}));
vi.mock("../../state/sound/presets", () => ({ canReset: () => false }));
vi.mock("./takeoverModel", () => ({ takeoverView: () => h.view }));
vi.mock("./useReturnOutput", () => ({ useReturnOutput: () => ({ busy: false, giveBack: () => {} }) }));
vi.mock("./TakeoverNotice", () => ({ TakeoverNotice: () => <div data-takeover="" /> }));
vi.mock("./EqCurve", () => ({ EqCurve: () => null }));
vi.mock("./PresetRow", () => ({ PresetRow: () => null }));

const render = () => renderToStaticMarkup(<SoundPopover onClose={() => {}} />);

beforeEach(() => {
  h.name = "Night Radio";
  h.view = { kind: "held", id: "tandem" };
});

describe("SoundPopover stream line", () => {
  it("names the plugin and sits before the takeover block", () => {
    const html = render();
    const line = html.indexOf("Playing from Night Radio");
    expect(line).toBeGreaterThan(-1);
    expect(line).toBeLessThan(html.indexOf("data-takeover"));
  });

  it("shows alone when nothing holds the output", () => {
    h.view = null;
    const html = render();
    expect(html).toContain("Playing from Night Radio");
    expect(html).not.toContain("data-takeover");
  });

  it("is absent with no stream seated", () => {
    h.name = null;
    expect(render()).not.toContain("Playing from");
  });

  it("renders no Live text", () => {
    expect(render()).not.toMatch(/\blive\b/i);
  });
});
