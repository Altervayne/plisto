// -- Framework Imports --
import { useState } from "react";

// -- Component Imports --
import { EditableField } from "../common/EditableField/EditableField";

// -- Style Imports --
import styles from "./GenreChip.module.css";

/**
 * The album genre as a single chip: an accent-weak pill when set, or a ghost "+ add genre" recess when
 * empty. Clicking enters inline edit through the text field; committing empty clears the genre. The
 * schema holds one genre value, so this is one chip - a multi-genre list would need a schema change.
 */
export function GenreChip({
  value,
  onCommit,
}: {
  value: string | null;
  onCommit: (next: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <EditableField
        value={value ?? ""}
        ariaLabel="Genre"
        placeholder="Genre"
        autoFocus
        onDone={() => setEditing(false)}
        onCommit={(next) => onCommit(next === "" ? null : next)}
      />
    );
  }

  if (value == null) {
    return (
      <button type="button" className={styles.ghost} onClick={() => setEditing(true)}>
        + add genre
      </button>
    );
  }

  return (
    <button type="button" className={styles.chip} onClick={() => setEditing(true)}>
      {value}
    </button>
  );
}
