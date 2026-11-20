// -- Utils Imports --
import { formatClockTime, formatDateTime, sameCalendarDay } from "../../../lib/format";

// -- Type Imports --
import type { Locale } from "../../../i18n/types";

/** The words around a clock time for today and yesterday, already in the active language. */
export interface WhenWords {
  today: (time: string) => string;
  yesterday: (time: string) => string;
}

/** When a write happened: "today 14:32", "yesterday 14:32", or the full date and time for anything older. */
export function lastWriteWhen(atMs: number, nowMs: number, locale: Locale, words: WhenWords): string {
  const at = atMs / 1000;
  const time = formatClockTime(at);
  if (sameCalendarDay(at, nowMs / 1000)) return words.today(time);
  const before = new Date(nowMs);
  before.setDate(before.getDate() - 1);
  if (sameCalendarDay(at, before.getTime() / 1000)) return words.yesterday(time);
  return formatDateTime(atMs, locale);
}
