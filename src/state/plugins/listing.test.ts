// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import fixtures from "../../../src-tauri/src/plugins/listing/fixtures.json";

// -- Type Imports --
import type { PluginCapability, PluginListing } from "../../types";

/*
 * The listing is computed in Rust (plugins/listing.rs) and only read here. These are the same fixtures
 * the Rust test runs, so the rule the app's copy describes cannot drift from the one Rust applies.
 */

interface RawManifest {
  tier: string;
  entry?: string | null;
  sidebar?: unknown;
  capabilities: string[];
  visualizers?: unknown[];
}

const FRAME_CAPABILITIES: PluginCapability[] = [
  "visualizer",
  "visualizer.waveform",
  "storage",
  "playback.read",
  "library.read",
];

function expectedListing(m: RawManifest): PluginListing {
  const visualizerOnly =
    m.tier === "ui" &&
    (m.visualizers?.length ?? 0) > 0 &&
    m.capabilities.includes("visualizer") &&
    m.entry == null &&
    m.sidebar == null &&
    m.capabilities.every((cap) => (FRAME_CAPABILITIES as string[]).includes(cap));
  return visualizerOnly ? "catalog" : "plugins";
}

const cases = fixtures as { name: string; manifest: RawManifest; listing: PluginListing }[];

describe("plugin listing fixtures", () => {
  it("cover both listings", () => {
    expect(cases.some((c) => c.listing === "catalog")).toBe(true);
    expect(cases.some((c) => c.listing === "plugins")).toBe(true);
  });

  it.each(cases.map((c) => [c.name, c] as const))("lists %s where the rule says", (_name, c) => {
    expect(["catalog", "plugins"]).toContain(c.listing);
    expect(expectedListing(c.manifest)).toBe(c.listing);
  });
});
