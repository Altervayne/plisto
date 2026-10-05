// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { scanSummaryParts } from "./scanSummaryParts";
import type { SummaryPart } from "./scanSummaryParts";

// -- i18n Imports --
import { createT } from "../../i18n";

// -- Type Imports --
import type { LibrarySummary } from "../../state/librarySync";

// A rescan that touched every counter, so each worded part shows.
const busy: LibrarySummary = {
  source: "blocking",
  total: 1240,
  seen: 1240,
  inserted: 3,
  updated: 1,
  skipped: 0,
  removed: 2,
  missing: 4,
  returned: 0,
  errors: 1,
  cancelled: true,
  offline_roots: [],
  deferred: 0,
};

// A background session with nothing to report: no library-wide counts, no changes.
const quietSession: LibrarySummary = {
  source: "sync",
  total: 0,
  seen: 0,
  inserted: 0,
  updated: 0,
  skipped: 0,
  removed: 0,
  missing: 0,
  returned: 0,
  errors: 0,
  cancelled: false,
  offline_roots: [],
  deferred: 0,
};

// The line as the view would read it, each linked count standing in as a tag.
const read = (parts: SummaryPart[]) =>
  parts.map((p) => (p.kind === "text" ? p.text : `${p.kind}:${p.n}`));

describe("scanSummaryParts after a blocking scan", () => {
  it("words every part in English, gone last", () => {
    expect(read(scanSummaryParts(busy, createT("en")))).toEqual([
      "1,240 indexed",
      "3 new",
      "1 changed",
      "2 removed",
      "1 unreadable",
      "cancelled",
      "gone:4",
    ]);
  });

  it("words every part in French, with its plural", () => {
    const parts = read(scanSummaryParts(busy, createT("fr")));
    expect(parts[0]).toMatch(/^1\s240 indexées$/);
    expect(parts.slice(1)).toEqual([
      "3 nouvelles",
      "1 modifiée",
      "2 retirées",
      "1 illisible",
      "annulée",
      "gone:4",
    ]);
  });

  it("drops the new count on a first scan, where it only echoes the total", () => {
    const first = { ...busy, inserted: 1240, updated: 0, removed: 0, missing: 0, errors: 0, cancelled: false };
    expect(read(scanSummaryParts(first, createT("en")))).toEqual(["1,240 indexed"]);
  });
});

describe("scanSummaryParts after a background session", () => {
  const changed: LibrarySummary = {
    ...quietSession,
    inserted: 12,
    updated: 1,
    returned: 2,
    missing: 3,
    errors: 1,
    deferred: 1,
  };

  it("lists only the changes, never an indexed count", () => {
    expect(read(scanSummaryParts(changed, createT("en")))).toEqual([
      "12 new",
      "1 changed",
      "2 returned",
      "gone:3",
      "1 unreadable",
      "1 still copying",
    ]);
  });

  it("words the changes in French, with their plurals", () => {
    expect(read(scanSummaryParts(changed, createT("fr")))).toEqual([
      "12 nouvelles",
      "1 modifiée",
      "2 revenues",
      "gone:3",
      "1 illisible",
      "1 en cours de copie",
    ]);
  });

  it("skips the zero counts", () => {
    const one = { ...quietSession, deferred: 2 };
    expect(read(scanSummaryParts(one, createT("en")))).toEqual(["2 still copying"]);
  });

  it("reads up to date when nothing changed", () => {
    expect(read(scanSummaryParts(quietSession, createT("en")))).toEqual(["Up to date"]);
    expect(read(scanSummaryParts(quietSession, createT("fr")))).toEqual(["À jour"]);
  });
});

describe("goneSummary", () => {
  it("reads one and many in both locales", () => {
    const en = createT("en");
    const fr = createT("fr");
    expect(en((d) => d.tracks.goneSummary, { n: 1 })).toBe("1 gone from disk");
    expect(en((d) => d.tracks.goneSummary, { n: 3 })).toBe("3 gone from disk");
    expect(fr((d) => d.tracks.goneSummary, { n: 1 })).toBe("1 absente du disque");
    expect(fr((d) => d.tracks.goneSummary, { n: 3 })).toBe("3 absentes du disque");
  });
});

describe("scanSummaryParts with possible duplicates", () => {
  it("closes the line with the duplicates count after either source", () => {
    const en = createT("en");
    expect(read(scanSummaryParts(quietSession, en, 2))).toEqual(["Up to date", "duplicates:2"]);
    expect(read(scanSummaryParts(busy, en, 1)).slice(-2)).toEqual(["gone:4", "duplicates:1"]);
  });

  it("leaves the line alone with none", () => {
    expect(read(scanSummaryParts(quietSession, createT("en"), 0))).toEqual(["Up to date"]);
  });

  it("words the count in both locales", () => {
    const en = createT("en");
    const fr = createT("fr");
    expect(en((d) => d.duplicates.scanSummary, { n: 1 })).toBe("1 possible duplicate");
    expect(en((d) => d.duplicates.scanSummary, { n: 3 })).toBe("3 possible duplicates");
    expect(fr((d) => d.duplicates.scanSummary, { n: 1 })).toBe("1 doublon possible");
    expect(fr((d) => d.duplicates.scanSummary, { n: 3 })).toBe("3 doublons possibles");
  });
});
