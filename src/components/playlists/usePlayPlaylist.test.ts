// -- Test Imports --
import { describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { playbackOf } from "./usePlayPlaylist";
import { expandPlaylist, groupMembers } from "./playlistExpand";
import { entryRow, memberRow, slotRow } from "./playlistTestRows";
import { trackCountOf } from "../../state/playlists/expansion";

// -- Type Imports --
import type { PlaybackSource } from "../../types";

vi.mock("../../state/playlists/store", () => ({}));
vi.mock("../../state/player/store", () => ({}));
vi.mock("../../i18n", () => ({ useT: () => () => "" }));

const source: PlaybackSource = { kind: "playlist", id: 1, label: "P" };
const actions = () => ({ play: vi.fn(), playNext: vi.fn(), addToQueue: vi.fn() });

const slots = [slotRow(1, 1, 9)];
const entries = [entryRow(2, 2, 5, true)];
const members = groupMembers([memberRow(5, 50, 1, 1), memberRow(5, 51, 1, 2)]);

describe("playbackOf", () => {
  it("is not playable and sends nothing while the album projection is loading", () => {
    const a = actions();
    const loading = expandPlaylist(slots, entries, members, { orgReady: false });
    const playback = playbackOf(loading, a, source);
    expect(playback.playable).toBe(false);
    playback.play();
    playback.playNext();
    playback.addToQueue();
    expect(a.play).not.toHaveBeenCalled();
    expect(a.playNext).not.toHaveBeenCalled();
    expect(a.addToQueue).not.toHaveBeenCalled();
  });

  it("plays the expanded ids with the block once ready", () => {
    const a = actions();
    const ready = expandPlaylist(slots, entries, members, { orgReady: true });
    const playback = playbackOf(ready, a, source);
    expect(playback.playable).toBe(true);
    playback.play();
    playback.playNext();
    playback.addToQueue();
    expect(a.play).toHaveBeenCalledWith([9, 50, 51], 0, source, [[1, 2]]);
    expect(a.playNext).toHaveBeenCalledWith([9, 50, 51], source, [[1, 2]]);
    expect(a.addToQueue).toHaveBeenCalledWith([9, 50, 51], source, [[1, 2]]);
  });
});

describe("trackCountOf", () => {
  it("holds the loaded count, never 0, while not ready", () => {
    const loading = expandPlaylist(slots, entries, members, { orgReady: false });
    expect(trackCountOf(loading, 7)).toBe(7);
  });

  it("derives the count once ready", () => {
    const ready = expandPlaylist(slots, entries, members, { orgReady: true });
    expect(trackCountOf(ready, 7)).toBe(3);
  });
});
