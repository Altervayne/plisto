// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { folderName, removePrompt, retryable, stepLine } from "./locateCopy";

// -- i18n Imports --
import { createT } from "../../i18n";

// -- Type Imports --
import type { Locale } from "../../i18n/types";
import type { LocateStep } from "./locateFlow";
import type { RootRemovalImpact } from "../../types";

const LOCALES: Locale[] = ["en", "fr"];

const base = { name: "Music", folder: "E:\\Music" };

const STEPS: LocateStep[] = [
  { kind: "checking", ...base },
  {
    kind: "confirm",
    ...base,
    plan: { kind: "move", total: 200, sampled: 48, matched: 40, partial: true },
  },
  {
    kind: "confirm",
    ...base,
    plan: {
      kind: "merge",
      other_id: 2,
      other_tracks: 1,
      total: 100,
      matched: 90,
      albums_replaced: 2,
      partial: true,
    },
  },
  { kind: "done", ...base, missing: 3 },
  { kind: "refused", ...base, reason: { code: "no_match", sampled: 40, matched: 3 } },
  { kind: "refused", ...base, reason: { code: "same" } },
  { kind: "refused", ...base, reason: { code: "overlap", other: "D:\\Other" } },
  { kind: "refused", ...base, reason: { code: "unreadable" } },
  { kind: "refused", ...base, reason: { code: "inconclusive" } },
  { kind: "refused", ...base, reason: { code: "failed", message: "x" } },
  { kind: "refused", ...base, reason: { code: "busy" } },
];

describe("locate copy", () => {
  it.each(LOCALES)("leaves no raw token in any %s step line", (locale) => {
    const t = createT(locale);
    for (const step of STEPS) {
      const line = stepLine(t, step);
      expect(line, step.kind).toBeTruthy();
      expect(line).not.toMatch(/[{}]/);
    }
  });

  it("states the move's sampled counts and the merge's exact ones", () => {
    const t = createT("en");
    const move = stepLine(t, STEPS[1])!;
    expect(move).toContain("Found 40 of 48 checked tracks in E:\\Music.");
    expect(move).toContain("stay marked gone");
    const merge = stepLine(t, STEPS[2])!;
    expect(merge).toContain("(1 track)");
    expect(merge).toContain("2 albums made since the move are replaced.");
  });

  it("adds the missing count to the receipt only when tracks are missing", () => {
    const t = createT("en");
    expect(stepLine(t, STEPS[3])).toBe(
      "Music now points to E:\\Music. The other 3 tracks stay marked gone and come back if their files appear.",
    );
    expect(stepLine(t, { kind: "done", ...base, missing: 0 })).toBe("Music now points to E:\\Music.");
  });

  it("is silent while idle or running", () => {
    const t = createT("en");
    expect(stepLine(t, { kind: "idle" })).toBeNull();
    expect(stepLine(t, { kind: "running", ...base })).toBeNull();
  });

  it("offers a retry only where trying the same folder again can help", () => {
    expect(retryable({ code: "unreadable" })).toBe(true);
    expect(retryable({ code: "inconclusive" })).toBe(true);
    expect(retryable({ code: "no_match", sampled: 1, matched: 0 })).toBe(false);
    expect(retryable({ code: "busy" })).toBe(false);
  });

  it("reads the trailing folder name", () => {
    expect(folderName("D:\\Music\\Rock\\")).toBe("Rock");
    expect(folderName("/mnt/music")).toBe("music");
  });
});

describe("remove prompt", () => {
  const impact: RootRemovalImpact = {
    tracks: 120,
    albums_losing_members: 2,
    albums_emptied: 1,
    playlist_entries: 4,
    plays: 30,
  };

  it("keeps the counted album copy for an online root", () => {
    const line = removePrompt(createT("en"), impact, { name: "Music", offline: false, eligible: false });
    expect(line).toBe(
      "Remove this folder? This drops 120 tracks. 2 albums lose members. 1 album is emptied and removed.",
    );
  });

  it("leads an offline root with the offline copy and counts playlist entries", () => {
    const line = removePrompt(createT("en"), impact, { name: "Music", offline: true, eligible: true });
    expect(line).toBe(
      "Music is offline, so its files may only have moved. Removing it permanently drops its 120 tracks, with their albums and play history. 4 playlist entries go too.",
    );
  });

  it("omits the offline lead for an online all-gone root and the entries line at zero", () => {
    const line = removePrompt(
      createT("en"),
      { ...impact, playlist_entries: 0 },
      { name: "Music", offline: false, eligible: true },
    );
    expect(line).toBe(
      "Removing it permanently drops its 120 tracks, with their albums and play history.",
    );
  });
});
