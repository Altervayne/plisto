// -- Test Imports --
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { SWAP_HOLD_MS, holdSwap, panelScheme, stepSwap } from "./panelScheme";
import { KindTile } from "./visualizers/tiles/KindTile";
import { seedKey } from "./visualizers/useCoverSeed";
import { PanelSchemeContext, isDarkScheme, schemeStamp, usePanelScheme } from "../../theme/scheme";

// -- State Imports --
import { applyPluginRows } from "../../state/player/pluginVisualizers";
import { isDarkOnly } from "../../state/player/visualizerKind";
import { visualizerDecl, visualizerRow } from "../../state/plugins/fixtures";

const h = vi.hoisted(() => ({ rootDark: false }));

vi.mock("../../theme", () => ({ useTheme: () => "system", isDarkTheme: () => h.rootDark }));
vi.mock("../../i18n", async (orig) => {
  const real = await orig<typeof import("../../i18n")>();
  return { ...real, useT: () => real.createT("en") };
});

// A stand-in plugin kind answers for a dark-only kind, so the rule is tested apart from the registry's rows.
const STUB = "com.example.stub/dark";

describe("the stamp rule", () => {
  it("stamps a dark-only kind and no other", () => {
    applyPluginRows([visualizerRow("com.example.stub", "Stub", [visualizerDecl({ id: "dark", dark_only: true })])]);
    expect(schemeStamp(panelScheme(isDarkOnly(STUB)))).toEqual({ "data-theme": "dark" });
    applyPluginRows([]);
    expect(schemeStamp(panelScheme(isDarkOnly("ridge")))).toEqual({});
    expect(schemeStamp(panelScheme(isDarkOnly("off")))).toEqual({});
  });

  it("is the scheme that the context hands to its readers", () => {
    function Reader() {
      return <i>{String(usePanelScheme())}</i>;
    }
    expect(renderToStaticMarkup(<Reader />)).toBe("<i>null</i>");
    expect(
      renderToStaticMarkup(
        <PanelSchemeContext.Provider value={panelScheme(true)}>
          <Reader />
        </PanelSchemeContext.Provider>,
      ),
    ).toBe("<i>dark</i>");
  });

  it("reads dark when either the island or the root is dark", () => {
    expect(isDarkScheme("dark", false)).toBe(true);
    expect(isDarkScheme(null, true)).toBe(true);
    expect(isDarkScheme(null, false)).toBe(false);
  });
});

describe("the soft swap", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("turns the class on at a flip and holds the state otherwise", () => {
    const rest = { darkOnly: false, soft: false };
    expect(stepSwap(rest, false)).toBe(rest);
    expect(stepSwap(rest, true)).toEqual({ darkOnly: true, soft: true });
    const flipped = { darkOnly: true, soft: true };
    expect(stepSwap(flipped, true)).toBe(flipped);
    expect(stepSwap(flipped, false)).toEqual({ darkOnly: false, soft: true });
  });

  it("ends after the hold", () => {
    const done = vi.fn();
    holdSwap(done);
    vi.advanceTimersByTime(SWAP_HOLD_MS - 1);
    expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("restarts when a flip lands inside the hold", () => {
    const first = vi.fn();
    const second = vi.fn();
    const cancel = holdSwap(first);
    vi.advanceTimersByTime(SWAP_HOLD_MS - 100);
    cancel();
    holdSwap(second);
    vi.advanceTimersByTime(SWAP_HOLD_MS - 1);
    expect(second).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe("KindTile in a panel scheme", () => {
  const thumbOf = (scheme: "dark" | null) =>
    renderToStaticMarkup(
      <PanelSchemeContext.Provider value={scheme}>
        <KindTile kind="ridge" checked={false} />
      </PanelSchemeContext.Provider>,
    );

  it("takes the dark still inside a dark island under a light root", () => {
    h.rootDark = false;
    expect(thumbOf("dark")).toContain("ridge-dark");
    expect(thumbOf(null)).toContain("ridge-light");
  });

  it("keeps the dark still under a dark root", () => {
    h.rootDark = true;
    expect(thumbOf(null)).toContain("ridge-dark");
  });
});

describe("useCoverSeed's look", () => {
  it("keys the seed on the dark argument", () => {
    expect(seedKey(7, true)).not.toBe(seedKey(7, false));
    expect(seedKey(7, true)).toBe("7:dark");
  });
});
