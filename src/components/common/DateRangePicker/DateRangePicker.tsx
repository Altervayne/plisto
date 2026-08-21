// -- Framework Imports --
import { useEffect, useMemo, useRef, useState } from "react";

// -- Icon Imports --
import { Calendar, ChevronLeft, ChevronRight } from "lucide-react";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Utils Imports --
import { dayEnd, dayStart, monthGrid, presetLast, presetThisYear } from "./dateRange";
import type { DateRange } from "./dateRange";

// -- Style Imports --
import styles from "./DateRangePicker.module.css";

export type { DateRange } from "./dateRange";

/** The shown month, as the calendar steps through it independent of the value. */
interface View {
  year: number;
  month: number;
}

/** A short, locale-plain rendering of a bound for the trigger label. */
function labelFor(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString();
}

/** The shown month to open on: the range's start, then its end, then today. */
function viewFor(range: DateRange): View {
  const anchor =
    range.from != null ? new Date(range.from * 1000)
    : range.to != null ? new Date(range.to * 1000)
    : new Date();
  return { year: anchor.getFullYear(), month: anchor.getMonth() };
}

/**
 * A bespoke date-range picker: a quiet trigger over a floating month calendar. The trigger reads the
 * current range as plain text; the popover drops a row of presets above a month grid where a click sets
 * the start, the next click closes the range, and a hover previews the span between. Endpoints wear the
 * solid accent, the days between take the weak accent, and today keeps a faint ring. Presentational -
 * the parent owns the range, so the same picker filters any wall of dated rows.
 */
export function DateRangePicker({
  value,
  onChange,
  lastExport,
}: {
  value: DateRange;
  onChange: (range: DateRange) => void;
  // Epoch seconds of the last full export, or null when there has been none. Present, it offers a
  // "Since last export" preset that opens the range at that stamp - the caller's field toggle then reads
  // it as changed-since (Updated) or added-since (Created).
  lastExport?: number | null;
}) {
  const t = useT();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>(() => viewFor(value));
  const [hover, setHover] = useState<Date | null>(null);

  // A start is set but no end yet: the state where a click closes the range and a hover previews it.
  const picking = value.from != null && value.to == null;

  // The weekday initials and month heading follow the engine's own locale, matching the plain trigger
  // label. The reference Sunday (Jan 4 1970) plus an offset walks the row Sunday through Saturday.
  const weekdays = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(undefined, { weekday: "narrow" });
    return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(1970, 0, 4 + i)));
  }, []);
  const monthLabel = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(
        new Date(view.year, view.month, 1),
      ),
    [view],
  );
  const adjacentLabel = (delta: number) =>
    new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(
      new Date(view.year, view.month + delta, 1),
    );

  const cells = useMemo(() => monthGrid(view.year, view.month), [view]);

  // The highlighted span as day-start seconds, normalized low to high so an in-progress pick that runs
  // backward from the start still shades the right days. A lone start (no end, no hover) shades itself.
  const startSec = value.from;
  const otherSec =
    value.to != null ? dayStart(new Date(value.to * 1000))
    : picking && hover != null ? dayStart(hover)
    : null;
  const lo = startSec != null && otherSec != null ? Math.min(startSec, otherSec) : startSec;
  const hi = startSec != null && otherSec != null ? Math.max(startSec, otherSec) : startSec;
  const todaySec = dayStart(new Date());

  // While open, an outside press dismisses it, mirroring the app's other floating panels. Escape is
  // handled on the wrapper below rather than here, so it can be kept from bubbling to an ancestor's own
  // Escape handler.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  const toggle = () => {
    if (!open) setView(viewFor(value));
    setOpen((was) => !was);
  };

  const step = (delta: number) =>
    setView((v) => {
      const shifted = new Date(v.year, v.month + delta, 1);
      return { year: shifted.getFullYear(), month: shifted.getMonth() };
    });

  // A click sets the start when the range is empty or complete, and closes it while a start waits. A
  // click before the start swaps the two, so the earlier day always becomes the start.
  const pickDay = (day: Date) => {
    setView({ year: day.getFullYear(), month: day.getMonth() });
    setHover(null);
    if (!picking) {
      onChange({ from: dayStart(day), to: null });
      return;
    }
    const clicked = dayStart(day);
    if (value.from != null && clicked >= value.from) {
      onChange({ from: value.from, to: dayEnd(day) });
    } else {
      onChange({ from: clicked, to: dayEnd(new Date((value.from ?? 0) * 1000)) });
    }
  };

  const triggerLabel =
    value.from == null && value.to == null ? t((d) => d.dateRange.any)
    : value.from != null && value.to == null ? t((d) => d.dateRange.since, { date: labelFor(value.from) })
    : value.from == null && value.to != null ? t((d) => d.dateRange.until, { date: labelFor(value.to) })
    : `${labelFor(value.from as number)} - ${labelFor(value.to as number)}`;

  return (
    <div
      ref={wrapRef}
      className={styles.wrap}
      onKeyDown={(event) => {
        // Escape closes the popover only, and is stopped here so it never reaches an ancestor's own
        // Escape handler - a grid that clears its selection on Escape must not lose it when the user
        // is only dismissing this calendar.
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        className={styles.trigger}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={toggle}
      >
        <Calendar className={styles.triggerIcon} aria-hidden="true" />
        {triggerLabel}
      </button>

      {open ? (
        <div className={styles.pop} role="dialog" aria-label={t((d) => d.dateRange.any)}>
          <div className={styles.presets}>
            <button type="button" className={styles.preset} onClick={() => onChange({ from: null, to: null })}>
              {t((d) => d.dateRange.any)}
            </button>
            <button type="button" className={styles.preset} onClick={() => onChange(presetLast(new Date(), 7))}>
              {t((d) => d.dateRange.last7)}
            </button>
            <button type="button" className={styles.preset} onClick={() => onChange(presetLast(new Date(), 30))}>
              {t((d) => d.dateRange.last30)}
            </button>
            <button type="button" className={styles.preset} onClick={() => onChange(presetThisYear(new Date()))}>
              {t((d) => d.dateRange.thisYear)}
            </button>
            {lastExport != null ? (
              <button
                type="button"
                className={styles.preset}
                onClick={() => onChange({ from: lastExport, to: null })}
              >
                {t((d) => d.dateRange.sinceExport)}
              </button>
            ) : null}
          </div>

          <div className={styles.head}>
            <button
              type="button"
              className={styles.nav}
              aria-label={adjacentLabel(-1)}
              onClick={() => step(-1)}
            >
              <ChevronLeft className={styles.navIcon} aria-hidden="true" />
            </button>
            <span className={styles.month}>{monthLabel}</span>
            <button
              type="button"
              className={styles.nav}
              aria-label={adjacentLabel(1)}
              onClick={() => step(1)}
            >
              <ChevronRight className={styles.navIcon} aria-hidden="true" />
            </button>
          </div>

          <div className={styles.weekdays} aria-hidden="true">
            {weekdays.map((initial, i) => (
              <span key={i} className={styles.weekday}>
                {initial}
              </span>
            ))}
          </div>

          <div className={styles.grid} onMouseLeave={() => setHover(null)}>
            {cells.map((cell) => {
              const cellSec = dayStart(cell);
              const outside = cell.getMonth() !== view.month;
              const endpoint = (lo != null && cellSec === lo) || (hi != null && cellSec === hi);
              const between = lo != null && hi != null && cellSec > lo && cellSec < hi;
              const className = [
                styles.day,
                outside ? styles.outside : "",
                endpoint ? styles.endpoint : "",
                between ? styles.between : "",
                cellSec === todaySec ? styles.today : "",
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <button
                  key={cellSec}
                  type="button"
                  className={className}
                  onClick={() => pickDay(cell)}
                  onMouseEnter={() => (picking ? setHover(cell) : undefined)}
                >
                  {cell.getDate()}
                </button>
              );
            })}
          </div>

          <div className={styles.foot}>
            <button type="button" className={styles.clear} onClick={() => onChange({ from: null, to: null })}>
              {t((d) => d.dateRange.clear)}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
