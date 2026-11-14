// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { toastLine } from "./toastLine";
import { manifest, row } from "../../state/plugins/fixtures";

// -- Type Imports --
import type { PluginToastEvent } from "../../state/plugins/uiQueue";

const event = (action: string | null = null): PluginToastEvent => ({
  request_id: "r1",
  id: "lyrics",
  kind: "toast",
  payload: { text: "Found it", action },
});

describe("toastLine", () => {
  it("names the plugin from its manifest, not from the toast", () => {
    const line = toastLine(row({ manifest: manifest({ name: "Lyrics" }) }), event(), "passed");
    expect(line).toEqual({ name: "Lyrics", tag: null, text: "Found it", action: null });
  });

  it("carries the tag its tier earns", () => {
    expect(toastLine(row({ tier: "native" }), event(), "passed")?.tag).toBe("native");
    expect(toastLine(row({ tier: "ui" }), event(), "passed")?.tag).toBeNull();
  });

  it("carries the action label when the toast has one", () => {
    expect(toastLine(row(), event("Show"), "passed")?.action).toBe("Show");
  });

  it("is null when the plugin row or its manifest is gone", () => {
    expect(toastLine(undefined, event(), "passed")).toBeNull();
    expect(toastLine(row({ manifest: null }), event(), "passed")).toBeNull();
  });
});
