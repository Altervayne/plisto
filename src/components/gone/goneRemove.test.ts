// -- Test Imports --
import { describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { NOT_SAVED, removeFailureLine, removeGone } from "./goneRemove";
import { createT } from "../../i18n";

describe("removeGone", () => {
  it("passes the scoped ids to the purge and reports the rows removed", async () => {
    const purge = vi.fn().mockResolvedValue({ removed: 3, albums_emptied: 0 });
    expect(await removeGone([4, 5, 6], purge)).toEqual({ kind: "done", removed: 3 });
    expect(purge).toHaveBeenCalledWith([4, 5, 6]);
  });

  it("does not call the purge for an empty list", async () => {
    const purge = vi.fn();
    expect(await removeGone([], purge)).toEqual({ kind: "done", removed: 0 });
    expect(purge).not.toHaveBeenCalled();
  });

  it("maps the restore-point refusal, however the rejection is wrapped", async () => {
    for (const rejection of [NOT_SAVED, new Error(NOT_SAVED)]) {
      const purge = vi.fn().mockRejectedValue(rejection);
      expect(await removeGone([1], purge)).toEqual({ kind: "failed", reason: "not_saved" });
    }
  });

  it("maps a scan or a file write in progress and any other failure", async () => {
    const busy = vi.fn().mockRejectedValue("a scan is already running");
    expect(await removeGone([1], busy)).toEqual({ kind: "failed", reason: "busy" });
    const writing = vi.fn().mockRejectedValue("a file write is running");
    expect(await removeGone([1], writing)).toEqual({ kind: "failed", reason: "fileWrite" });
    const broken = vi.fn().mockRejectedValue("index is unavailable");
    expect(await removeGone([1], broken)).toEqual({ kind: "failed", reason: "failed" });
  });
});

describe("removeFailureLine", () => {
  it("words the restore-point refusal itself, in both languages, and says nothing was removed", () => {
    const en = removeFailureLine(createT("en"), "not_saved");
    const fr = removeFailureLine(createT("fr"), "not_saved");
    expect(en).toContain("Nothing was removed");
    expect(en).not.toBe(NOT_SAVED);
    expect(fr).toContain("Rien n'a été retiré");
  });

  it("has a line for every reason in both languages", () => {
    for (const locale of ["en", "fr"] as const) {
      for (const reason of ["not_saved", "busy", "fileWrite", "failed"] as const) {
        expect(removeFailureLine(createT(locale), reason).length).toBeGreaterThan(0);
      }
    }
  });
});
