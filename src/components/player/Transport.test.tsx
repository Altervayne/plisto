// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { Transport } from "./Transport";
import { streamNowFixture } from "../../state/player/streamFixtures";

// -- Type Imports --
import type { StreamNow } from "../../types";

const h = vi.hoisted(() => ({
  playing: false,
  seated: false,
  now: null as StreamNow | null,
  actions: { toggle: vi.fn(), pause: vi.fn(), resume: vi.fn() },
}));

vi.mock("../../state/player/store", () => ({
  useIsPlaying: () => h.playing,
  useSeatedStream: () => (h.seated ? h.now : null),
  usePlayerActions: () => h.actions,
}));
// A fixed English translator, so the component can also be called as a plain function.
vi.mock("../../i18n", async (orig) => {
  const real = await orig<typeof import("../../i18n")>();
  return { ...real, useT: () => real.createT("en") };
});
// The tooltip bubble needs a DOM and a hover; the stand-in prints its label where a test can read it.
vi.mock("../common/Tooltip", () => ({
  Tooltip: ({ label, children }: { label: string; children: unknown }) => (
    <span data-tip={label}>{children as never}</span>
  ),
}));

const render = (props: Parameters<typeof Transport>[0] = {}) => renderToStaticMarkup(<Transport {...props} />);

/** The markup of the button carrying `label`, from its opening tag to its close. */
const button = (html: string, label: string): string => {
  const at = html.indexOf(`aria-label="${label}"`);
  const open = html.lastIndexOf("<button", at);
  return html.slice(open, html.indexOf("</button>", at));
};

const seat = (over: Partial<StreamNow> = {}) => {
  h.seated = true;
  h.now = streamNowFixture(over);
};

beforeEach(() => {
  h.playing = false;
  h.seated = false;
  h.now = null;
});

describe("Transport with no stream", () => {
  it("is the plain cluster: Play when stopped, no Stop, nothing dimmed", () => {
    const html = render({ withStop: true });
    expect(html).toContain('aria-label="Play"');
    expect(html).not.toContain('aria-label="Stop"');
    expect(html).not.toContain("aria-disabled");
    expect(html).not.toContain("data-tip");
  });

  it("follows the engine's playing flag", () => {
    h.playing = true;
    expect(render()).toContain('aria-label="Pause"');
  });
});

describe("Transport with a stream seated", () => {
  it.each(["connecting", "buffering", "reconnecting", "playing"] as const)(
    "shows Pause in %s even though the engine is not playing",
    (state) => {
      seat({ state });
      const html = render();
      expect(html).toContain('aria-label="Pause"');
      expect(html).not.toContain('aria-label="Play"');
    },
  );

  it("shows Play only in paused", () => {
    seat({ state: "paused" });
    h.playing = true;
    const html = render();
    expect(html).toContain('aria-label="Play"');
    expect(html).not.toContain('aria-label="Pause"');
  });

  it("dims Next and Previous without skip and names the plugin in the tooltip", () => {
    seat({ skip: { next: false, prev: false } });
    const html = render();
    expect(button(html, "Next")).toContain('aria-disabled="true"');
    expect(button(html, "Previous")).toContain('aria-disabled="true"');
    expect(html).toContain('data-tip="Night Radio does not skip tracks"');
  });

  it("leaves a skip the plugin accepts enabled and the other dimmed", () => {
    seat({ skip: { next: true, prev: false } });
    const html = render();
    expect(button(html, "Next")).not.toContain("aria-disabled");
    expect(button(html, "Previous")).toContain('aria-disabled="true"');
  });

  it("adds Stop after Next when asked, and not otherwise", () => {
    seat();
    const html = render({ withStop: true });
    expect(html.indexOf('aria-label="Next"')).toBeLessThan(html.indexOf('aria-label="Stop"'));
    expect(render()).not.toContain('aria-label="Stop"');
  });

  it("renders no Live text for a live item", () => {
    seat({ live: true });
    expect(render({ withStop: true, shortcutHints: true })).not.toMatch(/live/i);
  });
});

/** Finds the first element in an unrendered tree whose aria-label is `label`. */
function findLabelled(node: unknown, label: string): { props: Record<string, unknown> } | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findLabelled(child, label);
      if (hit) return hit;
    }
    return null;
  }
  if (node == null || typeof node !== "object") return null;
  const el = node as { props?: Record<string, unknown> };
  if (el.props?.["aria-label"] === label) return el as { props: Record<string, unknown> };
  return findLabelled(el.props?.children, label);
}

/** Presses the labelled button of a Transport rendered as plain function output. */
const press = (label: string) => {
  const hit = findLabelled(Transport({}), label);
  (hit?.props.onClick as () => void)();
};

describe("Transport main button", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("toggles on a library track", () => {
    press("Play");
    expect(h.actions.toggle).toHaveBeenCalledTimes(1);
  });

  it("pauses, never toggles, while a stream connects, buffers or reconnects", () => {
    for (const state of ["connecting", "buffering", "reconnecting", "playing"] as const) {
      seat({ state });
      press("Pause");
    }
    expect(h.actions.pause).toHaveBeenCalledTimes(4);
    expect(h.actions.toggle).not.toHaveBeenCalled();
  });

  it("resumes, never toggles, when the stream is paused", () => {
    seat({ state: "paused" });
    press("Play");
    expect(h.actions.resume).toHaveBeenCalledTimes(1);
    expect(h.actions.toggle).not.toHaveBeenCalled();
  });
});
