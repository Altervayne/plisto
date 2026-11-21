/*
 * The harness's tick sources. The scripted feed is the checker's own; a recorded feed replays ticks exactly
 * as captured, folding the ticks a slow display frame skips the way the host's credit window does; the
 * approximate feed (audioFeed.js) analyses a local audio file. `shapeTick` applies a reactivity level to a
 * feed that has not been shaped yet, as Plisto's signal follower does before ticks leave the host.
 * No browser calls here, so it runs in node tests.
 */

// -- Local Imports --
import { MAX_CARRY, SIGNAL_FOLD, foldTick } from "../lib/protocol.js";
import { BAND_COUNT, createFeed } from "../lib/check/feed.js";

/** The motion channel's gain per reactivity level; `drive` is this gain itself. */
export const GAIN = { calm: 0, balanced: 1, lively: 1.6 };
// The fields the gain scales: the motion envelopes and the one-frame events.
const SCALED = [
  "beat", "beatWeight", "bassMotion", "midMotion", "highMotion",
  "bassHit", "midHit", "highHit", "surge", "cut",
];

/** A tick under the reactivity level: motion and events scaled by its gain, no beat counted at zero gain. */
export function shapeTick(tick, reactivity) {
  const gain = GAIN[reactivity] ?? 1;
  const sig = { ...tick.sig, drive: gain };
  for (const key of SCALED) sig[key] = tick.sig[key] * gain;
  return { ...tick, sig, nBeats: sig.beat > 0 ? tick.nBeats : 0 };
}

/** The checker's scripted feed. `exact` feeds are sent as they are; the others are shaped by reactivity. */
export function createScriptedFeed(needs) {
  const feed = createFeed(needs);
  return { name: "scripted", exact: false, next: (t, dt) => feed.next(t, dt) };
}

// -- Recordings --

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const numbers = (v) => (Array.isArray(v) ? v.map((n) => (isNum(n) ? n : 0)) : null);

function readTick(raw, index) {
  const at = `tick ${index + 1}`;
  if (typeof raw !== "object" || raw === null || !isNum(raw.t) || !isNum(raw.dt) || raw.dt < 0) {
    throw new Error(`${at} needs numbers 't' and 'dt'`);
  }
  if (typeof raw.sig !== "object" || raw.sig === null) throw new Error(`${at} has no 'sig'`);
  const sig = {};
  for (const key of Object.keys(SIGNAL_FOLD)) sig[key] = isNum(raw.sig[key]) ? raw.sig[key] : 0;
  sig.bands = Float32Array.from(numbers(raw.sig.bands) ?? new Array(BAND_COUNT).fill(0));
  const wave = numbers(raw.wave);
  return {
    seq: 0,
    t: raw.t,
    dt: raw.dt,
    sig,
    nBeats: Number.isSafeInteger(raw.nBeats) && raw.nBeats >= 0 ? raw.nBeats : 0,
    beatAt: isNum(raw.beatAt) ? raw.beatAt : null,
    rawBands: numbers(raw.rawBands) ?? Array.from(sig.bands),
    fine: numbers(raw.fine),
    playing: raw.playing !== false,
    trackSeq: Number.isSafeInteger(raw.trackSeq) ? raw.trackSeq : 0,
    progress: isNum(raw.progress) ? raw.progress : null,
    pointer: null,
    wave: wave ? Float32Array.from(wave) : null,
  };
}

/** The ticks of a recording: a JSON array, or an object with a `ticks` array. Throws a one-line reason. */
export function parseRecording(json) {
  const list = Array.isArray(json) ? json : json && Array.isArray(json.ticks) ? json.ticks : null;
  if (list === null) throw new Error("the recording must be an array of ticks, or an object with 'ticks'");
  if (list.length === 0) throw new Error("the recording holds no ticks");
  return list.map(readTick).sort((a, b) => a.t - b.t);
}

// The last index whose tick is at or before `pos`.
function indexAt(ticks, pos) {
  let lo = 0;
  let hi = ticks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ticks[mid].t <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** A tick with its one-frame events cleared, for a display frame that falls in the same recorded tick. */
function quiet(tick) {
  const sig = { ...tick.sig };
  for (const key of MAX_CARRY) sig[key] = 0;
  return { ...tick, sig, nBeats: 0 };
}

/**
 * Replays a recording in a loop. A display frame that spans several recorded ticks gets them folded into
 * one, so no beat is lost; one that falls inside a recorded tick already sent gets no repeated event.
 */
export function createRecordedFeed(ticks) {
  const last = ticks[ticks.length - 1];
  const length = Math.max(last.t + last.dt, last.t + 1e-3);
  let cursor = -1;
  let seq = 0;
  return {
    name: "recorded",
    exact: true,
    length,
    next(t, dt) {
      const index = indexAt(ticks, t % length);
      let tick;
      if (index === cursor) tick = quiet(ticks[index]);
      else {
        const run = [];
        for (let i = (cursor + 1) % ticks.length; ; i = (i + 1) % ticks.length) {
          run.push(ticks[i]);
          if (i === index) break;
        }
        // The cursor starts before the first tick, so the first frame folds a run from tick 0.
        tick = run.reduce((held, next) => foldTick(held, next));
      }
      cursor = index;
      seq += 1;
      return { ...tick, seq, t, dt };
    },
  };
}
