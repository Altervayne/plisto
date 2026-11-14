// -- Test Imports --
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { QueueStreamCard } from "./QueueStreamCard";
import { streamNowFixture } from "../../state/player/streamFixtures";

vi.mock("../../state/player/store", () => ({
  usePlayerActions: () => ({ stop: () => {} }),
  usePlayerStore: (select: (s: unknown) => unknown) =>
    select({ status: { position_secs: 761.4, duration_secs: 0 } }),
}));
vi.mock("../tracks/useTrackCover", () => ({ useTrackCover: () => ({ cover: null }) }));
vi.mock("../common/Cover/Cover", () => ({ Cover: () => <i data-cover="" /> }));

const render = (over = {}) => renderToStaticMarkup(<QueueStreamCard stream={streamNowFixture(over)} />);

describe("QueueStreamCard", () => {
  it.each(["connecting", "buffering", "playing", "paused", "reconnecting"] as const)(
    "names the plugin in %s",
    (state) => {
      expect(render({ state })).toContain("Night Radio");
    },
  );

  it("shows the now line, else the title, and a static word while waiting", () => {
    expect(render()).toContain("Marlo Fenn - Slow Harbor");
    expect(render({ now: null })).toContain("Lowlight Jazz");
    const waiting = render({ state: "buffering" });
    expect(waiting).toContain("Buffering");
    expect(waiting).not.toContain("Marlo Fenn");
  });

  it("carries a Stop control and no Live text, live or not", () => {
    for (const live of [true, false]) {
      const html = render({ live });
      expect(html).toContain('aria-label="Stop"');
      expect(html).not.toMatch(/\blive\b/i);
    }
  });

  it("puts no animation class on the phase word", () => {
    expect(render({ state: "reconnecting" })).not.toMatch(/class="[^"]*(anim|pulse|blink|fade|spin|shimmer|flash)/i);
  });
});
