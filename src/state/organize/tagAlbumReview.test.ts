// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import {
  buildPlans,
  defaultChecked,
  defaultChoice,
  needsLook,
  planCounts,
  visibleNotes,
} from "./tagAlbumReview";

// -- Type Imports --
import type { AlbumRow, TrackRow } from "../../types";
import type { ProposalMatch, TagAlbumProposal } from "./groupByAlbumTags";

// A proposal over the given track ids with no notes, no warnings and no matches unless set.
function proposal(key: string, ids: number[], over: Partial<TagAlbumProposal> = {}): TagAlbumProposal {
  return {
    key,
    tracks: ids.map((id) => ({ id }) as TrackRow),
    title: key,
    fields: { title: key, album_artist: null, year: null, genre: null },
    discCount: 1,
    missingCount: 0,
    matches: [],
    notes: [],
    warnings: [],
    ...over,
  };
}

function match(id: number, collides = false): ProposalMatch {
  return { album: { id, kind: "album" } as AlbumRow, collides };
}

describe("defaults", () => {
  it("files a clean proposal as a new album, checked", () => {
    const p = proposal("a", [1, 2]);
    expect(defaultChoice(p)).toEqual({ kind: "new" });
    expect(defaultChecked(p)).toBe(true);
    expect(needsLook(p)).toBe(false);
  });

  it("targets a single match and unchecks it when its numbering clashes", () => {
    expect(defaultChoice(proposal("a", [1], { matches: [match(7)] }))).toEqual({
      kind: "existing",
      albumId: 7,
    });
    const clash = proposal("a", [1], { matches: [match(7, true)] });
    expect(defaultChecked(clash)).toBe(false);
    expect(needsLook(clash)).toBe(true);
  });

  it("waits for a pick among several matches", () => {
    const p = proposal("a", [1], { matches: [match(7), match(8)] });
    expect(defaultChoice(p)).toEqual({ kind: "unset" });
    expect(defaultChecked(p)).toBe(false);
    expect(needsLook(p)).toBe(true);
  });

  it("unchecks a proposal with a check-first warning", () => {
    expect(defaultChecked(proposal("a", [1, 2], { warnings: [{ kind: "folders" }] }))).toBe(false);
  });
});

describe("visibleNotes", () => {
  it("drops the gap note on an existing target only, leaving needs-a-look alone", () => {
    const p = proposal("a", [1], {
      matches: [match(7)],
      notes: [{ kind: "gap" }, { kind: "genres" }],
    });
    expect(visibleNotes(p, { kind: "existing", albumId: 7 })).toEqual([{ kind: "genres" }]);
    expect(visibleNotes(p, { kind: "new" })).toEqual(p.notes);
    expect(needsLook(p)).toBe(false);
    expect(defaultChecked(p)).toBe(true);
  });
});

describe("buildPlans", () => {
  it("sends checked, resolved proposals in order with their targets", () => {
    const proposals = [
      proposal("a", [1, 2]),
      proposal("b", [3], { matches: [match(7)] }),
      proposal("c", [4], { matches: [match(8), match(9)] }),
      proposal("d", [5, 6]),
    ];
    const checked = new Set(["a", "b", "c"]);
    const plans = buildPlans(proposals, checked, new Map());
    expect(plans).toEqual([
      { track_ids: [1, 2], target: { kind: "new", fields: proposals[0].fields } },
      { track_ids: [3], target: { kind: "existing", album_id: 7 } },
    ]);
    expect(planCounts(plans)).toEqual({ created: 1, extended: 1 });
  });

  it("honours a chosen target over the default", () => {
    const proposals = [proposal("c", [4], { matches: [match(8), match(9)] })];
    const choices = new Map([["c", { kind: "existing" as const, albumId: 9 }]]);
    expect(buildPlans(proposals, new Set(["c"]), choices)).toEqual([
      { track_ids: [4], target: { kind: "existing", album_id: 9 } },
    ]);
  });
});
