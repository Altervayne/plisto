// -- Utils Imports --
import { RAIL_LETTERS } from "./browseOrder";
import { groupLabelText } from "./groupLabelText";

// -- Type Imports --
import type { BrowseOrder } from "./browseOrder";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Style Imports --
import styles from "./BrowseRail.module.css";

/**
 * The jump rail under the shelf. Ungrouped or by artist it is the full `#` and A-Z run, a letter with no
 * record dimmed in place so the run never shifts; any other grouping lists the group names. The entry
 * holding the focus is marked.
 */
export function BrowseRail({
  order,
  focus,
  nowYear,
  onJump,
}: {
  order: BrowseOrder;
  focus: number;
  nowYear: number;
  onJump: (index: number) => void;
}) {
  const t = useT();
  const current = order.railKey[focus];

  if (!order.letters) {
    return (
      <div
        className={`${styles.rail} ${styles.names}`}
        role="group"
        aria-label={t((d) => d.collection.browseRailGroups)}
      >
        {order.rail.map((entry) => (
          <button
            key={entry.key}
            type="button"
            className={entry.key === current ? `${styles.entry} ${styles.current}` : styles.entry}
            aria-current={entry.key === current || undefined}
            onClick={() => onJump(entry.index)}
          >
            {entry.label ? groupLabelText(entry.label, t, nowYear) : entry.key}
          </button>
        ))}
      </div>
    );
  }

  const present = new Map(order.rail.map((entry) => [entry.key, entry.index]));
  return (
    <div
      className={styles.rail}
      role="group"
      aria-label={t((d) => d.collection.browseRailLetters)}
    >
      {RAIL_LETTERS.map((letter) => {
        const index = present.get(letter);
        if (index === undefined) {
          return (
            <span key={letter} className={`${styles.entry} ${styles.off}`} aria-hidden="true">
              {letter}
            </span>
          );
        }
        return (
          <button
            key={letter}
            type="button"
            className={letter === current ? `${styles.entry} ${styles.current}` : styles.entry}
            aria-current={letter === current || undefined}
            onClick={() => onJump(index)}
          >
            {letter}
          </button>
        );
      })}
    </div>
  );
}
