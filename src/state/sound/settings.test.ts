// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import {
  BANDS,
  defaultSoundSettings,
  parseSoundSettings,
  serializeSoundSettings,
  type Levelling,
} from "./settings";

const FLAT = [0, 0, 0, 0, 0, 0, 0, 0];

interface Case {
  name: string;
  raw: string;
  on: boolean;
  preset: string | null;
  gains: number[];
  preampDb: number;
  levelling: Levelling;
}

// The same table runs in src-tauri/src/sound_settings.rs; keep the two in step.
const CASES: Case[] = [
  {
    name: "full blob",
    raw: '{"v":1,"eq":{"on":true,"preset":"rock","gains":[1,2,3,-1,-2,-3,4,5]},"preamp_db":-3,"levelling":"track"}',
    on: true,
    preset: "rock",
    gains: [1, 2, 3, -1, -2, -3, 4, 5],
    preampDb: -3,
    levelling: "track",
  },
  {
    name: "version mismatch",
    raw: '{"v":2,"eq":{"on":true,"preset":"rock","gains":[1,2,3,4,5,6,7,8]},"preamp_db":-3,"levelling":"track"}',
    on: false,
    preset: null,
    gains: FLAT,
    preampDb: 0,
    levelling: "off",
  },
  {
    name: "missing version",
    raw: '{"eq":{"on":true,"gains":[1,2,3,4,5,6,7,8]},"preamp_db":-3,"levelling":"track"}',
    on: false,
    preset: null,
    gains: FLAT,
    preampDb: 0,
    levelling: "off",
  },
  {
    name: "wrong gains length",
    raw: '{"v":1,"eq":{"on":true,"preset":"rock","gains":[1,2,3]},"preamp_db":-3,"levelling":"track"}',
    on: false,
    preset: null,
    gains: FLAT,
    preampDb: -3,
    levelling: "track",
  },
  {
    name: "non-finite gain",
    raw: '{"v":1,"eq":{"on":true,"preset":"rock","gains":[1,2,null,4,5,6,7,8]},"preamp_db":2,"levelling":"off"}',
    on: false,
    preset: null,
    gains: FLAT,
    preampDb: 2,
    levelling: "off",
  },
  {
    name: "gains clamp",
    raw: '{"v":1,"eq":{"on":true,"preset":null,"gains":[99,-99,12,-12,0,0,0,0]},"preamp_db":0,"levelling":"off"}',
    on: true,
    preset: null,
    gains: [12, -12, 12, -12, 0, 0, 0, 0],
    preampDb: 0,
    levelling: "off",
  },
  {
    name: "preamp clamps high",
    raw: '{"v":1,"eq":{"on":false,"gains":[0,0,0,0,0,0,0,0]},"preamp_db":40,"levelling":"off"}',
    on: false,
    preset: null,
    gains: FLAT,
    preampDb: 6,
    levelling: "off",
  },
  {
    name: "preamp clamps low",
    raw: '{"v":1,"eq":{"on":false,"gains":[0,0,0,0,0,0,0,0]},"preamp_db":-40,"levelling":"off"}',
    on: false,
    preset: null,
    gains: FLAT,
    preampDb: -12,
    levelling: "off",
  },
  {
    name: "unknown levelling",
    raw: '{"v":1,"eq":{"on":true,"gains":[0,0,0,0,0,0,0,0]},"preamp_db":1,"levelling":"album"}',
    on: true,
    preset: null,
    gains: FLAT,
    preampDb: 1,
    levelling: "off",
  },
  {
    name: "missing fields",
    raw: '{"v":1}',
    on: false,
    preset: null,
    gains: FLAT,
    preampDb: 0,
    levelling: "off",
  },
  {
    name: "missing eq keeps the other fields",
    raw: '{"v":1,"preamp_db":-2,"levelling":"track"}',
    on: false,
    preset: null,
    gains: FLAT,
    preampDb: -2,
    levelling: "track",
  },
  {
    name: "empty string",
    raw: "",
    on: false,
    preset: null,
    gains: FLAT,
    preampDb: 0,
    levelling: "off",
  },
  {
    name: "unparsable json",
    raw: "{not json",
    on: false,
    preset: null,
    gains: FLAT,
    preampDb: 0,
    levelling: "off",
  },
];

describe("parseSoundSettings", () => {
  it.each(CASES)("$name", (c) => {
    const got = parseSoundSettings(c.raw);
    expect(got.eq.on).toBe(c.on);
    expect(got.eq.preset).toBe(c.preset);
    expect(got.eq.gains).toEqual(c.gains);
    expect(got.preampDb).toBe(c.preampDb);
    expect(got.levelling).toBe(c.levelling);
  });

  it("round-trips through the wire form", () => {
    const settings = {
      eq: { on: true, preset: "vocal", gains: [1.5, 0, -2, 3, 0.5, -1, 2, 4] },
      preampDb: -4.5,
      levelling: "track" as const,
    };
    expect(parseSoundSettings(serializeSoundSettings(settings))).toEqual(settings);
  });

  it("defaults to bypassed, flat, preamp 0, levelling off", () => {
    expect(defaultSoundSettings()).toEqual({
      eq: { on: false, preset: null, gains: FLAT },
      preampDb: 0,
      levelling: "off",
    });
  });
});

describe("BANDS", () => {
  it("lists the eight bands low to high with shelves at the ends", () => {
    expect(BANDS.map((b) => b.freqHz)).toEqual([60, 150, 400, 1000, 2400, 5000, 9000, 14000]);
    expect(BANDS[0].kind).toBe("lowShelf");
    expect(BANDS[7].kind).toBe("highShelf");
  });
});
