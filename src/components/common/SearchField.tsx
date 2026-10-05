// -- Framework Imports --
import type { Ref } from "react";

// -- Style Imports --
import styles from "./SearchField.module.css";

/**
 * A soft-recess search pill: a veil fill that deepens on focus-within, never an accent box. `ref` reaches
 * the input, so a shortcut can focus it.
 */
export function SearchField({
  value,
  onChange,
  placeholder,
  ref,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ref?: Ref<HTMLInputElement>;
}) {
  return (
    <label className={styles.field}>
      <input
        ref={ref}
        type="search"
        className={styles.input}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
