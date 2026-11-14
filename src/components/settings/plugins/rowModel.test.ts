// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { installedFrom, rowView, uninstallPrompt } from "./rowModel";
import { manifest, row } from "../../../state/plugins/fixtures";

describe("rowView", () => {
  it("shows the switch for a ready plugin, with the background marker when granted", () => {
    const view = rowView(row({ granted: ["background"] }), "passed");
    expect(view.action).toBe("switch");
    expect(view.status).toEqual({ kind: "on", background: true });
    expect(rowView(row({ enabled: false }), "passed").status).toEqual({ kind: "off", background: false });
  });

  it("offers Review for a plugin that needs consent", () => {
    const view = rowView(row({ state: "needs_consent", enabled: false, granted: [] }), "passed");
    expect(view.action).toBe("review");
    expect(view.status.kind).toBe("needsConsent");
  });

  it("offers only Uninstall for a broken plugin, with its reason", () => {
    const view = rowView(row({ state: "broken", enabled: false, problem: "plugin.json is invalid" }), "passed");
    expect(view.action).toBe("uninstall");
    expect(view.status).toEqual({ kind: "broken", reason: "plugin.json is invalid" });
    expect(view.expandable).toBe(false);
  });

  it("greys an incompatible plugin and names the Plisto it needs", () => {
    const m = manifest({ compat: { state: "needs_newer", min_plisto: "2.8.0" } });
    const view = rowView(row({ state: "incompatible", enabled: false, manifest: m }), "passed");
    expect(view.action).toBe("switch");
    expect(view.locked).toBe(true);
    expect(view.expandable).toBe(true);
    expect(view.grey).toBe(true);
    expect(view.status).toEqual({ kind: "incompatible", minVersion: "2.8.0" });
  });

  it("names a row by its id, with no version or tag, when the manifest cannot be read", () => {
    const view = rowView(
      row({ id: "party-mode", state: "broken", manifest: null, tier: "native", version: "" }),
      "passed",
    );
    expect(view.name).toBe("party-mode");
    expect(view.version).toBeNull();
    expect(view.tag).toBeNull();
  });

  it("tags a native plugin and shows the manifest name and the version", () => {
    const view = rowView(row({ tier: "native", manifest: manifest({ name: "Tandem" }), version: "0.9.2" }), "passed");
    expect(view.tag).toBe("native");
    expect(view.name).toBe("Tandem");
    expect(view.version).toBe("0.9.2");
  });

  it("can only be uninstalled when a plugin needing consent has no readable manifest", () => {
    const view = rowView(row({ state: "needs_consent", manifest: null }), "passed");
    expect(view.action).toBe("uninstall");
    expect(view.status.kind).toBe("unreadable");
  });
});

describe("uninstallPrompt", () => {
  it("words the prompt for the plugin's tier and state", () => {
    expect(uninstallPrompt(row())).toBe("ui");
    expect(uninstallPrompt(row({ enabled: false }))).toBe("uiOff");
    expect(uninstallPrompt(row({ tier: "native" }))).toBe("native");
    expect(uninstallPrompt(row({ tier: "native", enabled: false }))).toBe("nativeOff");
    expect(uninstallPrompt(row({ state: "incompatible", enabled: false }))).toBe("incompatible");
    expect(uninstallPrompt(row({ state: "broken", enabled: false }))).toBe("broken");
  });
});

describe("installedFrom", () => {
  const item = { name: "lyrics.plistoplugin", path: "C:\Inbox\Lyrics.plistoplugin", kind: "file" as const };

  it("matches an installed row's source path ignoring case", () => {
    expect(installedFrom(item, [row({ source_path: "c:\inbox\lyrics.PLISTOPLUGIN" })])).toBe(true);
  });

  it("does not match another path or a row with no source", () => {
    expect(installedFrom(item, [row({ source_path: "C:\Inbox\other" }), row({ source_path: null })])).toBe(false);
  });
});
