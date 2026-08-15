// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import {
  discOf,
  groupByDisc,
  layoutInOrder,
  moveManyToDisc,
  moveToDisc,
  placeAt,
  reorderOnto,
} from "./albumLayout";

// -- Type Imports --
import type { AlbumTrackRow } from "../../types";

// A bare membership row: only the fields the layout math reads carry meaning.
function row(track_id: number, disc_no: number | null, track_no: number | null): AlbumTrackRow {
  return {
    album_id: 1,
    track_id,
    source_path: `/m/${track_id}.mp3`,
    filename: `${track_id}.mp3`,
    duration_secs: null,
    track_no,
    disc_no,
    raw_title: null,
    raw_artist: null,
    title_override: null,
    artist_override: null,
    has_embedded_cover: null,
    missing_at: null,
    genre_ids: [],
  };
}

describe("discOf", () => {
  it("treats an unset disc as disc 1", () => {
    expect(discOf(row(1, null, 1))).toBe(1);
    expect(discOf(row(1, 2, 1))).toBe(2);
  });
});

describe("groupByDisc", () => {
  it("keeps a single-disc album as one group", () => {
    const groups = groupByDisc([row(1, 1, 1), row(2, 1, 2)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].disc).toBe(1);
  });

  it("folds an unset disc into disc 1", () => {
    const groups = groupByDisc([row(1, null, 1), row(2, null, 2)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].disc).toBe(1);
  });

  it("parts spanning discs into ascending groups", () => {
    const groups = groupByDisc([row(1, 1, 1), row(2, 1, 2), row(3, 2, 1)]);
    expect(groups.map((g) => g.disc)).toEqual([1, 2]);
    expect(groups[0].rows.map((r) => r.track_id)).toEqual([1, 2]);
    expect(groups[1].rows.map((r) => r.track_id)).toEqual([3]);
  });
});

describe("layoutInOrder", () => {
  it("restarts numbering per disc", () => {
    const layout = layoutInOrder([row(1, 1, 1), row(2, 1, 2), row(3, 2, 1), row(4, 2, 2)]);
    expect(layout).toEqual([
      { track_id: 1, disc_no: 1, track_no: 1 },
      { track_id: 2, disc_no: 1, track_no: 2 },
      { track_id: 3, disc_no: 2, track_no: 1 },
      { track_id: 4, disc_no: 2, track_no: 2 },
    ]);
  });

  it("preserves an unset disc while numbering it with disc 1", () => {
    const layout = layoutInOrder([row(1, null, 5), row(2, null, 9)]);
    expect(layout).toEqual([
      { track_id: 1, disc_no: null, track_no: 1 },
      { track_id: 2, disc_no: null, track_no: 2 },
    ]);
  });
});

describe("moveToDisc", () => {
  const members = [row(1, 1, 1), row(2, 1, 2), row(3, 1, 3)];

  it("moves a track to a new disc, appended and renumbered", () => {
    const layout = moveToDisc(members, 2, 2);
    expect(layout).toEqual([
      { track_id: 1, disc_no: 1, track_no: 1 },
      { track_id: 3, disc_no: 1, track_no: 2 },
      { track_id: 2, disc_no: 2, track_no: 1 },
    ]);
  });

  it("appends the moved track after the target disc's current members", () => {
    const spanning = [row(1, 1, 1), row(2, 2, 1), row(3, 2, 2)];
    const layout = moveToDisc(spanning, 1, 2);
    expect(layout).toEqual([
      { track_id: 2, disc_no: 2, track_no: 1 },
      { track_id: 3, disc_no: 2, track_no: 2 },
      { track_id: 1, disc_no: 2, track_no: 3 },
    ]);
  });

  it("sends a null disc to disc 1 while clearing the stored disc", () => {
    const spanning = [row(1, 1, 1), row(2, 2, 1)];
    const layout = moveToDisc(spanning, 2, null);
    expect(layout).toEqual([
      { track_id: 1, disc_no: 1, track_no: 1 },
      { track_id: 2, disc_no: null, track_no: 2 },
    ]);
  });

  it("leaves the layout numbered when the track is unknown", () => {
    const layout = moveToDisc(members, 99, 2);
    expect(layout).toEqual([
      { track_id: 1, disc_no: 1, track_no: 1 },
      { track_id: 2, disc_no: 1, track_no: 2 },
      { track_id: 3, disc_no: 1, track_no: 3 },
    ]);
  });
});

describe("moveManyToDisc", () => {
  it("moves a subset to another disc, renumbering both discs", () => {
    const spanning = [row(1, 1, 1), row(2, 1, 2), row(3, 1, 3), row(4, 1, 4), row(5, 2, 1)];
    const layout = moveManyToDisc(spanning, [1, 3], 2);
    expect(layout).toEqual([
      { track_id: 2, disc_no: 1, track_no: 1 },
      { track_id: 4, disc_no: 1, track_no: 2 },
      { track_id: 5, disc_no: 2, track_no: 1 },
      { track_id: 1, disc_no: 2, track_no: 2 },
      { track_id: 3, disc_no: 2, track_no: 3 },
    ]);
  });

  it("moves a subset onto a brand-new disc", () => {
    const single = [row(1, 1, 1), row(2, 1, 2), row(3, 1, 3)];
    const layout = moveManyToDisc(single, [2, 3], 2);
    expect(layout).toEqual([
      { track_id: 1, disc_no: 1, track_no: 1 },
      { track_id: 2, disc_no: 2, track_no: 1 },
      { track_id: 3, disc_no: 2, track_no: 2 },
    ]);
  });

  it("preserves the movers' relative order regardless of the id list order", () => {
    const four = [row(1, 1, 1), row(2, 1, 2), row(3, 1, 3), row(4, 1, 4)];
    const layout = moveManyToDisc(four, [3, 1], 2);
    expect(layout).toEqual([
      { track_id: 2, disc_no: 1, track_no: 1 },
      { track_id: 4, disc_no: 1, track_no: 2 },
      { track_id: 1, disc_no: 2, track_no: 1 },
      { track_id: 3, disc_no: 2, track_no: 2 },
    ]);
  });

  it("splits a single-disc album when a subset moves to disc 2", () => {
    const single = [row(1, 1, 1), row(2, 1, 2), row(3, 1, 3), row(4, 1, 4)];
    const layout = moveManyToDisc(single, [2, 4], 2);
    expect(layout).toEqual([
      { track_id: 1, disc_no: 1, track_no: 1 },
      { track_id: 3, disc_no: 1, track_no: 2 },
      { track_id: 2, disc_no: 2, track_no: 1 },
      { track_id: 4, disc_no: 2, track_no: 2 },
    ]);
  });

  it("is stable when a mover already sits on the target disc", () => {
    const spanning = [row(1, 1, 1), row(2, 2, 1), row(3, 2, 2)];
    const layout = moveManyToDisc(spanning, [1, 2], 2);
    expect(layout).toEqual([
      { track_id: 3, disc_no: 2, track_no: 1 },
      { track_id: 1, disc_no: 2, track_no: 2 },
      { track_id: 2, disc_no: 2, track_no: 3 },
    ]);
  });

  it("leaves the layout numbered when none of the ids are members", () => {
    const single = [row(1, 1, 1), row(2, 1, 2)];
    const layout = moveManyToDisc(single, [98, 99], 2);
    expect(layout).toEqual([
      { track_id: 1, disc_no: 1, track_no: 1 },
      { track_id: 2, disc_no: 1, track_no: 2 },
    ]);
  });
});

describe("placeAt", () => {
  it("reorders within a disc without stamping the members' stored disc", () => {
    const layout = placeAt([row(1, null, 1), row(2, null, 2), row(3, null, 3)], 3, 1, 0);
    expect(layout).toEqual([
      { track_id: 3, disc_no: null, track_no: 1 },
      { track_id: 1, disc_no: null, track_no: 2 },
      { track_id: 2, disc_no: null, track_no: 3 },
    ]);
  });

  it("inserts at the given index within the target disc", () => {
    const layout = placeAt([row(1, 1, 1), row(2, 1, 2), row(3, 1, 3)], 1, 1, 2);
    expect(layout).toEqual([
      { track_id: 2, disc_no: 1, track_no: 1 },
      { track_id: 3, disc_no: 1, track_no: 2 },
      { track_id: 1, disc_no: 1, track_no: 3 },
    ]);
  });

  it("moves a track across discs, stamping the target disc at the wanted slot", () => {
    const spanning = [row(1, 1, 1), row(2, 1, 2), row(3, 2, 1), row(4, 2, 2)];
    const layout = placeAt(spanning, 1, 2, 1);
    expect(layout).toEqual([
      { track_id: 2, disc_no: 1, track_no: 1 },
      { track_id: 3, disc_no: 2, track_no: 1 },
      { track_id: 1, disc_no: 2, track_no: 2 },
      { track_id: 4, disc_no: 2, track_no: 3 },
    ]);
  });

  it("seeds an empty disc when a track drops into it first", () => {
    const single = [row(1, 1, 1), row(2, 1, 2), row(3, 1, 3)];
    const layout = placeAt(single, 2, 2, 0);
    expect(layout).toEqual([
      { track_id: 1, disc_no: 1, track_no: 1 },
      { track_id: 3, disc_no: 1, track_no: 2 },
      { track_id: 2, disc_no: 2, track_no: 1 },
    ]);
  });

  it("clamps an index past the target disc's run to the end", () => {
    const layout = placeAt([row(1, 1, 1), row(2, 1, 2)], 1, 1, 9);
    expect(layout).toEqual([
      { track_id: 2, disc_no: 1, track_no: 1 },
      { track_id: 1, disc_no: 1, track_no: 2 },
    ]);
  });

  it("leaves the layout numbered when the track is unknown", () => {
    const layout = placeAt([row(1, 1, 1), row(2, 1, 2)], 99, 2, 0);
    expect(layout).toEqual([
      { track_id: 1, disc_no: 1, track_no: 1 },
      { track_id: 2, disc_no: 1, track_no: 2 },
    ]);
  });
});

describe("reorderOnto", () => {
  const four = [row(1, 1, 1), row(2, 1, 2), row(3, 1, 3), row(4, 1, 4)];

  // The regression: dragging a track UP onto an earlier row must land it exactly there, not one below.
  it("drops an upward move onto the target row, not one past it", () => {
    expect(reorderOnto(four, 3, 1).map((p) => p.track_id)).toEqual([3, 1, 2, 4]);
  });

  it("drops an upward move into the middle exactly before the target", () => {
    expect(reorderOnto(four, 4, 2).map((p) => p.track_id)).toEqual([1, 4, 2, 3]);
  });

  it("drops a downward move after the target row", () => {
    expect(reorderOnto(four, 1, 3).map((p) => p.track_id)).toEqual([2, 3, 1, 4]);
  });

  it("moving a row onto its own neighbour swaps the two", () => {
    expect(reorderOnto(four, 1, 2).map((p) => p.track_id)).toEqual([2, 1, 3, 4]);
    expect(reorderOnto(four, 2, 1).map((p) => p.track_id)).toEqual([2, 1, 3, 4]);
  });

  it("a downward cross-disc drop joins the target disc after the over row", () => {
    const spanning = [row(1, 1, 1), row(2, 1, 2), row(3, 2, 1), row(4, 2, 2)];
    expect(reorderOnto(spanning, 1, 4)).toEqual([
      { track_id: 2, disc_no: 1, track_no: 1 },
      { track_id: 3, disc_no: 2, track_no: 1 },
      { track_id: 4, disc_no: 2, track_no: 2 },
      { track_id: 1, disc_no: 2, track_no: 3 },
    ]);
  });

  it("an upward cross-disc drop joins the target disc before the over row", () => {
    const spanning = [row(1, 1, 1), row(2, 1, 2), row(3, 2, 1), row(4, 2, 2)];
    expect(reorderOnto(spanning, 4, 1)).toEqual([
      { track_id: 4, disc_no: 1, track_no: 1 },
      { track_id: 1, disc_no: 1, track_no: 2 },
      { track_id: 2, disc_no: 1, track_no: 3 },
      { track_id: 3, disc_no: 2, track_no: 1 },
    ]);
  });

  it("leaves the layout numbered when a row is unknown", () => {
    expect(reorderOnto(four, 99, 1).map((p) => p.track_id)).toEqual([1, 2, 3, 4]);
  });
});
