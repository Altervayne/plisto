// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { DEFAULT_WINDOW } from "./labMeasure";
import { parseReadWindow, pickLayoutIds, pickReactivity } from "./labParams";
import { DROP_START, SONG_SECONDS } from "./labSong";

const DEFAULTS = DEFAULT_WINDOW;
const SONG_END = SONG_SECONDS;

describe("pickLayoutIds", () => {
  it("takes the fallback when none is named", () => {
    expect(pickLayoutIds(null, ["player", "ambient-side"])).toEqual(["player", "ambient-side"]);
  });

  it("names one layout, including the side-by-side ambient one", () => {
    expect(pickLayoutIds("ambient-side", ["player"])).toEqual(["ambient-side"]);
    expect(pickLayoutIds("ambient", ["player"])).toEqual(["ambient"]);
  });

  it("rejects an unknown layout", () => {
    expect(() => pickLayoutIds("wide", ["player"])).toThrow(/unknown layout/);
  });

  it("returns a copy of the fallback", () => {
    const fallback = ["player"] as const;
    expect(pickLayoutIds(null, fallback)).not.toBe(fallback);
  });
});

describe("parseReadWindow", () => {
  it("defaults to ten seconds from two seconds into the drop", () => {
    expect(DEFAULTS).toEqual({ from: DROP_START + 2, length: 10 });
    expect(parseReadWindow(null, null, DEFAULTS, SONG_END)).toEqual(DEFAULTS);
  });

  it("reads a chosen moment with the default length", () => {
    expect(parseReadWindow("26", null, DEFAULTS, SONG_END)).toEqual({ from: 26, length: DEFAULTS.length });
  });

  it("reads the whole song", () => {
    expect(parseReadWindow("0", String(SONG_END), DEFAULTS, SONG_END)).toEqual({ from: 0, length: SONG_END });
  });

  it("rejects a window shorter than one frame", () => {
    expect(() => parseReadWindow("30", "0.01", DEFAULTS, SONG_END)).toThrow(/at least one/);
    expect(parseReadWindow("30", "0.02", DEFAULTS, SONG_END).length).toBe(0.02);
  });

  it("accepts a fractional window", () => {
    expect(parseReadWindow("32.5", "1.5", DEFAULTS, SONG_END)).toEqual({ from: 32.5, length: 1.5 });
  });

  it("rejects a negative start", () => {
    expect(() => parseReadWindow("-1", null, DEFAULTS, SONG_END)).toThrow(/negative/);
  });

  it("rejects a zero or negative length", () => {
    expect(() => parseReadWindow(null, "0", DEFAULTS, SONG_END)).toThrow(/longer than zero/);
    expect(() => parseReadWindow(null, "-3", DEFAULTS, SONG_END)).toThrow(/longer than zero/);
  });

  it("rejects a window past the end of the song", () => {
    expect(() => parseReadWindow(String(SONG_END - 5), "10", DEFAULTS, SONG_END)).toThrow(/past the end/);
    expect(() => parseReadWindow(String(SONG_END + 10), "1", DEFAULTS, SONG_END)).toThrow(/past the end/);
  });

  it("rejects a value that is not a number", () => {
    expect(() => parseReadWindow("soon", null, DEFAULTS, SONG_END)).toThrow(/from=/);
    expect(() => parseReadWindow(null, "", DEFAULTS, SONG_END)).toThrow(/for=/);
  });
});

describe("pickReactivity", () => {
  it("takes the fallback when none is named", () => {
    expect(pickReactivity(null, "lively")).toBe("lively");
  });

  it("names a level", () => {
    expect(pickReactivity("calm", "lively")).toBe("calm");
  });

  it("rejects an unknown level", () => {
    expect(() => pickReactivity("wild", "lively")).toThrow(/unknown reactivity/);
  });
});
