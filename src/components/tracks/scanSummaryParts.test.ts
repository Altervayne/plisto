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
  issues: 1,
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
  issues: 0,
  new_issues: 0,
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
      "issues:1",
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
      "issues:1",
      "annulée",
      "gone:4",
    ]);
  });

  it("drops the new count on a first scan, where it only echoes the total", () => {
    const first = { ...busy, inserted: 1240, updated: 0, removed: 0, missing: 0, errors: 0, issues: 0, cancelled: false };
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
    issues: 6,
    new_issues: 1,
    deferred: 1,
  };

  it("lists only the changes, never an indexed count", () => {
    expect(read(scanSummaryParts(changed, createT("en")))).toEqual([
      "12 new",
      "1 changed",
      "2 returned",
      "gone:3",
      "issues:1",
      "1 still copying",
    ]);
  });

  it("words the changes in French, with their plurals", () => {
    expect(read(scanSummaryParts(changed, createT("fr")))).toEqual([
      "12 nouvelles",
      "1 modifiée",
      "2 revenues",
      "gone:3",
      "issues:1",
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

describe("scanSummaryParts unreadable files", () => {
  const en = createT("en");
  const fr = createT("fr");

  it("shows the standing count after a blocking scan even when this pass read cleanly", () => {
    const rescan = { ...busy, errors: 0, issues: 12, cancelled: false, removed: 0, missing: 0 };
    expect(read(scanSummaryParts(rescan, en))).toEqual(["1,240 indexed", "3 new", "1 changed", "issues:12"]);
  });

  it("hides the part at zero issues, whatever the pass counter says", () => {
    const parts = read(scanSummaryParts({ ...busy, errors: 3, issues: 0 }, en));
    expect(parts.join()).not.toContain("issues");
  });

  it("shows after a session only when it found new ones", () => {
    const known = { ...quietSession, issues: 4, new_issues: 0 };
    expect(read(scanSummaryParts(known, en))).toEqual(["Up to date"]);
    const fresh = { ...quietSession, issues: 4, new_issues: 1 };
    expect(read(scanSummaryParts(fresh, en))).toEqual(["issues:1"]);
  });

  it("treats a missing new_issues as none", () => {
    const { new_issues: _drop, ...bare } = { ...quietSession, issues: 4 };
    expect(read(scanSummaryParts(bare, en))).toEqual(["Up to date"]);
  });

  it("marks the session count as new and the blocking count as the standing total", () => {
    const [blocking] = scanSummaryParts({ ...busy, issues: 12 }, en).filter((p) => p.kind === "issues");
    expect(blocking).toEqual({ kind: "issues", n: 12, fresh: false });
    const [session] = scanSummaryParts({ ...quietSession, issues: 15, new_issues: 3 }, en);
    expect(session).toEqual({ kind: "issues", n: 3, fresh: true });
  });

  it("words the new-unreadable count in both locales", () => {
    expect(en((d) => d.scan.summaryNewUnreadable, { n: 3 })).toBe("3 new unreadable");
    expect(fr((d) => d.scan.summaryNewUnreadable, { n: 1 })).toBe("1 nouveau illisible");
    expect(fr((d) => d.scan.summaryNewUnreadable, { n: 3 })).toBe("3 nouveaux illisibles");
  });

  it("words the count in both locales, singular and plural", () => {
    expect(en((d) => d.scan.summaryUnreadable, { n: 1 })).toBe("1 unreadable");
    expect(en((d) => d.scan.summaryUnreadable, { n: 5 })).toBe("5 unreadable");
    expect(fr((d) => d.scan.summaryUnreadable, { n: 1 })).toBe("1 illisible");
    expect(fr((d) => d.scan.summaryUnreadable, { n: 5 })).toBe("5 illisibles");
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
