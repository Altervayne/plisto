// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { browseMenuSlots } from "./browseMenu";

describe("browseMenuSlots", () => {
  it("offers every entry when both the player and organizing are on", () => {
    expect(browseMenuSlots({ player: true, organize: true })).toEqual([
      "play",
      "next",
      "queue",
      null,
      "playlist",
      null,
      "open",
      "select",
    ]);
  });

  it("drops the play group and its separator in Organizer mode", () => {
    expect(browseMenuSlots({ player: false, organize: true })).toEqual([
      "playlist",
      null,
      "open",
      "select",
    ]);
  });

  it("drops Select in Player mode", () => {
    expect(browseMenuSlots({ player: true, organize: false })).toEqual([
      "play",
      "next",
      "queue",
      null,
      "playlist",
      null,
      "open",
    ]);
  });
});
