// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { matchStemPairs, stemOf } from "./matchCovers";

const track = (id: number, filename: string) => ({ id, filename });

describe("stemOf", () => {
  it("strips the final extension, folds case, and trims surrounding space", () => {
    expect(stemOf("01 - Song.MP3")).toBe("01 - song");
    expect(stemOf("  Cover.JPG  ")).toBe("cover");
  });

  it("reads the basename out of a full path, either separator", () => {
    expect(stemOf("F:\\Music\\Album\\01 - Song.jpg")).toBe("01 - song");
    expect(stemOf("/music/album/01 - Song.jpg")).toBe("01 - song");
  });

  it("keeps a dotless name whole", () => {
    expect(stemOf("Song")).toBe("song");
  });
});

describe("matchStemPairs", () => {
  it("pairs a track with the image sharing its stem", () => {
    const matches = matchStemPairs(["/m/a/01 - Song.jpg"], [track(1, "01 - Song.mp3")]);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      trackId: 1,
      imagePath: "/m/a/01 - Song.jpg",
      imageName: "01 - Song.jpg",
    });
  });

  it("matches across case", () => {
    const matches = matchStemPairs(["/m/a/01 - SONG.JPG"], [track(1, "01 - song.mp3")]);
    expect(matches.map((m) => m.trackId)).toEqual([1]);
  });

  it("skips a track with no matching image", () => {
    const matches = matchStemPairs(["/m/a/cover.jpg"], [track(1, "01 - Song.mp3")]);
    expect(matches).toEqual([]);
  });

  it("binds one image when several extensions share a track's stem, sorted order first", () => {
    const matches = matchStemPairs(
      ["/m/a/Song.png", "/m/a/Song.jpg"],
      [track(1, "Song.flac")],
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].imagePath).toBe("/m/a/Song.jpg");
  });

  it("ignores an image that matches no track", () => {
    const matches = matchStemPairs(
      ["/m/a/01 - Song.jpg", "/m/a/folder.jpg"],
      [track(1, "01 - Song.mp3")],
    );
    expect(matches.map((m) => m.imageName)).toEqual(["01 - Song.jpg"]);
  });

  it("gives one image to at most one track", () => {
    const matches = matchStemPairs(
      ["/m/a/Song.jpg"],
      [track(1, "Song.mp3"), track(2, "Song.m4a")],
    );
    expect(matches.map((m) => m.trackId)).toEqual([1]);
  });
});
