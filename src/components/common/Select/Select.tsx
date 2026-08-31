// -- Framework Imports --
import { useState, type KeyboardEvent } from "react";

// -- Library Imports --
import { ChevronDown } from "lucide-react";

// -- Component Imports --
import { ScrollArea } from "../ScrollArea/ScrollArea";

// -- Style Imports --
import styles from "./Select.module.css";

/** One choice: a value, its shown label, and an optional quiet suffix like "(default)". */
export interface SelectOption {
  value: string;
  label: string;
  hint?: string;
}

/**
 * A quiet single-select: a field-like trigger that shows the current choice, over a floating listbox
 * of options where the one highlighted row is the sole accent. Presentational - the parent owns the
 * options and what a pick does. `onOpen` fires as the menu opens, so a caller can refresh a list that
 * drifts while the panel sits open. Keyboard mirrors the genre adder: arrows move the highlight, Enter
 * picks, Escape closes; the trigger opens on Enter, Space, or ArrowDown.
 */
export function Select({
  value,
  options,
  onChange,
  ariaLabel,
  onOpen,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);

  const selected = options.find((o) => o.value === value);

  // Seed the highlight on the current value so the open menu lands on what is already chosen.
  const openMenu = () => {
    const i = options.findIndex((o) => o.value === value);
    setHighlight(i >= 0 ? i : 0);
    setOpen(true);
    onOpen?.();
  };

  const commit = (index: number) => {
    const option = options[index];
    if (option) onChange(option.value);
    setOpen(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      commit(highlight);
    } else if (e.key === "Escape") {
      e.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <div className={styles.wrap}>
      <button
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        className={styles.trigger}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
        onBlur={() => setOpen(false)}
      >
        <span className={styles.value}>{selected?.label ?? ""}</span>
        <ChevronDown
          size={16}
          className={open ? `${styles.chevron} ${styles.chevronOpen}` : styles.chevron}
        />
      </button>

      {open ? (
        <div className={styles.menu}>
          <ScrollArea className={styles.scroll}>
            <ul className={styles.list} role="listbox" aria-label={ariaLabel}>
              {options.map((option, i) => (
                <li key={option.value}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={option.value === value}
                    className={i === highlight ? `${styles.option} ${styles.active}` : styles.option}
                    // Keep focus on the trigger so its blur does not close the menu before the click lands.
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setHighlight(i)}
                    onClick={() => commit(i)}
                  >
                    <span className={styles.label}>{option.label}</span>
                    {option.hint ? <span className={styles.hint}>{option.hint}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          </ScrollArea>
        </div>
      ) : null}
    </div>
  );
}
