// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import {
  formatTimecode,
  parentDir,
  parseTimecode,
  projectFilename,
  snapFrame,
  spliceFormat,
} from "./splice";

describe("projectFilename", () => {
  it("fills the tokens and zero-pads the track number to two digits", () => {
    const name = projectFilename("{track_no} - {title}", { title: "Golden", track_no: 3 }, 0, "mp3");
    expect(name).toBe("03 - Golden.mp3");
  });

  it("numbers from the 1-based index when the segment carries no track number", () => {
    const name = projectFilename("{track_no} - {title}", { title: "Two" }, 1, "wav");
    expect(name).toBe("02 - Two.wav");
  });

  it("falls back to Track N when the stem comes out empty", () => {
    const name = projectFilename("{title}", {}, 4, "flac");
    expect(name).toBe("Track 5.flac");
  });

  it("strips characters Windows forbids in a filename", () => {
    const name = projectFilename("{title}", { title: 'a/b:c*d?' }, 0, "mp3");
    expect(name).toBe("abcd.mp3");
  });

  it("fills the artist token", () => {
    const name = projectFilename("{artist} - {title}", { artist: "Nils", title: "Says" }, 0, "flac");
    expect(name).toBe("Nils - Says.flac");
  });
});

describe("snapFrame", () => {
  it("leaves WAV frames sample-accurate", () => {
    expect(snapFrame(44_101, "wav", 44_100)).toBe(44_101);
  });

  it("leaves FLAC frames as requested (the backend aligns to real blocks)", () => {
    expect(snapFrame(44_101, "flac", 44_100)).toBe(44_101);
  });

  it("snaps MP3 frames to the 1152-sample grid at 44.1 kHz", () => {
    // 5000 / 1152 = 4.34, rounds to 4 -> 4608.
    expect(snapFrame(5_000, "mp3", 44_100)).toBe(4_608);
  });

  it("snaps MP3 frames to the 576-sample grid below 32 kHz", () => {
    // 1000 / 576 = 1.74, rounds to 2 -> 1152.
    expect(snapFrame(1_000, "mp3", 22_050)).toBe(1_152);
  });
});

describe("spliceFormat", () => {
  it("reads the format from a path or bare extension, or null when unsupported", () => {
    expect(spliceFormat("mix.flac")).toBe("flac");
    expect(spliceFormat("mp3")).toBe("mp3");
    expect(spliceFormat("song.ogg")).toBeNull();
  });
});

describe("formatTimecode", () => {
  it("drops the hours when they are zero", () => {
    // 90.5 s at 44.1 kHz: 1:30.500.
    expect(formatTimecode(Math.round(90.5 * 44_100), 44_100)).toBe("01:30.500");
  });

  it("shows the hours when the position passes an hour", () => {
    // 3661.25 s: 1:01:01.250.
    expect(formatTimecode(Math.round(3661.25 * 44_100), 44_100)).toBe("1:01:01.250");
  });
});

describe("parseTimecode", () => {
  it("parses mm:ss.mmm to a frame off the sample rate", () => {
    expect(parseTimecode("01:30.500", 44_100)).toBe(Math.round(90.5 * 44_100));
  });

  it("parses hh:mm:ss.mmm", () => {
    expect(parseTimecode("1:01:01.250", 44_100)).toBe(Math.round(3661.25 * 44_100));
  });

  it("reads a bare number as seconds, the leading field running free", () => {
    expect(parseTimecode("90", 48_000)).toBe(90 * 48_000);
    expect(parseTimecode("90:00", 48_000)).toBe(90 * 60 * 48_000);
  });

  it("round-trips formatTimecode", () => {
    const frame = Math.round(137.42 * 44_100);
    const back = parseTimecode(formatTimecode(frame, 44_100), 44_100);
    // The display carries millisecond precision, so the round-trip lands within a millisecond of frames.
    expect(Math.abs((back ?? 0) - frame)).toBeLessThanOrEqual(44);
  });

  it("rejects a colon-separated seconds field at or past sixty", () => {
    expect(parseTimecode("01:60", 44_100)).toBeNull();
    expect(parseTimecode("1:60:00", 44_100)).toBeNull();
  });

  it("rejects non-numeric or over-long input", () => {
    expect(parseTimecode("abc", 44_100)).toBeNull();
    expect(parseTimecode("1:2:3:4", 44_100)).toBeNull();
    expect(parseTimecode("", 44_100)).toBeNull();
  });
});

describe("parentDir", () => {
  it("drops the last component of a Windows path", () => {
    expect(parentDir("C:\\Music\\album\\take.wav")).toBe("C:\\Music\\album");
  });

  it("drops the last component of a POSIX path and tolerates a trailing slash", () => {
    expect(parentDir("/home/me/music/take.flac")).toBe("/home/me/music");
    expect(parentDir("/home/me/music/")).toBe("/home/me");
  });
});
