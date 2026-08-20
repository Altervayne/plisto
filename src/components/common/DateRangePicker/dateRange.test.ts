// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { dayEnd, dayStart, monthGrid, presetLast, presetThisYear } from "./dateRange";

describe("dayStart / dayEnd", () => {
  it("spans one day less a second between the two bounds", () => {
    const day = new Date(2021, 5, 15, 10, 30, 0);
    expect(dayEnd(day) - dayStart(day)).toBe(86399);
  });

  it("reads the same bound for any moment in the day", () => {
    const morning = new Date(2021, 5, 15, 0, 1, 0);
    const evening = new Date(2021, 5, 15, 22, 45, 0);
    expect(dayStart(morning)).toBe(dayStart(evening));
  });
});

describe("monthGrid", () => {
  it("lays out a full six-week grid", () => {
    expect(monthGrid(2021, 1)).toHaveLength(42);
  });

  it("aligns every column to its weekday, Sunday first", () => {
    monthGrid(2021, 1).forEach((cell, index) => {
      expect(cell.getDay()).toBe(index % 7);
    });
  });

  it("leads February with the trailing Sunday of January", () => {
    const cells = monthGrid(2021, 1);
    expect(cells[0].getDay()).toBe(0);
    expect(cells[0].getMonth()).toBe(0);
    expect(cells[0].getDate()).toBe(31);
    expect(cells[6].getDate()).toBe(6);
  });

  it("starts on the first when the month opens on a Sunday", () => {
    const cells = monthGrid(2021, 7);
    expect(cells[0].getMonth()).toBe(7);
    expect(cells[0].getDate()).toBe(1);
    expect(cells[0].getDay()).toBe(0);
  });
});

describe("presetLast", () => {
  it("runs from N days back at 00:00 to the day at 23:59, inclusive", () => {
    const now = new Date(2021, 5, 15, 10, 30, 0);
    const range = presetLast(now, 7);
    expect(range.from).toBe(dayStart(new Date(2021, 5, 8)));
    expect(range.to).toBe(dayEnd(new Date(2021, 5, 15)));
    expect((range.to as number) - (range.from as number)).toBe(7 * 86400 + 86399);
  });
});

describe("presetThisYear", () => {
  it("runs from January 1 to the day at 23:59", () => {
    const now = new Date(2021, 5, 15, 10, 30, 0);
    const range = presetThisYear(now);
    expect(range.from).toBe(dayStart(new Date(2021, 0, 1)));
    expect(range.to).toBe(dayEnd(new Date(2021, 5, 15)));
  });
});
