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

/** The time of day for a unix-seconds stamp: "14:32", 24h, zero-padded, in the local zone. ASCII, so
 *  it sits in a right-aligned meta cell beside the play marker. */
export function formatClockTime(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
}

/** The local calendar-day key for a unix-seconds stamp, "YYYY-MM-DD", so plays fall into a day bucket
 *  regardless of the time. The day-header label text is chosen in the view, which needs i18n. */
export function dayKey(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const y = d.getFullYear();
  const mo = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  return `${y}-${mo}-${day}`;
}

/** Whether two unix-seconds stamps land on the same local calendar day. */
export function sameCalendarDay(a: number, b: number): boolean {
  return dayKey(a) === dayKey(b);
}

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86400;
const WEEK = 604800;
const MONTH = 2592000;
const YEAR = 31536000;

/**
 * A compact relative age for a past unix-seconds timestamp: "just now", "5m ago", "2h ago",
 * "yesterday", then days, weeks, months, years. `now` is injectable so the tests read one clock. A
 * future or just-passed stamp reads "just now". ASCII only, so it sits in a right-aligned meta cell.
 */
export function formatRelativeTime(unixSeconds: number, now = Date.now()): string {
  const d = Math.max(0, Math.floor(now / 1000) - unixSeconds);
  if (d < 45) return "just now";
  if (d < 45 * MINUTE) return `${Math.max(1, Math.round(d / MINUTE))}m ago`;
  if (d < 22 * HOUR) return `${Math.round(d / HOUR)}h ago`;
  if (d < 36 * HOUR) return "yesterday";
  if (d < WEEK) return `${Math.round(d / DAY)}d ago`;
  if (d < 4 * WEEK) return `${Math.round(d / WEEK)}w ago`;
  if (d < YEAR) return `${Math.round(d / MONTH)}mo ago`;
  return `${Math.round(d / YEAR)}y ago`;
}
