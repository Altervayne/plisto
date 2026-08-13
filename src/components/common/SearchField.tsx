// -- Style Imports --
import styles from "./SearchField.module.css";

/** A soft-recess search pill: a veil fill that deepens on focus-within, never an accent box. */
export function SearchField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className={styles.field}>
      <input
        type="search"
        className={styles.input}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
