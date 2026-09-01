// -- Framework Imports --
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

// -- Style Imports --
import styles from "./NumberField.module.css";

/**
 * An editable integer that reads as the value beside it, not a boxed input - the cropper's threshold
 * and padding knobs. The draft buffers keystrokes and commits on blur or Enter; a value that parses to
 * a whole number lands, clamped into [min, max]. A value that does not parse reverts to the committed
 * number and commits nothing, so a bad entry never strands. Escape reverts too. A `suffix` rides after
 * the number as a quiet unit label.
 */
export function NumberField({
  value,
  min,
  max,
  suffix,
  onCommit,
  ariaLabel,
}: {
  value: number;
  min: number;
  max: number;
  suffix?: string;
  onCommit: (value: number) => void;
  ariaLabel: string;
}) {
  const text = String(value);
  const [draft, setDraft] = useState(text);
  const reverting = useRef(false);

  useEffect(() => setDraft(text), [text]);

  const commit = () => {
    const parsed = Number(draft.trim());
    if (!Number.isFinite(parsed) || !/^-?\d+$/.test(draft.trim())) {
      setDraft(text);
      return;
    }
    const clamped = Math.min(max, Math.max(min, Math.round(parsed)));
    if (clamped === value) setDraft(text);
    else onCommit(clamped);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.blur();
    } else if (e.key === "Escape") {
      e.stopPropagation();
      reverting.current = true;
      setDraft(text);
      e.currentTarget.blur();
    }
  };

  const onBlur = () => {
    if (reverting.current) reverting.current = false;
    else commit();
  };

  return (
    <span className={styles.wrap}>
      <input
        type="text"
        className={`${styles.field} tabular`}
        value={draft}
        aria-label={ariaLabel}
        spellCheck={false}
        inputMode="numeric"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
      />
      {suffix ? <span className={styles.suffix}>{suffix}</span> : null}
    </span>
  );
}
