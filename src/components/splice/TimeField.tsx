// -- Framework Imports --
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

// -- Utils Imports --
import { formatTimecode, parseTimecode } from "../../lib/splice";

// -- Style Imports --
import styles from "./TimeField.module.css";

/**
 * The editable start time of a cut, reading as typography like the title field. The draft buffers
 * keystrokes and commits on blur or Enter; a value that parses becomes a frame the caller lands, and
 * the field re-seeds from the committed frame so the snapped time shows with no typed-in precision.
 * A value that does not parse reverts to the current time and commits nothing. Escape reverts too.
 * EditableField cannot be reused here: it only re-seeds when its string value changes, so an invalid
 * entry that leaves the frame untouched would strand the bad text - this field parses and reverts itself.
 */
export function TimeField({
  frame,
  sampleRate,
  onCommit,
  ariaLabel,
}: {
  frame: number;
  sampleRate: number;
  onCommit: (frame: number) => void;
  ariaLabel: string;
}) {
  const value = formatTimecode(frame, sampleRate);
  const [draft, setDraft] = useState(value);
  const reverting = useRef(false);

  useEffect(() => setDraft(value), [value]);

  const commit = () => {
    const parsed = parseTimecode(draft, sampleRate);
    // Invalid, or the same frame: drop the draft back to the committed time, no move fired.
    if (parsed === null || parsed === frame) setDraft(value);
    else onCommit(parsed);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.blur();
    } else if (e.key === "Escape") {
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
    <input
      type="text"
      className={`${styles.field} tabular`}
      value={draft}
      aria-label={ariaLabel}
      spellCheck={false}
      inputMode="numeric"
      // The row click toggles its highlight; a click to edit the time should not.
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
    />
  );
}
