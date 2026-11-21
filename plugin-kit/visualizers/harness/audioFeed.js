/*
 * The approximate feed: plays a local audio file through Web Audio and builds ticks from an analyser. It is
 * not Plisto's engine analysis, only a quick stand-in with the same fields, so a kind's reaction to real
 * music looks roughly right. The audio never leaves the page. The pure helpers are exported for tests; the
 * Web Audio objects are made only inside `createAudioFeed`.
 */

// -- Local Imports --
import { BAND_COUNT, FINE_COUNT, WAVE_COUNT } from "../lib/check/feed.js";

const LOW_HZ = 40;
const HIGH_HZ = 16000;
const BEAT_GAP_SECONDS = 1 / 3;

const clamp01 = (v) => Math.max(0, Math.min(1, v));
// A one-pole ease toward `target`: `tau` seconds to cover about two thirds of the gap.
const ease = (prev, target, dt, tau) => prev + (target - prev) * (1 - Math.exp(-dt / tau));
const mean = (list, from, to) => {
  let sum = 0;
  for (let i = from; i < to; i++) sum += list[i];
  return sum / (to - from);
};

/** `count` log-spaced band levels in 0..1 from FFT magnitude bytes. */
export function logBands(bytes, sampleRate, count) {
  const binHz = sampleRate / 2 / bytes.length;
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const lo = LOW_HZ * (HIGH_HZ / LOW_HZ) ** (i / count);
    const hi = LOW_HZ * (HIGH_HZ / LOW_HZ) ** ((i + 1) / count);
    const a = Math.min(bytes.length - 1, Math.floor(lo / binHz));
    const b = Math.min(bytes.length, Math.max(a + 1, Math.ceil(hi / binHz)));
    out[i] = clamp01(mean(bytes, a, b) / 255);
  }
  return out;
}

/** The unit level for a linear rms, through a -60..-10 dBFS window. */
export function levelOfRms(rms) {
  return rms <= 0 ? 0 : clamp01((20 * Math.log10(rms) + 60) / 50);
}

/** Finds beats in a stream of onset flux values: above the running mean, at most three a second. */
export function createOnsetTracker() {
  let avg = 0;
  let lastBeat = -Infinity;
  return {
    /** True when `flux` at time `t` is a beat. */
    step(flux, t) {
      const fired = flux > avg * 1.6 + 0.02 && t - lastBeat >= BEAT_GAP_SECONDS;
      avg = avg * 0.95 + flux * 0.05;
      if (fired) lastBeat = t;
      return fired;
    },
  };
}

/** The 256-sample window the engine would send: samples paired and averaged, scaled to their own peak. */
export function waveWindow(samples) {
  const out = new Float32Array(WAVE_COUNT);
  let peak = 0;
  for (let i = 0; i < WAVE_COUNT; i++) {
    out[i] = (samples[2 * i] + samples[2 * i + 1]) / 2;
    peak = Math.max(peak, Math.abs(out[i]));
  }
  if (peak > 0) for (let i = 0; i < WAVE_COUNT; i++) out[i] /= peak;
  return out;
}

/** Decodes `file` and starts it looping; `getNeeds()` names what the current kind asks for. */
export async function createAudioFeed(file, getNeeds) {
  const audio = new AudioContext();
  const buffer = await audio.decodeAudioData(await file.arrayBuffer());
  const source = audio.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  const analyser = audio.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.4;
  source.connect(analyser);
  analyser.connect(audio.destination);
  source.start();
  await audio.resume();

  const spectrum = new Uint8Array(analyser.frequencyBinCount);
  const samples = new Float32Array(analyser.fftSize);
  const onsets = createOnsetTracker();
  const bands = new Float32Array(BAND_COUNT);
  const motion = { bass: 0, mid: 0, high: 0 };
  const slow = { bass: 0, mid: 0, high: 0 };
  let prev = new Float32Array(BAND_COUNT);
  let level = 0;
  let swell = 0;
  let loud = 0;
  let loudSlow = 0;
  let lastShift = -Infinity;
  let lastBeat = -Infinity;
  let beatAt = null;
  let seq = 0;

  return {
    name: "approximate",
    exact: false,
    duration: buffer.duration,
    next(t, dt) {
      analyser.getByteFrequencyData(spectrum);
      analyser.getFloatTimeDomainData(samples);
      const raw = logBands(spectrum, audio.sampleRate, BAND_COUNT);
      let flux = 0;
      for (let i = 0; i < BAND_COUNT; i++) {
        flux += Math.max(0, raw[i] - prev[i]);
        bands[i] = ease(bands[i], raw[i], dt, raw[i] > bands[i] ? 0.04 : 0.25);
      }
      prev = raw;
      flux = clamp01(flux / 3);
      const beat = onsets.step(flux, t);
      if (beat) {
        lastBeat = t;
        beatAt = t;
      }
      const kick = beat ? 1 : Math.exp(-(t - lastBeat) * 9);
      let sumSq = 0;
      let peak = 0;
      for (const s of samples) {
        sumSq += s * s;
        peak = Math.max(peak, Math.abs(s));
      }
      const rms = levelOfRms(Math.sqrt(sumSq / samples.length));
      level = ease(level, rms, dt, 1);
      loud = ease(loud, rms, dt, 0.6);
      loudSlow = ease(loudSlow, rms, dt, 3);
      const group = {
        bass: mean(bands, 0, 6),
        mid: mean(bands, 6, 16),
        high: mean(bands, 16, BAND_COUNT),
      };
      for (const key of Object.keys(group)) {
        slow[key] = ease(slow[key], group[key], dt, 1.5);
        motion[key] = clamp01(Math.max(motion[key] * Math.exp(-dt / 0.4), (group[key] - slow[key]) * 4));
      }
      swell = ease(swell, group.bass, dt, 1);
      const shifted = t - lastShift > 4 && Math.abs(loud - loudSlow) > 0.2;
      if (shifted) lastShift = t;
      const sig = {
        bands: Float32Array.from(bands),
        rms,
        peak: levelOfRms(peak),
        flux,
        kick,
        bass: group.bass,
        mid: group.mid,
        high: group.high,
        level,
        swell,
        bassMotion: motion.bass,
        midMotion: motion.mid,
        highMotion: motion.high,
        beat: beat ? 0.8 : 0,
        drive: 1,
        loudness: loud,
        bassHit: motion.bass,
        midHit: motion.mid,
        highHit: motion.high,
        beatWeight: beat ? 0.7 : 0,
        surge: shifted && loud > loudSlow ? 0.8 : 0,
        cut: shifted && loud < loudSlow ? 0.8 : 0,
      };
      seq += 1;
      return {
        seq,
        t,
        dt,
        sig,
        nBeats: beat ? 1 : 0,
        beatAt,
        rawBands: Array.from(raw),
        fine: getNeeds().fine ? Array.from(logBands(spectrum, audio.sampleRate, FINE_COUNT)) : null,
        playing: true,
        trackSeq: 0,
        progress: ((audio.currentTime % buffer.duration) || 0) / buffer.duration,
        pointer: null,
        wave: getNeeds().waveform ? waveWindow(samples) : null,
      };
    },
    /** Pauses or resumes the sound, which holds or releases the analysis with it. */
    setPlaying: (on) => (on ? audio.resume() : audio.suspend()),
    stop() {
      source.stop();
      return audio.close();
    },
  };
}
