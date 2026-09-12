// -- Framework Imports --
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

// -- Icon Imports --
import { Check, ListTree } from "lucide-react";

// -- Utils Imports --
import { FACET_KEYS } from "./trackFacets";
import { FACET_LABEL } from "./FacetFilter";

// -- Type Imports --
import type { GroupDimension } from "./trackFacets";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./FacetFilter.module.css";

/** The group dimensions in menu order: the flat default ahead of the five facets. */
const GROUP_OPTIONS: GroupDimension[] = ["none", ...FACET_KEYS];

/**
 * The grid's group-by control: a quiet trigger naming the active dimension, opening a one-level menu of
 * None plus the five facets. It borrows the facet filter's grammar and styles, so the two toolbar
 * controls read as one family; the active option shows as the accent-weak row with a check, never a solid
 * accent. Escape closes the open menu. Presentational over the store: the parent holds the dimension.
 */
export function GroupByControl({
  groupBy,
  onChange,
}: {
  groupBy: GroupDimension;
  onChange: (groupBy: GroupDimension) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const label = (dim: GroupDimension) =>
    dim === "none" ? t((d) => d.tracks.groupNone) : t(FACET_LABEL[dim]);

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
        onClick={() => setOpen((v) => !v)}
      >
        <ListTree size={15} strokeWidth={1.8} aria-hidden="true" />
        {groupBy === "none" ? t((d) => d.tracks.groupBy) : `${t((d) => d.tracks.groupBy)}: ${label(groupBy)}`}
      </button>

      {open ? (
        <div className={styles.menu} role="menu">
          <ul className={styles.list}>
            {GROUP_OPTIONS.map((dim) => {
              const active = groupBy === dim;
              return (
                <li key={dim}>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={active}
                    className={active ? `${styles.row} ${styles.rowActive}` : styles.row}
                    onClick={() => {
                      onChange(dim);
                      setOpen(false);
                    }}
                  >
                    <span className={styles.rowLabel}>{label(dim)}</span>
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
