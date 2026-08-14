// -- Library Imports --
import type { Header } from "@tanstack/react-table";

// -- Utils Imports --
import { trackColumns } from "./trackColumns";
import type { TrackColumn } from "./trackColumns";

// -- Type Imports --
import type { TrackRow } from "../../types";

// -- Style Imports --
import styles from "./TrackGridHeader.module.css";

const byId = new Map<string, TrackColumn>(trackColumns.map((col) => [col.id, col]));

/** The select-all box's state over the current view: no rows, some, or every row selected. */
export type SelectAllState = "none" | "some" | "all";

/**
 * The quiet label header. It repaints the fixed ambient ground so rows slide under a seamless
 * continuation of it, separated from the body by space rather than a line. A leading tri-state box
 * mirrors the row checkbox and selects or clears the current view. A column click cycles ascending,
 * descending, then off; the active column shows a small direction mark in meta ink.
 */
export function TrackGridHeader({
  headers,
  selectAll,
  onToggleAll,
}: {
  headers: Header<TrackRow, unknown>[];
  selectAll: SelectAllState;
  onToggleAll: () => void;
}) {
  return (
    <div className={styles.header}>
      <button
        type="button"
        className={styles.check}
        data-state={selectAll}
        role="checkbox"
        aria-checked={selectAll === "all" ? true : selectAll === "some" ? "mixed" : false}
        aria-label={selectAll === "all" ? "Clear selection" : "Select all"}
        onClick={onToggleAll}
      >
        {selectAll === "all" ? <span className={styles.tick} aria-hidden="true" /> : null}
        {selectAll === "some" ? <span className={styles.dash} aria-hidden="true" /> : null}
      </button>

      {headers.map((header) => {
        const col = byId.get(header.column.id);
        const sorted = header.column.getIsSorted();
        const align = col?.align === "right" ? styles.right : styles.left;

        return (
          <button
            key={header.id}
            type="button"
            className={`${styles.label} ${align}`}
            onClick={header.column.getToggleSortingHandler()}
          >
            <span>{col?.header ?? header.column.id}</span>
            {sorted ? (
              <span
                className={`${styles.mark} ${sorted === "asc" ? styles.asc : styles.desc}`}
                aria-hidden="true"
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
