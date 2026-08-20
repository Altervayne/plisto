/**
 * A closed date range in epoch seconds: `from` is 00:00:00 of the first day, `to` is 23:59:59 of the
 * last day, so a stamp inside `[from, to]` falls on one of the chosen days. A null bound is open.
 */
export interface DateRange {
  from: number | null;
  to: number | null;
}

/** The 00:00:00 of a day, in epoch seconds, read in the local zone. */
export function dayStart(date: Date): number {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
  return Math.floor(start.getTime() / 1000);
}

/** The 23:59:59 of a day, in epoch seconds, read in the local zone. */
export function dayEnd(date: Date): number {
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 0);
  return Math.floor(end.getTime() / 1000);
}

/**
 * A month as a fixed 6x7 grid of days: the Sunday on or before the first, then 42 consecutive days, so
 * the leading and trailing cells spill into the adjacent months and every month lays out the same size.
 */
export function monthGrid(year: number, month: number): Date[] {
  const lead = new Date(year, month, 1).getDay();
  const cells: Date[] = [];
  for (let i = 0; i < 42; i += 1) cells.push(new Date(year, month, 1 - lead + i));
  return cells;
}

/** Last N days: from N days back at 00:00 through the given day at 23:59. */
export function presetLast(now: Date, days: number): DateRange {
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days);
  return { from: dayStart(from), to: dayEnd(now) };
}

/** This calendar year so far: January 1 at 00:00 through the given day at 23:59. */
export function presetThisYear(now: Date): DateRange {
  const from = new Date(now.getFullYear(), 0, 1);
  return { from: dayStart(from), to: dayEnd(now) };
}
