// -- Test Imports --
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { CapabilityList } from "./ReviewSheet/CapabilityList";
import { PluginRowPanel } from "./PluginRowPanel";
import { isDevOrigin } from "../../../state/plugins/origins";
import { inspection, manifest, row } from "../../../state/plugins/fixtures";
import { subjectFromInspection } from "../../../state/plugins/review";

// -- i18n Imports --
import { en } from "../../../i18n/en";
import { fr } from "../../../i18n/fr";

// -- Type Imports --
import type { PluginCapability, PluginInspection, PluginRow } from "../../../types";

const sheet = (over: Partial<PluginInspection>) =>
  renderToStaticMarkup(<CapabilityList subject={subjectFromInspection(inspection(over))} heading="Can" />);

const panel = (over: Partial<PluginRow>) =>
  renderToStaticMarkup(<PluginRowPanel row={row(over)} busy={false} onToggle={() => {}} onUninstall={() => {}} />);

const caps = (...c: PluginCapability[]) => c;
const how = en.plugins.sheet.networkHow;
const reads = en.plugins.sheet.networkReadsNote;

describe("review sheet network lines", () => {
  it("states how Plisto connects whenever network is declared", () => {
    expect(sheet({ capabilities: caps("network") })).toContain(how);
    expect(sheet({ capabilities: caps("network", "playback.read") })).toContain(how);
    expect(sheet({ capabilities: caps("network"), tier: "native" })).toContain(how);
    expect(sheet({ capabilities: caps("storage") })).not.toContain(how);
  });

  it("warns about reads for network plus library.read or playback.read", () => {
    expect(sheet({ capabilities: caps("network", "library.read") })).toContain(reads);
    expect(sheet({ capabilities: caps("network", "playback.read") })).toContain(reads);
  });

  it("does not warn for network alone or on a native subject", () => {
    expect(sheet({ capabilities: caps("network") })).not.toContain(reads);
    expect(sheet({ capabilities: caps("network", "library.read"), tier: "native" })).not.toContain(reads);
  });

  it("tags a dev origin and no other", () => {
    const html = sheet({ capabilities: caps("network"), origins: ["http://127.0.0.1:8080", "api.example.com"] });
    expect(html.split(en.plugins.sheet.devOrigin)).toHaveLength(2);
    expect(isDevOrigin("http://localhost:3000")).toBe(true);
    expect(isDevOrigin("https://api.example.com")).toBe(false);
  });
});

describe("row panel origins", () => {
  it("lists granted_origins even when the manifest summary differs", () => {
    const html = panel({
      granted_origins: ["enforced.example.com", "http://127.0.0.1:9000"],
      manifest: manifest({ origins: ["declared.example.com"] }),
    });
    expect(html).toContain("enforced.example.com");
    expect(html).toContain("http://127.0.0.1:9000");
    expect(html).toContain(en.plugins.sheet.devOrigin);
    expect(html).not.toContain("declared.example.com");
  });
});

describe("network copy keys", () => {
  it.each([
    ["en", en],
    ["fr", fr],
  ] as const)("has every key in %s", (_name, dict) => {
    expect(dict.plugins.capability.network).toBeTruthy();
    expect(dict.plugins.sheet.networkHow).toBeTruthy();
    expect(dict.plugins.sheet.networkReadsNote).toBeTruthy();
    expect(dict.plugins.sheet.devOrigin).toBeTruthy();
    expect(dict.plugins.devMode.loopbackNote).toBeTruthy();
  });
});
