/*
 * Small statistics for probe readings. Pure, so a run's numbers are replayable in tests.
 */

/** The p-th percentile (0 to 100) by nearest rank; 0 for no samples. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((Math.min(100, Math.max(0, p)) / 100) * sorted.length);
  return sorted[Math.max(0, rank - 1)];
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function maxOf(values: readonly number[]): number {
  return values.reduce((m, v) => (v > m ? v : m), 0);
}

export function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length;
}

/**
 * Per-item time from batch timings: each entry of `batchMs` is the wall time of `batchSize` items, which
 * keeps a coarsened clock from rounding a single call to zero.
 */
export function perItemMs(batchMs: readonly number[], batchSize: number): number[] {
  return batchSize > 0 ? batchMs.map((ms) => ms / batchSize) : [];
}

/** The smallest positive step between distinct readings: the clock resolution a run observed. */
export function clockStep(readings: readonly number[]): number {
  const sorted = [...readings].sort((a, b) => a - b);
  let step = Infinity;
  for (let i = 1; i < sorted.length; i++) {
    const d = sorted[i] - sorted[i - 1];
    if (d > 0 && d < step) step = d;
  }
  return Number.isFinite(step) ? step : 0;
}

/** Formats a reading with a fixed number of decimals, trimming nothing, so report columns stay stable. */
export function fixed(value: number, digits = 1): string {
  return value.toFixed(digits);
}
