// -- Framework Imports --
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

// -- Icon Imports --
import { Check, ListTree } from "lucide-react";

// -- Utils Imports --
import { formatCount } from "../../../lib/format";
import { BROWSE_BYS } from "./browseOrder";
import { GROUP_BY_LABEL } from "./groupLabelText";

// -- Type Imports --
import type { BrowseBy, BrowseKinds } from "./browseOrder";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Style Imports --
import styles from "./BrowseToolbar.module.css";
import menu from "../../tracks/FacetFilter.module.css";

/**
 * Browse's toolbar: the Albums/Singles chips (only when the library holds both kinds), the Group by
 * control in the track grid's group-by grammar, and a readout naming the focused record's place. The
 * chips stay neutral, so the accent keeps to the play affordance.
 */
export function BrowseToolbar({
  kinds,
  counts,
  groupBy,
  readout,
  onToggleKind,
  onGroupBy,
}: {
  kinds: BrowseKinds;
  counts: { albums: number; singles: number };
  groupBy: BrowseBy;
  readout: string;
  onToggleKind: (kind: keyof BrowseKinds) => void;
  onGroupBy: (by: BrowseBy) => void;
}) {
  const t = useT();
  const both = counts.albums > 0 && counts.singles > 0;

  return (
    <div className={styles.toolbar}>
      {both ? (
        <div className={styles.chips} role="group" aria-label={t((d) => d.collection.browseShow)}>
          <button
            type="button"
            className={styles.chip}
            aria-pressed={kinds.albums}
            onClick={() => onToggleKind("albums")}
          >
            {t((d) => d.collection.albums)}
            <span className={styles.count}>{formatCount(counts.albums)}</span>
          </button>
          <button
            type="button"
            className={styles.chip}
            aria-pressed={kinds.singles}
            onClick={() => onToggleKind("singles")}
          >
            {t((d) => d.collection.singles)}
            <span className={styles.count}>{formatCount(counts.singles)}</span>
          </button>
        </div>
      ) : null}
      <GroupByMenu groupBy={groupBy} onChange={onGroupBy} />
      <span className={styles.readout}>{readout}</span>
    </div>
  );
}

/** The Group by trigger and its one-level menu; an outside press or Escape closes it. */
function GroupByMenu({
  groupBy,
  onChange,
}: {
  groupBy: BrowseBy;
  onChange: (by: BrowseBy) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

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

  const title = t((d) => d.collection.browseGroupBy);
  return (
    <div className={menu.wrap} ref={wrapRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        className={open ? `${menu.trigger} ${menu.triggerOpen}` : menu.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ListTree size={15} strokeWidth={1.8} aria-hidden="true" />
        {groupBy === "none" ? title : `${title}: ${t(GROUP_BY_LABEL[groupBy])}`}
      </button>

      {open ? (
        <div className={menu.menu} role="menu">
          <ul className={menu.list}>
            {BROWSE_BYS.map((by) => {
              const active = groupBy === by;
              return (
                <li key={by}>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={active}
                    className={active ? `${menu.row} ${menu.rowActive}` : menu.row}
                    onClick={() => {
                      onChange(by);
                      setOpen(false);
                    }}
                  >
                    <span className={menu.rowLabel}>{t(GROUP_BY_LABEL[by])}</span>
                    {active ? (
                      <Check size={14} strokeWidth={2.4} className={menu.rowIcon} aria-hidden="true" />
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
