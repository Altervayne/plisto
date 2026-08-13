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

/**
 * The quiet label header. It repaints the fixed ambient ground so rows slide under a seamless
 * continuation of it, separated from the body by space rather than a line. A column click cycles
 * ascending, descending, then off; the active column shows a small direction mark in meta ink.
 */
export function TrackGridHeader({ headers }: { headers: Header<TrackRow, unknown>[] }) {
  return (
    <div className={styles.header}>
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
