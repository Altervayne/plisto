/*
 * The scripted feed of a checker run: a synthetic stand-in for music, one tick per display frame. A beat
 * lands at a steady tempo, the bands sweep across the spectrum, the level breathes, and there is one surge
 * and one cut. It runs in the host page and in tests, so it holds no browser calls.
 */

export const BAND_COUNT = 24;
export const FINE_COUNT = 128;
export const WAVE_COUNT = 256;
// A steady four-on-the-floor at 120 beats a minute.
export const BEAT_SECONDS = 0.5;
export const SURGE_AT = 4;
export const CUT_AT = 8;

const clamp01 = (v) => Math.max(0, Math.min(1, v));
// A band's value: a bump that sweeps up the spectrum every four seconds, over a floor.
const sweep = (t, x) => clamp01(0.12 + 0.7 * Math.max(0, Math.cos(2 * Math.PI * (t / 4 - x))) ** 2);

const fineBand = (t, i) => sweep(t, i / (FINE_COUNT - 1));
const circle = (t) => ({ x: 0.5 + 0.3 * Math.cos(t), y: 0.5 + 0.3 * Math.sin(t), inside: true });
const wave = (t, i) => Math.sin((i / 16) * Math.PI + t * 6);

const group = (bands, from, to) => {
  let sum = 0;
  for (let i = from; i < to; i++) sum += bands[i];
  return sum / (to - from);
};

/** A feed for a kind with the given needs; `next(t, dt)` is the tick for the frame at `t` seconds. */
export function createFeed(needs = {}) {
  let seq = 0;
  let beatAt = null;
  let lastBeat = -1;
  return {
    next(t, dt) {
      const beatIndex = Math.floor(t / BEAT_SECONDS);
      const beats = beatIndex !== lastBeat ? 1 : 0;
      lastBeat = beatIndex;
      if (beats > 0) beatAt = t;
      const since = t - beatIndex * BEAT_SECONDS;
      const kick = beats > 0 ? 1 : Math.exp(-since * 9);
      const bands = Float32Array.from({ length: BAND_COUNT }, (_, i) => sweep(t, i / (BAND_COUNT - 1)));
      const level = clamp01(0.5 + 0.2 * Math.sin(t / 3));
      const sig = {
        bands,
        rms: clamp01(level * (0.85 + 0.3 * kick)),
        peak: clamp01(level + 0.2 * kick),
        flux: kick,
        kick,
        bass: group(bands, 0, 6),
        mid: group(bands, 6, 16),
        high: group(bands, 16, BAND_COUNT),
        level,
        swell: clamp01(0.5 + 0.3 * Math.sin(t / 2)),
        bassMotion: 0.6 * kick,
        midMotion: 0.4 * kick,
        highMotion: 0.3 * kick,
        beat: beats > 0 ? 0.8 : 0,
        drive: 1,
        loudness: level,
        bassHit: 0.7 * kick,
        midHit: 0.4 * kick,
        highHit: 0.3 * kick,
        beatWeight: beats > 0 ? 0.7 : 0,
        surge: t >= SURGE_AT && t - dt < SURGE_AT ? 0.8 : 0,
        cut: t >= CUT_AT && t - dt < CUT_AT ? 0.8 : 0,
      };
      seq += 1;
      return {
        seq,
        t,
        dt,
        sig,
        nBeats: beats,
        beatAt,
        rawBands: Array.from(bands),
        fine: needs.fine ? Array.from({ length: FINE_COUNT }, (_, i) => fineBand(t, i)) : null,
        playing: true,
        trackSeq: 0,
        progress: (t % 180) / 180,
        pointer: needs.pointer ? circle(t) : null,
        wave: needs.waveform ? Float32Array.from({ length: WAVE_COUNT }, (_, i) => wave(t, i)) : null,
      };
    },
  };
}
