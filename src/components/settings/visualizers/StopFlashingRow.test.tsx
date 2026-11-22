// -- Framework Imports --
import { isValidElement } from "react";
import type { ReactElement, ReactNode } from "react";

// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { StopFlashingRow } from "./StopFlashingRow";
import { Switch } from "../../common/Switch/Switch";

// -- State Imports --
import { PREF_KEYS, usePreferencesStore } from "../../../state/preferences/store";

// -- i18n Imports --
import { en } from "../../../i18n/en";

const h = vi.hoisted(() => ({ setSetting: vi.fn((_key: string, _value: string) => Promise.resolve()) }));

// A static render reads a store's initial state; hooks read the live state instead.
vi.mock("zustand", async (orig) => {
  const real = await orig<typeof import("zustand")>();
  const create = ((init: never) => {
    const store = real.create(init);
    const hook = (select: (s: unknown) => unknown = (s) => s) => select(store.getState());
    return Object.assign(hook, store);
  }) as unknown as typeof real.create;
  return { ...real, create };
});
vi.mock("../../../lib/ipc", async (orig) => ({
  ...(await orig<typeof import("../../../lib/ipc")>()),
  setSetting: h.setSetting,
}));

const KEY = PREF_KEYS.playerVisualizerStopFlashing;

function switchOf(): ReactElement<Record<string, unknown>> {
  let found: ReactElement<Record<string, unknown>> | undefined;
  const walk = (node: ReactNode) => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (isValidElement<Record<string, unknown>>(node)) {
      if (node.type === Switch) found = node;
      walk(node.props.children as ReactNode);
    }
  };
  function Probe() {
    walk(StopFlashingRow());
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return found!;
}

beforeEach(() => {
  vi.clearAllMocks();
  usePreferencesStore.setState({ values: {}, failedKeys: new Set(), loaded: true });
});

describe("StopFlashingRow", () => {
  it("stamps its row with the label and hint, off by default", () => {
    const html = renderToStaticMarkup(<StopFlashingRow />);
    expect(html).toContain('data-setting-id="visualizerStopFlashing"');
    expect(html).toContain(en.settings.visualizersStopFlashing);
    expect(html).toContain(en.settings.visualizersStopFlashingHint);
    expect(switchOf().props.checked).toBe(false);
  });

  it("reads on only from a stored 1", () => {
    usePreferencesStore.setState({ values: { [KEY]: "1" } });
    expect(switchOf().props.checked).toBe(true);
    usePreferencesStore.setState({ values: { [KEY]: "true" } });
    expect(switchOf().props.checked).toBe(false);
  });

  it("writes the setting through its own key", () => {
    (switchOf().props.onChange as (on: boolean) => void)(true);
    expect(h.setSetting).toHaveBeenCalledWith(KEY, "1");
  });

  it("holds the switch until the preferences are read", () => {
    usePreferencesStore.setState({ loaded: false });
    expect(switchOf().props.disabled).toBe(true);
  });
});
