/** A signed decibel readout: "+3.5 dB", "-2.0 dB", "0.0 dB". */
export function formatDb(db: number, digits = 1): string {
  return `${db > 0 ? "+" : ""}${db.toFixed(digits)} dB`;
}
