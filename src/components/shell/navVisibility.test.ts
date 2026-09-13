// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import {
  NAV_SECTIONS,
  firstVisibleDestination,
  isDestinationVisible,
  isSectionVisible,
} from "./navVisibility";
import type { Mode } from "./navVisibility";

const ALL: readonly Mode[] = [
  ...NAV_SECTIONS.files,
  ...NAV_SECTIONS.library,
  ...NAV_SECTIONS.utilities,
  "settings",
];

function visible(appMode: Parameters<typeof isDestinationVisible>[0]): Mode[] {
  return ALL.filter((dest) => isDestinationVisible(appMode, dest));
}

describe("isDestinationVisible", () => {
  it("shows every destination in both mode", () => {
    expect(visible("both")).toEqual(ALL);
  });

  it("hides the files and utility surfaces in player mode", () => {
    for (const dest of ["files", "unsorted", "covers", "editor", "export"] as Mode[]) {
      expect(isDestinationVisible("player", dest)).toBe(false);
    }
    for (const dest of ["tracks", "albums", "singles", "playlists", "player"] as Mode[]) {
      expect(isDestinationVisible("player", dest)).toBe(true);
    }
  });

  it("hides the player and its history in organizer mode, keeping all-tracks", () => {
    for (const dest of ["player", "history"] as Mode[]) {
      expect(isDestinationVisible("organizer", dest)).toBe(false);
    }
    for (const dest of [
      "files",
      "unsorted",
      "covers",
      "tracks",
      "albums",
      "singles",
      "playlists",
      "editor",
      "export",
    ] as Mode[]) {
      expect(isDestinationVisible("organizer", dest)).toBe(true);
    }
  });

  it("keeps settings visible in every mode", () => {
    expect(isDestinationVisible("both", "settings")).toBe(true);
    expect(isDestinationVisible("player", "settings")).toBe(true);
    expect(isDestinationVisible("organizer", "settings")).toBe(true);
  });
});

describe("isSectionVisible", () => {
  it("shows all sections in both mode", () => {
    expect(isSectionVisible("both", NAV_SECTIONS.files)).toBe(true);
    expect(isSectionVisible("both", NAV_SECTIONS.library)).toBe(true);
    expect(isSectionVisible("both", NAV_SECTIONS.utilities)).toBe(true);
  });

  it("drops the files and utilities sections in player mode, keeping library", () => {
    expect(isSectionVisible("player", NAV_SECTIONS.files)).toBe(false);
    expect(isSectionVisible("player", NAV_SECTIONS.utilities)).toBe(false);
    expect(isSectionVisible("player", NAV_SECTIONS.library)).toBe(true);
  });

  it("keeps every section in organizer mode, since each has a surviving item", () => {
    expect(isSectionVisible("organizer", NAV_SECTIONS.files)).toBe(true);
    expect(isSectionVisible("organizer", NAV_SECTIONS.library)).toBe(true);
    expect(isSectionVisible("organizer", NAV_SECTIONS.utilities)).toBe(true);
  });
});

describe("firstVisibleDestination", () => {
  it("lands on files in both mode", () => {
    expect(firstVisibleDestination("both")).toBe("files");
  });

  it("lands on tracks in player mode", () => {
    expect(firstVisibleDestination("player")).toBe("tracks");
  });

  it("lands on files in organizer mode", () => {
    expect(firstVisibleDestination("organizer")).toBe("files");
  });
});
