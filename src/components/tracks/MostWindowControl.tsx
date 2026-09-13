// -- Framework Imports --
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

// -- Icon Imports --
import { CalendarRange, Check } from "lucide-react";

// -- i18n Imports --
import { useT } from "../../i18n";
import type { Dict } from "../../i18n/en";

// -- Style Imports --
import styles from "./FacetFilter.module.css";

/** The rolling ranking windows in menu order: all-time ahead of the two cutoffs. */
export type MostWindow = "all" | "last30" | "last365";

const WINDOW_OPTIONS: MostWindow[] = ["all", "last30", "last365"];

const WINDOW_LABEL: Record<MostWindow, (d: Dict) => string> = {
  all: (d) => d.history.windowAll,
  last30: (d) => d.history.window30,
  last365: (d) => d.history.window365,
};

/**
 * The most-played window picker: a quiet trigger naming the active window, opening a one-level menu of
 * all-time over the two rolling cutoffs. It borrows the facet filter's grammar and styles so it reads
 * with the header's other menu buttons rather than a third wide toggle; the active window shows as the
 * accent-weak row with a check, never a solid accent. Escape closes the open menu. Presentational over
 * the parent: the parent holds the window.
 */
export function MostWindowControl({
  value,
  onChange,
}: {
  value: MostWindow;
  onChange: (value: MostWindow) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // While open, an outside press dismisses the menu.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && open) {
      event.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <div className={styles.wrap} ref={wrapRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        className={open ? `${styles.trigger} ${styles.triggerOpen}` : styles.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t((d) => d.history.windowLabel)}
        onClick={() => setOpen((v) => !v)}
      >
        <CalendarRange size={15} strokeWidth={1.8} aria-hidden="true" />
        {t(WINDOW_LABEL[value])}
      </button>

      {open ? (
        <div className={styles.menu} role="menu">
          <ul className={styles.list}>
            {WINDOW_OPTIONS.map((window) => {
              const active = value === window;
              return (
                <li key={window}>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={active}
                    className={active ? `${styles.row} ${styles.rowActive}` : styles.row}
                    onClick={() => {
                      onChange(window);
                      setOpen(false);
                    }}
                  >
                    <span className={styles.rowLabel}>{t(WINDOW_LABEL[window])}</span>
                    {active ? (
                      <Check
                        size={14}
                        strokeWidth={2.4}
                        className={styles.rowIcon}
                        aria-hidden="true"
                      />
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
