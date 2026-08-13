/*
 * Shared number and value formatting for display. One home for the rules so counts, durations,
 * and sizes read the same everywhere. Locale-aware where it helps a human read big numbers.
 */

/** Groups a whole number with the locale's thousands separators (1240 -> "1,240"). */
export function formatCount(n: number): string {
  return n.toLocaleString();
}

/** Renders a duration in seconds as m:ss. A null (unreadable length) becomes a dash. */
export function formatDuration(secs: number | null): string {
  if (secs == null) return "-";
  const total = Math.max(0, Math.round(secs));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/** Renders a byte count in the largest unit that keeps it readable (1536 -> "1.5 KB"). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/** Renders a unix-seconds timestamp as the local date and time. */
export function formatTimestamp(secs: number): string {
  return new Date(secs * 1000).toLocaleString();
}
