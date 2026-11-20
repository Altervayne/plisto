// -- Test Imports --
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../../lib/ipc", () => ({ getSetting: vi.fn(), setSetting: vi.fn() }));

// -- Unit Imports --
import { PREF_KEYS, usePreferencesStore, useStampFiles } from "./store";

function Probe() {
  return <>{String(useStampFiles())}</>;
}

describe("useStampFiles", () => {
  it("reads false with the preference on while the feature switch is off", () => {
    usePreferencesStore.setState({ values: { [PREF_KEYS.stampFiles]: "1" }, failedKeys: new Set(), loaded: true });
    expect(renderToStaticMarkup(<Probe />)).toBe("false");
  });
});
