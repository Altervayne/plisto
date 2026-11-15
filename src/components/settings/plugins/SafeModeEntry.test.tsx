// -- Test Imports --
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { SafeModeEntryView } from "./SafeModeEntry";
import { attemptRestart } from "../../../state/plugins/useRestart";

// -- i18n Imports --
import { en } from "../../../i18n/en";

const entry = (safe: boolean, error: Parameters<typeof SafeModeEntryView>[0]["error"] = null) =>
  renderToStaticMarkup(<SafeModeEntryView safe={safe} onRestart={() => {}} error={error} />);

describe("SafeModeEntry", () => {
  it("offers a restart without plugins while they run", () => {
    const html = entry(false);
    expect(html).toContain(en.plugins.safeEntry.restartSafe);
    expect(html).toContain(en.plugins.safeEntry.helperRunning);
    expect(html).toContain('data-setting-id="safeMode"');
    expect(html).not.toContain('role="status"');
  });

  it("shows the safe state and a normal restart while plugins are off", () => {
    const html = entry(true);
    expect(html).toContain(en.plugins.safeEntry.restartNormal);
    expect(html).toContain(en.plugins.safeEntry.helperSafe);
    expect(html).not.toContain(en.plugins.safeEntry.restartSafe);
  });

  it("asks for the opposite of the current state", async () => {
    const asked: boolean[] = [];
    await attemptRestart(true, (safe) => {
      asked.push(safe);
      return Promise.resolve();
    });
    expect(asked).toEqual([true]);
  });

  it("shows the failure under the row when the restart is refused", async () => {
    const error = await attemptRestart(true, () => Promise.reject({ code: "io", message: "x" }));
    expect(error).not.toBeNull();
    const html = entry(false, error);
    expect(html).toContain('role="status"');
    expect(html).toContain(en.plugins.sheet.close);
  });
});
