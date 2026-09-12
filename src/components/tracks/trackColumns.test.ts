// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { collectionColumns, gridTemplate, toColumnDefs, trackColumns } from "./trackColumns";

describe("collectionColumns", () => {
  it("leads with an affordance-only gutter and no track number", () => {
    const lead = collectionColumns[0];
    expect(lead.affordance).toBe(true);
    // The lead cell carries no value, so it never reads as a real track-number column.
    expect(lead.resolve).toBeUndefined();
    expect(lead.format).toBeUndefined();
  });

  it("drops the source-file columns", () => {
    const ids = collectionColumns.map((c) => c.id);
    expect(ids).not.toContain("filename");
    expect(ids).not.toContain("ext");
  });

  it("keeps the metadata columns in reading order", () => {
    expect(collectionColumns.map((c) => c.id)).toEqual([
      "raw_track_no",
      "raw_title",
      "raw_artist",
      "raw_album",
      "raw_year",
      "duration_secs",
    ]);
  });
});

describe("gridTemplate", () => {
  it("leads with a fixed gutter and flexes the text columns", () => {
    expect(gridTemplate(collectionColumns)).toBe(
      "44px minmax(0, 2fr) minmax(0, 1.4fr) minmax(0, 1.4fr) 60px 72px",
    );
  });

  it("defaults to the file columns when none are passed", () => {
    expect(gridTemplate()).toBe(gridTemplate(trackColumns));
  });
});

describe("toColumnDefs", () => {
  it("leaves the affordance column unsortable and unsearchable", () => {
    const lead = toColumnDefs(collectionColumns)[0];
    expect(lead.enableSorting).toBe(false);
    expect(lead.enableGlobalFilter).toBe(false);
  });

  it("keeps the title sortable and searchable", () => {
    const title = toColumnDefs(collectionColumns).find((d) => d.id === "raw_title");
    expect(title?.enableSorting).toBe(true);
    expect(title?.enableGlobalFilter).toBe(true);
  });
});
