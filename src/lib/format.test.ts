// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { dayKey, formatClockTime, formatRelativeTime, sameCalendarDay } from "./format";

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
