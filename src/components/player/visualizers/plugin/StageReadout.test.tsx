import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { StageReadout } from "./StageReadout";
import { en } from "../../../../i18n/en";
import type { FeedState } from "../../../../state/player/pluginVis/feedControl";
import type { StageReadout as Reading } from "../../../../state/player/pluginVis/stageReadout";

const h = vi.hoisted(() => ({
  dev: true,
  reading: { fps: 58, frameMs: "3.2", inFlight: 1, meter: "unwatched" } as Reading,
  feed: { phase: "idle", secs: 0, outcome: null } as FeedState,
  press: vi.fn(),
  sampled: vi.fn(),
}));

vi.mock("../../../../state/plugins/store", () => ({ useDevMode: () => h.dev }));
vi.mock("../../../../state/player/pluginVis/stageReadout", () => ({
  useStageReadout: (...args: unknown[]) => {
    h.sampled(...args);
    return h.reading;
  },
}));
vi.mock("../../../../state/player/pluginVis/feedControl", () => ({
  useFeedControl: () => [h.feed, h.press],
}));
vi.mock("../../../../i18n", () => ({
  useT: () => (pick: (d: typeof en) => string, vars?: Record<string, string | number>) =>
    pick(en).replace(/\{(\w+)\}/g, (_, k: string) => String(vars?.[k] ?? "")),
}));

const render = (shown = true) =>
  renderToStaticMarkup(<StageReadout kind="a.b/c" surface="player" shown={shown} />);

const idle = (outcome: FeedState["outcome"]): FeedState => ({ phase: "idle", secs: 0, outcome });

beforeEach(() => {
  h.dev = true;
  h.feed = idle(null);
  h.sampled.mockClear();
});

describe("the stage readout", () => {
  it("renders nothing, and samples nothing, while developer mode is off", () => {
    h.dev = false;
    expect(render()).toBe("");
    expect(h.sampled).not.toHaveBeenCalled();
  });

  it("renders nothing while the kind is not shown", () => {
    expect(render(false)).toBe("");
  });

  it("shows each value in its own labelled cell", () => {
    const html = render();
    expect(html).toContain(">58<");
    expect(html).toContain(">3.2<");
    expect(html).toContain(">Not watched<");
    expect(html).toContain(">In flight<");
    expect(html).toContain(">Record feed<");
    expect(h.sampled).toHaveBeenCalledWith("a.b/c", "player", true);
  });

  it("shows the counter and a Stop control while recording", () => {
    h.feed = { phase: "recording", secs: 7, outcome: null };
    const html = render();
    expect(html).toContain(">Recording 7 s<");
    expect(html).toContain(">Stop<");
    expect(html).not.toContain(">Record feed<");
  });

  it("shows a disabled Saving button while the save settles", () => {
    h.feed = { phase: "saving", secs: 0, outcome: null };
    const html = render();
    expect(html).toContain(">Saving<");
    expect(html).toContain("disabled");
    expect(html).not.toContain(">Stop<");
  });

  it("shows the saved file name", () => {
    h.feed = idle({ ok: true, file: "feed-1.json" });
    expect(render()).toContain(">Saved feed-1.json<");
  });

  it.each(["dev_mode_off", "not_on_stage", "busy", "stage_left", "too_short"] as const)(
    "shows its own line for %s",
    (reason) => {
      h.feed = idle({ ok: false, reason, detail: null });
      expect(render()).toContain(en.plugins.vis.readout[reason]);
    },
  );

  it("shows a save failure without a trailing space when there is no detail", () => {
    h.feed = idle({ ok: false, reason: "save_failed", detail: null });
    expect(render()).toContain(">The recording was not saved.<");
  });

  it("shows the save failure with its detail", () => {
    h.feed = idle({ ok: false, reason: "save_failed", detail: "disk full" });
    const html = render();
    expect(html).toContain("The recording was not saved. disk full");
    expect(html).not.toContain("title=");
  });
});
