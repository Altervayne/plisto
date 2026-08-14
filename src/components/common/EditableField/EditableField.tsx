// -- Framework Imports --
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

// -- Style Imports --
import styles from "./EditableField.module.css";

/**
 * A text field that reads as typography, not a boxed input. The draft buffers keystrokes locally and
 * commits once on blur or Enter when the trimmed value differs from the committed one; Escape reverts
 * to the committed value and commits nothing. A committed change from elsewhere (an external edit, an
 * undo) re-seeds the draft. The caller maps an empty commit to null. `big` is the drawer title face;
 * `onDone` fires after a blur resolves so an inline-edit host can leave its own edit mode.
 */
export function EditableField({
  value,
  onCommit,
  placeholder,
  big = false,
  autoFocus = false,
  onDone,
  ariaLabel,
}: {
  value: string;
  onCommit: (next: string) => void;
  placeholder?: string;
  big?: boolean;
  autoFocus?: boolean;
  onDone?: () => void;
  ariaLabel: string;
}) {
  const [draft, setDraft] = useState(value);
  const reverting = useRef(false);

  useEffect(() => setDraft(value), [value]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed !== value) onCommit(trimmed);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.blur();
    } else if (e.key === "Escape") {
      // Keep the drawer open: while a field is focused, Escape reverts the field, nothing more.
      e.stopPropagation();
      reverting.current = true;
      setDraft(value);
      e.currentTarget.blur();
    }
  };

  const onBlur = () => {
    if (reverting.current) reverting.current = false;
    else commit();
    onDone?.();
  };

  return (
    <input
      type="text"
      className={big ? `${styles.field} ${styles.big}` : styles.field}
      value={draft}
      placeholder={placeholder}
      aria-label={ariaLabel}
      autoFocus={autoFocus}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
    />
  );
}
