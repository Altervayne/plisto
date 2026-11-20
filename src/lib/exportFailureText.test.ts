import { describe, expect, it } from "vitest";
import { createT } from "../i18n";
import { en } from "../i18n/en";
import { exportBusyText, exportFailureText } from "./exportFailureText";

describe("exportFailureText", () => {
  const t = createT("en");

  it("words a refusal by what holds the lock", () => {
    expect(exportFailureText(t, "a file write is running", false)).toBe(en.fileWrites.busy);
    expect(exportFailureText(t, new Error("a scan is already running"), true)).toBe(en.settings.locateBusy);
  });

  it("keeps the generic wording for any other failure", () => {
    expect(exportFailureText(t, "disk full", false)).toBe(en.export.exportFailed);
    expect(exportFailureText(t, "disk full", true)).toBe(en.export.deviceTransferFailed);
  });

  it("has no busy text for an unrelated failure", () => {
    expect(exportBusyText(t, "disk full")).toBeNull();
  });
});
