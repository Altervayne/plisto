// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { jobName } from "./ConfirmQuitDialog";

// -- i18n Imports --
import { createT } from "../../i18n";

describe("jobName", () => {
  it("names a running file write in both languages", () => {
    expect(jobName("file_write", createT("en"))).toBe("a write to your music files");
    expect(jobName("file_write", createT("fr"))).toBe("une écriture dans vos fichiers musicaux");
  });

  it("falls back to the key for a job it does not know", () => {
    expect(jobName("mystery", createT("en"))).toBe("mystery");
  });
});
