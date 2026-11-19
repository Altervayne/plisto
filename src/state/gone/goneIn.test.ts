// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { goneCountIn } from "./goneIn";
import { groupGone } from "./goneGroups";

// -- Type Imports --
import type { Root, TrackRow } from "../../types";

let nextId = 1;
const track = (path: string): TrackRow =>
  ({ id: nextId++, source_path: path, filename: "x.mp3", missing_at: 5 }) as TrackRow;
const root = (id: number, path: string): Root => ({ id, path, track_count: 10, missing_count: 3 });

describe("goneCountIn", () => {
  const online = [track("/m/a.mp3"), track("/m/b.mp3")];
  const away = [track("/e/x.mp3"), track("/e/y.mp3"), track("/e/z.mp3")];
  const result = groupGone([...online, ...away], [root(1, "/m"), root(2, "/e")], [2], { kind: "all" }, []);

  it("counts only the tracks the sheet lists, never those on an offline root", () => {
    expect(goneCountIn(result, away.map((t) => t.id))).toBe(0);
    expect(goneCountIn(result, online.map((t) => t.id))).toBe(2);
    expect(goneCountIn(result, [...online, ...away].map((t) => t.id))).toBe(2);
  });

  it("is zero while no grouping exists", () => {
    expect(goneCountIn(null, [1, 2])).toBe(0);
  });
});
