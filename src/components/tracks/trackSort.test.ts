// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { SORT_COLUMN, activeSort, applySort } from "./trackSort";

describe("activeSort", () => {
  it("reads the field and direction from the first sort term", () => {
    expect(activeSort([{ id: SORT_COLUMN.album, desc: true }])).toEqual({
      field: "album",
      desc: true,
    });
  });

  it("returns null when unsorted", () => {
    expect(activeSort([])).toBeNull();
  });

  it("returns null when sorted on a column cards do not offer", () => {
    expect(activeSort([{ id: "filename", desc: false }])).toBeNull();
  });
});

describe("applySort", () => {
  it("builds a single sort term on the field's column", () => {
    expect(applySort("year", true)).toEqual([{ id: SORT_COLUMN.year, desc: true }]);
  });

  it("round-trips through activeSort", () => {
    expect(activeSort(applySort("artist", false))).toEqual({ field: "artist", desc: false });
  });
});
