// -- Utils Imports --
import { relativeAge } from "../lib/format";

// -- Type Imports --
import type { Translate } from "./index";

/** How long ago an epoch-ms instant was, worded in the active locale: "just now", "5 min ago". */
export function ageText(t: Translate, atMs: number, nowMs: number): string {
  const age = relativeAge(atMs, nowMs);
  return age.unit === "now"
    ? t((d) => d.time.justNow)
    : age.unit === "minutes"
      ? t((d) => d.time.minutesAgo, { n: age.n })
      : age.unit === "hours"
        ? t((d) => d.time.hoursAgo, { n: age.n })
        : t((d) => d.time.daysAgo, { n: age.n });
}
