// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The server renderer skips effects, so the hook is replaced by a controllable value and records its argument.
let proxy: PluginNetEnvironment["proxy"] = "none";
const enabledArgs: boolean[] = [];
vi.mock("../../../state/plugins/useNetEnvironment", async (orig) => ({
  ...(await orig<typeof import("../../../state/plugins/useNetEnvironment")>()),
  useNetEnvironment: (enabled: boolean) => {
    enabledArgs.push(enabled);
    return proxy;
  },
}));

const pluginNetEnvironment = vi.fn();
vi.mock("../../../lib/ipc", () => ({ pluginNetEnvironment: () => pluginNetEnvironment(), pluginDataSize: vi.fn() }));

// -- Unit Imports --
import { CapabilityList } from "./ReviewSheet/CapabilityList";
import { PluginRowPanel } from "./PluginRowPanel";
import { readProxy } from "../../../state/plugins/useNetEnvironment";
import { inspection, manifest, row } from "../../../state/plugins/fixtures";
import { subjectFromInspection } from "../../../state/plugins/review";

// -- i18n Imports --
import { en } from "../../../i18n/en";
import { fr } from "../../../i18n/fr";

// -- Type Imports --
import type { PluginCapability, PluginNetEnvironment } from "../../../types";

const warning = en.plugins.net.proxyWarning;

const sheet = (capabilities: PluginCapability[], tier: "ui" | "native" = "ui") =>
  renderToStaticMarkup(
    <CapabilityList subject={subjectFromInspection(inspection({ capabilities, tier }))} heading="Can" />,
  );

const panel = (granted: PluginCapability[]) =>
  renderToStaticMarkup(
    <PluginRowPanel
      row={row({ granted, manifest: manifest({ capabilities: granted }) })}
      busy={false}
      onToggle={() => {}}
      onUninstall={() => {}}
    />,
  );

beforeEach(() => {
  proxy = "none";
  enabledArgs.length = 0;
  pluginNetEnvironment.mockReset();
});

describe("proxy warning", () => {
  it.each(["manual", "pac", "detected"] as const)("shows on the sheet and the panel for %s", (value) => {
    proxy = value;
    expect(sheet(["network"])).toContain(warning);
    expect(sheet(["network"], "native")).toContain(warning);
    expect(panel(["network"])).toContain(warning);
  });

  it("does not show for none", () => {
    expect(sheet(["network"])).not.toContain(warning);
    expect(panel(["network"])).not.toContain(warning);
  });

  it("does not show without a network line, and the read is not requested", () => {
    proxy = "manual";
    expect(sheet(["storage"])).not.toContain(warning);
    expect(panel(["storage"])).not.toContain(warning);
    expect(enabledArgs).toEqual([false, false]);
  });

  it("requests the read where a network line shows", () => {
    sheet(["network"]);
    panel(["network"]);
    expect(enabledArgs).toEqual([true, true]);
  });
});

describe("readProxy", () => {
  it("returns the reported proxy state", async () => {
    pluginNetEnvironment.mockResolvedValue({ proxy: "pac" });
    await expect(readProxy()).resolves.toBe("pac");
  });

  it("reads a rejected call as none", async () => {
    pluginNetEnvironment.mockRejectedValue(new Error("no command"));
    await expect(readProxy()).resolves.toBe("none");
  });
});

describe("proxy warning copy", () => {
  it.each([
    ["en", en],
    ["fr", fr],
  ] as const)("has the key in %s", (_name, dict) => {
    expect(dict.plugins.net.proxyWarning).toBeTruthy();
  });
});
