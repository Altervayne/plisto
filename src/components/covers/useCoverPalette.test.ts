// -- Test Imports --
import { afterEach, describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { cachedPalette, invalidateTrackPalette, rememberPalette } from "./useCoverPalette";

vi.mock("../../lib/ipc", () => ({ getCoverPalette: vi.fn() }));

const palette: [number, number, number][] = [[1, 2, 3]];

afterEach(() => invalidateTrackPalette(-41));

describe("palette cache revisions", () => {
  it("answers a read at the same revision without a refetch", () => {
    rememberPalette(-41, 0, null);
    expect(cachedPalette(-41, 0)).toBeNull();
  });

  it("misses at a newer revision, so the palette is derived again", () => {
    rememberPalette(-41, 0, null);
    expect(cachedPalette(-41, 1)).toBeUndefined();
    rememberPalette(-41, 1, palette);
    expect(cachedPalette(-41, 1)).toBe(palette);
    expect(cachedPalette(-41, 0)).toBeUndefined();
  });

  it("drops every revision on invalidate", () => {
    rememberPalette(-41, 2, palette);
    invalidateTrackPalette(-41);
    expect(cachedPalette(-41, 2)).toBeUndefined();
  });
});
