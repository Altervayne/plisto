// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

let runtime: string | null = null;
vi.mock("../../state/plugins/store", () => ({ usePluginRuntime: () => runtime }));
vi.mock("../../lib/ipc", () => ({ pluginsRestart: vi.fn(() => Promise.resolve()) }));

// -- Unit Imports --
import { SafeModeBanner, SafeModeBannerView } from "./SafeModeBanner";
import { attemptRestart } from "../../state/plugins/useRestart";

// -- IPC Imports --
import { pluginsRestart } from "../../lib/ipc";

// -- i18n Imports --
import { en } from "../../i18n/en";

beforeEach(() => {
  vi.mocked(pluginsRestart).mockClear();
});

describe("SafeModeBanner", () => {
  it("shows only while the runtime is safe", () => {
    for (const r of ["running", "held", null]) {
      runtime = r;
      expect(renderToStaticMarkup(<SafeModeBanner />)).toBe("");
    }
    runtime = "safe";
    expect(renderToStaticMarkup(<SafeModeBanner />)).toContain(en.plugins.safeBanner.line);
  });

  it("says plugins are off and offers Restart normally", () => {
    const html = renderToStaticMarkup(<SafeModeBannerView onRestart={() => {}} />);
    expect(html).toContain(en.plugins.safeBanner.line);
    expect(html).toContain(en.plugins.safeBanner.restart);
    expect(html).not.toContain('role="status"');
  });

  it("asks for a normal restart and returns no error when the call returns", async () => {
    expect(await attemptRestart(false)).toBeNull();
    expect(pluginsRestart).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("shows the failure where the button is when the restart is refused", async () => {
    const error = await attemptRestart(false, () => Promise.reject({ code: "io", message: "x" }));
    expect(error).not.toBeNull();
    const html = renderToStaticMarkup(<SafeModeBannerView onRestart={() => {}} error={error} />);
    expect(html).toContain('role="status"');
    expect(html).toContain(en.plugins.safeEntry.label);
  });
});
