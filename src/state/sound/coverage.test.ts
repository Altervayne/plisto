import { describe, expect, it } from "vitest";

import { createT } from "../../i18n";
import { deriveCoverageState, measuringProgress } from "./coverageState";
import { coverageText } from "./coverageText";
import type { LoudnessCoverage } from "../../types";

const cov = (over: Partial<LoudnessCoverage>): LoudnessCoverage => ({
  total: 100,
  tagged: 0,
  measured: 0,
  unmeasurable: 0,
  pending: 0,
  ...over,
});

describe("deriveCoverageState", () => {
  it("is off whenever levelling is off", () => {
    expect(deriveCoverageState(false, true, cov({ pending: 5 }))).toBe("off");
    expect(deriveCoverageState(false, false, null)).toBe("off");
  });

  it("is loading until coverage arrives", () => {
    expect(deriveCoverageState(true, false, null)).toBe("loading");
  });

  it("is empty with no tracks", () => {
    expect(deriveCoverageState(true, false, cov({ total: 0 }))).toBe("empty");
  });

  it("measures while pending, and pauses during a scan", () => {
    const c = cov({ pending: 40, measured: 60 });
    expect(deriveCoverageState(true, false, c)).toBe("measuring");
    expect(deriveCoverageState(true, true, c)).toBe("paused");
  });

  it("is nothing-to-measure when tags covered everything", () => {
    expect(deriveCoverageState(true, false, cov({ tagged: 100 }))).toBe("nothingToMeasure");
  });

  it("is complete once nothing is pending and the worker did some work", () => {
    expect(deriveCoverageState(true, false, cov({ tagged: 90, measured: 7, unmeasurable: 3 }))).toBe(
      "complete",
    );
    expect(deriveCoverageState(true, true, cov({ tagged: 50, unmeasurable: 50 }))).toBe("complete");
  });
});

describe("measuringProgress", () => {
  it("counts done against done plus pending", () => {
    expect(measuringProgress(cov({ measured: 1204, pending: 2208 }))).toEqual({ done: 1204, of: 3412 });
  });
});

describe("coverageText", () => {
  const t = createT("en");
  const text = (c: LoudnessCoverage | null, on = true, scanning = false) =>
    coverageText(deriveCoverageState(on, scanning, c), c, t);

  it("says nothing when off or loading", () => {
    expect(text(cov({ pending: 3 }), false)).toEqual({ status: null, progress: null, note: null });
    expect(text(null)).toEqual({ status: null, progress: null, note: null });
  });

  it("shows the pending count and the progress while measuring", () => {
    const r = text(cov({ total: 5000, measured: 1204, pending: 2208, tagged: 1588 }));
    expect(r.status).toBe("2,208 tracks have no gain data yet.");
    expect(r.progress?.text).toBe("Measuring loudness: 1,204 of 3,412");
    expect(r.progress?.fraction).toBeCloseTo(1204 / 3412);
    expect(r.note).toBeNull();
  });

  it("adds the scan pause wording when paused", () => {
    const r = text(cov({ measured: 2640, pending: 772 }), true, true);
    expect(r.progress?.text).toContain("Paused while Plisto scans your folders");
  });

  it("singularizes one pending track", () => {
    expect(text(cov({ pending: 1, measured: 9 })).status).toBe("1 track has no gain data yet.");
  });

  it("notes unreadable tracks when complete", () => {
    const r = text(cov({ total: 9870, tagged: 5000, measured: 4744, unmeasurable: 126 }));
    expect(r.status).toBe("9,744 tracks have gain data.");
    expect(r.note).toBe("126 tracks are silent or unreadable and play at their own volume.");
  });

  it("says all tracks and no note when complete without unreadable ones", () => {
    const r = text(cov({ total: 100, tagged: 40, measured: 60 }));
    expect(r.status).toBe("All 100 tracks have gain data.");
    expect(r.note).toBeNull();
  });

  it("explains an all-tagged library", () => {
    const r = text(cov({ total: 9870, tagged: 9870 }));
    expect(r.status).toBe("All 9,870 tracks have gain data.");
    expect(r.note).toContain("nothing to measure");
  });

  it("points at adding a folder when empty", () => {
    const r = text(cov({ total: 0 }));
    expect(r.status).toBe("No tracks yet.");
    expect(r.note).toContain("add a music folder");
  });

  it("formats numbers for the French locale", () => {
    const fr = coverageText("measuring", cov({ measured: 1204, pending: 2208 }), createT("fr"));
    expect(fr.progress?.text.replace(/\s/g, " ")).toBe("Mesure du volume : 1 204 sur 3 412");
  });
});
