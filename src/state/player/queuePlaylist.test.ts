import { describe, expect, it } from "vitest";

import { queuePlaylistName, queuePlaylistTrackIds } from "./queuePlaylist";

describe("queuePlaylistTrackIds", () => {
  it("keeps play order and repeats", () => {
    expect(queuePlaylistTrackIds([5, 2, 9, 2])).toEqual([5, 2, 9, 2]);
  });

  it("drops ad-hoc negative ids", () => {
    expect(queuePlaylistTrackIds([5, -1, 9, -2])).toEqual([5, 9]);
  });

  it("is empty for an all ad-hoc or empty queue", () => {
    expect(queuePlaylistTrackIds([-1, -2])).toEqual([]);
    expect(queuePlaylistTrackIds([])).toEqual([]);
  });
});

describe("queuePlaylistName", () => {
  it("appends the zero-padded local date", () => {
    expect(queuePlaylistName("Queue", new Date(2026, 0, 5))).toBe("Queue 2026-01-05");
    expect(queuePlaylistName("File", new Date(2026, 10, 25))).toBe("File 2026-11-25");
  });
});
