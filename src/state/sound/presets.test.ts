// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import {
  PRESET_GAINS,
  PRESET_KEYS,
  applyPreset,
  canReset,
  detectPreset,
  isShaped,
  resetSound,
  setBandGain,
  setEqOn,
  setPreampDb,
} from "./presets";
import { defaultSoundSettings } from "./settings";

describe("presets", () => {
  it("applies each preset's table and names it", () => {
    for (const key of PRESET_KEYS) {
      const s = applyPreset(defaultSoundSettings(), key);
      expect(s.eq.gains).toEqual(PRESET_GAINS[key]);
      expect(s.eq.preset).toBe(key);
    }
  });

  it("keeps the on switch and levelling when a preset is applied", () => {
    const s = applyPreset({ ...setEqOn(defaultSoundSettings(), true), levelling: "track" }, "bass");
    expect(s.eq.on).toBe(true);
    expect(s.levelling).toBe("track");
  });

  it("does not share the preset table with the settings", () => {
    const s = applyPreset(defaultSoundSettings(), "bass");
    s.eq.gains[0] = 1;
    expect(PRESET_GAINS.bass[0]).toBe(6);
  });
});

describe("hand edits", () => {
  it("flips the preset to Custom", () => {
    const s = setBandGain(applyPreset(defaultSoundSettings(), "bass"), 3, 2);
    expect(s.eq.preset).toBe("custom");
    expect(detectPreset(s.eq.gains)).toBe("custom");
  });

  it("selects a preset again when the edit lands on it", () => {
    const s = setBandGain(setBandGain(applyPreset(defaultSoundSettings(), "bass"), 3, 2), 3, 0);
    expect(s.eq.preset).toBe("bass");
  });

  it("snaps to half decibels and clamps to the range", () => {
    expect(setBandGain(defaultSoundSettings(), 1, 2.3).eq.gains[1]).toBe(2.5);
    expect(setBandGain(defaultSoundSettings(), 1, 40).eq.gains[1]).toBe(12);
    expect(setBandGain(defaultSoundSettings(), 1, -40).eq.gains[1]).toBe(-12);
  });

  it("ignores a band that does not exist", () => {
    const s = defaultSoundSettings();
    expect(setBandGain(s, 8, 3)).toBe(s);
  });

  it("clamps the preamp to its range", () => {
    expect(setPreampDb(defaultSoundSettings(), 20).preampDb).toBe(6);
    expect(setPreampDb(defaultSoundSettings(), -20).preampDb).toBe(-12);
  });
});

describe("reset", () => {
  it("gives flat gains and a zero preamp, keeping the switch", () => {
    const shaped = setPreampDb(setEqOn(applyPreset(defaultSoundSettings(), "loudness"), true), -4);
    const s = resetSound(shaped);
    expect(s.eq.gains).toEqual(PRESET_GAINS.flat);
    expect(s.eq.preset).toBe("flat");
    expect(s.preampDb).toBe(0);
    expect(s.eq.on).toBe(true);
  });

  it("is only offered when there is something to undo", () => {
    expect(canReset(defaultSoundSettings())).toBe(false);
    expect(canReset(applyPreset(defaultSoundSettings(), "bass"))).toBe(true);
    expect(canReset(setPreampDb(defaultSoundSettings(), 1))).toBe(true);
  });
});

describe("isShaped", () => {
  it("needs the EQ on and a curve that is not flat", () => {
    const bass = applyPreset(defaultSoundSettings(), "bass");
    expect(isShaped(bass)).toBe(false);
    expect(isShaped(setEqOn(bass, true))).toBe(true);
    expect(isShaped(setEqOn(defaultSoundSettings(), true))).toBe(false);
  });
});
