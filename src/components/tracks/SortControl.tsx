// -- Framework Imports --
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

// -- Icon Imports --
import { ArrowDown, ArrowDownUp, ArrowUp, Check } from "lucide-react";

// -- Utils Imports --
import { SORT_FIELDS, activeSort, applySort } from "./trackSort";

// -- Type Imports --
import type { SortField } from "./trackSort";
import type { GridSort } from "../../state/store";

// -- i18n Imports --
import { useT } from "../../i18n";
import type { Dict } from "../../i18n/en";

// -- Style Imports --
import styles from "./FacetFilter.module.css";

/** Each sort field's dict label, reusing the peek's field names. Duration reads as the list's Length. */
const SORT_LABEL: Record<SortField, (d: Dict) => string> = {
  title: (d) => d.tracks.fields.title,
  artist: (d) => d.tracks.fields.artist,
  album: (d) => d.tracks.fields.album,
  year: (d) => d.tracks.fields.year,
  duration: (d) => d.tracks.fields.length,
};

/**
 * Card mode's sort control: a quiet trigger opening a one-level menu of the five sort fields over a
 * direction toggle, borrowing the facet filter's grammar and styles so the toolbar controls read as one
 * family. It drives the shared GridSort, so switching back to the list shows the same order under its
 * header; the active field reads as the accent-weak row with a check, never a solid accent. A field with
 * no sort yet picks ascending; picking the active field again is a no-op, the direction toggle flips it.
 * Escape closes the open menu. Presentational over the store: the parent holds the sort.
 */
export function SortControl({
  sort,
  onChange,
}: {
  sort: GridSort;
  onChange: (sort: GridSort) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const current = activeSort(sort);

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

  // Picking a field keeps the current direction; a first pick with nothing sorted lands ascending.
  const pickField = (field: SortField) => onChange(applySort(field, current?.desc ?? false));
  // The direction toggle acts on the active field, falling to the first field when nothing is sorted yet.
  const setDesc = (desc: boolean) => onChange(applySort(current?.field ?? SORT_FIELDS[0], desc));

  const triggerLabel = current
    ? `${t((d) => d.tracks.sort)}: ${t(SORT_LABEL[current.field])}`
    : t((d) => d.tracks.sort);

  return (
    <div className={styles.wrap} ref={wrapRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        className={open ? `${styles.trigger} ${styles.triggerOpen}` : styles.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ArrowDownUp size={15} strokeWidth={1.8} aria-hidden="true" />
        {triggerLabel}
      </button>

      {open ? (
        <div className={styles.menu} role="menu">
          <ul className={styles.list}>
            {SORT_FIELDS.map((field) => {
              const on = current?.field === field;
              return (
                <li key={field}>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={on}
                    className={on ? `${styles.row} ${styles.rowActive}` : styles.row}
                    onClick={() => pickField(field)}
                  >
                    <span className={styles.rowLabel}>{t(SORT_LABEL[field])}</span>
                    {on ? (
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

          <div className={styles.groupDivider} role="separator" />

          <ul className={styles.list}>
            {(
              [
                { desc: false, label: (d: Dict) => d.tracks.sortAscending, icon: ArrowUp },
                { desc: true, label: (d: Dict) => d.tracks.sortDescending, icon: ArrowDown },
              ] as const
            ).map(({ desc, label, icon: Icon }) => {
              const on = (current?.desc ?? false) === desc;
              return (
                <li key={desc ? "desc" : "asc"}>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={on}
                    className={on ? `${styles.row} ${styles.rowActive}` : styles.row}
                    onClick={() => setDesc(desc)}
                  >
                    <span className={`${styles.rowLabel} ${styles.dirLabel}`}>
                      <Icon size={14} strokeWidth={1.8} className={styles.rowLead} aria-hidden="true" />
                      {t(label)}
                    </span>
                    {on ? (
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
