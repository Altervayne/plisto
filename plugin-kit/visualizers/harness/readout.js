/*
 * What one mount has reported, and the rows the readout shows from it. A reading the frame never gave is
 * "no reading", never 0: a zero would pass for a measurement. The verdict lines use the checker's own
 * judging over the same limits, on the window of acks kept since the frame was ready. A hang is not judged:
 * a frame that goes quiet while the tab is hidden or throttled is healthy, and only the checker's scripted
 * run can tell the two apart.
 */

// -- Local Imports --
import { judgeRun, median } from "../lib/check/judge.mjs";

export const NO_READING = "no reading";
const KEEP_FRAMES = 1200;
const MAX_LOG = 40;

/** A run's state before the first message. */
export function createRun() {
  return {
    startedAt: null,
    readyAt: null,
    readyMs: null,
    metered: false,
    frames: [],
    flash: [],
    error: null,
    lost: false,
    log: [],
  };
}

/** Folds one frame message, heard at `now` ms, into the run. */
export function record(run, message, now) {
  switch (message.type) {
    case "ready":
      run.readyAt = now;
      run.readyMs = run.startedAt === null ? null : now - run.startedAt;
      run.metered = message.metered;
      break;
    case "metered":
      run.metered = true;
      break;
    case "ack":
      if (run.readyAt === null) break;
      run.frames.push({ at: now - run.readyAt, ms: message.ms });
      if (run.frames.length > KEEP_FRAMES) run.frames.shift();
      break;
    case "flash":
      run.flash.push(message.reading);
      if (run.flash.length > KEEP_FRAMES) run.flash.shift();
      break;
    case "lost":
      run.lost = true;
      break;
    case "error":
      run.error = { stage: message.stage, message: message.message };
      break;
    case "log":
      run.log.push(`${message.level}: ${message.text}`);
      if (run.log.length > MAX_LOG) run.log.shift();
      break;
    default:
  }
}

/** A number with its unit, or "no reading" when it is not a finite number. */
export function fmt(value, digits = 1, unit = "") {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(digits)}${unit}` : NO_READING;
}

const worst = (readings, key) => readings.reduce((m, r) => Math.max(m, r[key] ?? 0), 0);

// The runtime posts a reading only when the meter trips, so no reading from a metered kind is a good sign.
function flashRow(run, meterOn) {
  if (!meterOn) return "meter off";
  if (run.readyAt === null) return NO_READING;
  if (!run.metered) return "not watched (no canvas registered)";
  if (run.flash.length === 0) return "under the limit";
  const flashes = fmt(worst(run.flash, "flashesPerSec"), 1);
  const red = fmt(worst(run.flash, "redFlashesPerSec"), 1);
  return `over the limit: ${flashes}/s, red ${red}/s`;
}

/**
 * The rows to show: `{ label, value, tone }` with tone "warn" for a finding. `stats` is the transport's
 * stats, `meterOn` whether the meter is switched on in the harness.
 */
export function summarize(run, stats, meterOn) {
  const costs = run.frames.map((f) => f.ms).filter((ms) => ms !== null);
  const rows = [
    { label: "Ready", value: fmt(run.readyMs, 0, " ms") },
    { label: "Ticks sent", value: String(stats.sent) },
    { label: "Ticks acked", value: String(stats.acked) },
    { label: "In flight", value: `${stats.outstanding} of 2` },
    { label: "Folded while hidden", value: String(stats.withheld) },
    { label: "Step cost", value: fmt(stats.lastAckMs, 2, " ms") },
    { label: "Step median", value: fmt(median(costs), 2, " ms") },
    { label: "Step worst", value: fmt(costs.length ? Math.max(...costs) : null, 2, " ms") },
    { label: "Flashing", value: flashRow(run, meterOn) },
  ];
  if (run.readyAt !== null) {
    const verdict = judgeRun({
      readyMs: run.readyMs,
      metered: run.metered && meterOn,
      flash: run.flash,
      frames: run.frames,
      runMs: run.frames.length ? run.frames[run.frames.length - 1].at : 0,
    });
    if (verdict.flashing) rows.push({ label: "Finding", value: "flashes over the limit", tone: "warn" });
    if (verdict.red) rows.push({ label: "Finding", value: "saturated red flash", tone: "warn" });
    if (verdict.slow) rows.push({ label: "Finding", value: "median step cost over the limit", tone: "warn" });
  }
  if (run.lost) rows.push({ label: "Frame", value: "the graphics context was lost", tone: "warn" });
  if (run.error) {
    rows.push({ label: "Error", value: `${run.error.stage}: ${run.error.message}`, tone: "warn" });
  }
  return rows;
}
