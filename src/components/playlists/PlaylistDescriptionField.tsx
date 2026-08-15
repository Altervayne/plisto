// -- Framework Imports --
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

// -- Style Imports --
import styles from "./PlaylistDescriptionField.module.css";

/**
 * A multi-line description field that reads as typography, not a boxed input - the textarea twin of
 * EditableField. The draft buffers keystrokes locally and commits once on blur when the trimmed value
 * differs from the committed one; Enter stays a newline here, so only blur commits. Escape reverts to the
 * committed value and commits nothing. A committed change from elsewhere re-seeds the draft. The caller
 * maps an empty commit to null.
 */
export function PlaylistDescriptionField({
  value,
  onCommit,
  placeholder,
  ariaLabel,
}: {
  value: string;
  onCommit: (next: string) => void;
  placeholder?: string;
  ariaLabel: string;
}) {
  const [draft, setDraft] = useState(value);
  const reverting = useRef(false);

  useEffect(() => setDraft(value), [value]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed !== value) onCommit(trimmed);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      // Keep the view open: while the field is focused, Escape reverts the field, nothing more.
      e.stopPropagation();
      reverting.current = true;
      setDraft(value);
      e.currentTarget.blur();
    }
  };

  const onBlur = () => {
    if (reverting.current) reverting.current = false;
    else commit();
  };

  return (
    <textarea
      className={styles.field}
      value={draft}
      placeholder={placeholder}
      aria-label={ariaLabel}
      spellCheck={false}
      rows={2}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
    />
  );
}
