// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import {
  dayKey,
  formatClockTime,
  formatRelativeTime,
  formatShortDate,
  relativeAge,
  sameCalendarDay,
} from "./format";

// A local wall-clock stamp built from its own components, so the round-trip through the local-zone
// readers holds whatever zone the test runner sits in. Month is 0-indexed, matching Date.
const localStamp = (y: number, mo: number, d: number, h: number, mi: number) =>
  Math.floor(new Date(y, mo, d, h, mi).getTime() / 1000);

// A fixed clock so each age reads against a known now, and the stamp is now minus the elapsed seconds.
const NOW_MS = 1_700_000_000_000;
const at = (secondsAgo: number) => Math.floor(NOW_MS / 1000) - secondsAgo;

describe("formatRelativeTime", () => {
  it("reads a fresh stamp as just now", () => {
    expect(formatRelativeTime(at(10), NOW_MS)).toBe("just now");
  });

  it("clamps a future stamp to just now", () => {
    expect(formatRelativeTime(at(-500), NOW_MS)).toBe("just now");
  });

  it("counts minutes and hours", () => {
    expect(formatRelativeTime(at(5 * 60), NOW_MS)).toBe("5m ago");
    expect(formatRelativeTime(at(2 * 3600), NOW_MS)).toBe("2h ago");
  });

  it("names a day-old stamp yesterday", () => {
    expect(formatRelativeTime(at(30 * 3600), NOW_MS)).toBe("yesterday");
  });

  it("steps up through days, weeks, months, and years", () => {
    expect(formatRelativeTime(at(3 * 86400), NOW_MS)).toBe("3d ago");
    expect(formatRelativeTime(at(14 * 86400), NOW_MS)).toBe("2w ago");
    expect(formatRelativeTime(at(4 * 2592000), NOW_MS)).toBe("4mo ago");
    expect(formatRelativeTime(at(31536000), NOW_MS)).toBe("1y ago");
  });
});

describe("relativeAge", () => {
  const ago = (seconds: number) => NOW_MS - seconds * 1000;

  it("reads under a minute, or a future instant, as now", () => {
    expect(relativeAge(ago(59), NOW_MS)).toEqual({ unit: "now" });
    expect(relativeAge(ago(-30), NOW_MS)).toEqual({ unit: "now" });
  });

  it("floors to whole minutes, hours, and days", () => {
    expect(relativeAge(ago(60), NOW_MS)).toEqual({ unit: "minutes", n: 1 });
    expect(relativeAge(ago(5 * 60 + 59), NOW_MS)).toEqual({ unit: "minutes", n: 5 });
    expect(relativeAge(ago(3600), NOW_MS)).toEqual({ unit: "hours", n: 1 });
    expect(relativeAge(ago(23 * 3600 + 3599), NOW_MS)).toEqual({ unit: "hours", n: 23 });
    expect(relativeAge(ago(2 * 86400), NOW_MS)).toEqual({ unit: "days", n: 2 });
  });
});

describe("formatClockTime", () => {
  it("reads the local time of day, 24h and zero-padded", () => {
    expect(formatClockTime(localStamp(2024, 8, 9, 14, 32))).toBe("14:32");
    expect(formatClockTime(localStamp(2024, 8, 9, 9, 5))).toBe("09:05");
    expect(formatClockTime(localStamp(2024, 8, 9, 0, 0))).toBe("00:00");
  });
});

describe("day bucketing", () => {
  it("keys a stamp by its local calendar day", () => {
    expect(dayKey(localStamp(2024, 8, 9, 0, 1))).toBe("2024-09-09");
    expect(dayKey(localStamp(2024, 0, 3, 23, 59))).toBe("2024-01-03");
  });

  it("buckets any time on a day together and parts the next day", () => {
    const morning = localStamp(2024, 8, 9, 0, 1);
    const night = localStamp(2024, 8, 9, 23, 59);
    const nextDay = localStamp(2024, 8, 10, 0, 1);
    expect(sameCalendarDay(morning, night)).toBe(true);
    expect(sameCalendarDay(night, nextDay)).toBe(false);
  });
});

describe("formatShortDate", () => {
  const now = new Date(2026, 8, 29, 12, 0).getTime();

  it("drops the year within the current year", () => {
    const stamp = localStamp(2026, 8, 12, 14, 32);
    expect(formatShortDate(stamp, "en", now)).toMatch(/^12 Sept?$/);
    expect(formatShortDate(stamp, "fr", now)).toBe("12 sept.");
  });

  it("keeps the year for an earlier year", () => {
    const stamp = localStamp(2025, 11, 3, 9, 0);
    expect(formatShortDate(stamp, "en", now)).toBe("3 Dec 2025");
    expect(formatShortDate(stamp, "fr", now)).toBe("3 déc. 2025");
  });

  it("never shows a time", () => {
    expect(formatShortDate(localStamp(2026, 0, 5, 23, 59), "en", now)).not.toMatch(/\d:\d/);
  });
});
