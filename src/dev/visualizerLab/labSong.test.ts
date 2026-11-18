// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { DROP_START, createLabSong } from "./labSong";

const DT = 1 / 60;
const INTRO_END = 16;
const DROP_END = 64;

function median(values: number[]): number {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
}

describe("the lab song's loudness", () => {
  it("carries an rmsDb that rises with the unit rms and stays within -60..0", () => {
    const song = createLabSong(0, "balanced");
    const pairs: [number, number][] = [];
    for (let i = 0; i < 40 * 60; i++) {
      const { level } = song.step(DT);
      // Before the first engine frame the level is the empty one, with no dBFS.
      if (level.rmsDb !== undefined) pairs.push([level.rms, level.rmsDb]);
    }
    pairs.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < pairs.length; i++) expect(pairs[i][1]).toBeGreaterThanOrEqual(pairs[i - 1][1]);
    for (const [, db] of pairs) {
      expect(db).toBeGreaterThanOrEqual(-60);
      expect(db).toBeLessThanOrEqual(0);
    }
  });

  it("reads loud in the drop and quiet in the intro", () => {
    for (const reactivity of ["lively", "balanced"] as const) {
      const song = createLabSong(0, reactivity);
      const intro: number[] = [];
      const drop: number[] = [];
      for (let i = 0; i * DT < DROP_END; i++) {
        const t = i * DT;
        const { sig } = song.step(DT);
        if (t >= 2 && t < INTRO_END) intro.push(sig.loudness);
        else if (t >= DROP_START) drop.push(sig.loudness);
      }
      expect(median(intro)).toBeLessThanOrEqual(0.35);
      expect(median(drop)).toBeGreaterThanOrEqual(0.8);
    }
  });
});
