/*
 * Reads one line of a plugin's `plugin.log` for display. Plisto writes `<unix ms> <LEVEL> <text>`; any
 * other line, such as a native plugin's stderr, shows as plain text.
 */

/** One log line split into the columns the panel draws. */
export interface LogLine {
  /** Local `HH:MM:SS.mmm`, or null for a line without a timestamp. */
  time: string | null;
  level: string | null;
  text: string;
  /** A warning or an error, drawn in the warn tone. */
  warn: boolean;
}

const LINE = /^(\d{9,16}) (DEBUG|INFO|WARN|ERROR|HOST) (.*)$/;

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

function clock(ms: number): string | null {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function parseLogLine(raw: string): LogLine {
  const m = LINE.exec(raw);
  const time = m ? clock(Number(m[1])) : null;
  if (!m || time === null) return { time: null, level: null, text: raw, warn: false };
  return { time, level: m[2], text: m[3], warn: m[2] === "WARN" || m[2] === "ERROR" };
}
