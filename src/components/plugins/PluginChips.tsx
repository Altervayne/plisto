// -- Utils Imports --
import { formatCount } from "../../lib/format";

// -- Type Imports --
import type { PluginChip } from "../../types";

// -- Style Imports --
import styles from "./PluginChips.module.css";

/** The words of one chip: its text, or its count in the app's short number form. */
function chipText(chip: PluginChip): string {
  return chip.text ?? (chip.count != null ? formatCount(chip.count) : "");
}

/**
 * A plugin's chips as quiet text in a rail row. Text is drawn as a text node and the tone only picks one
 * of two fixed classes. A long chip truncates inside the row and keeps its full text as a tooltip.
 */
export function PluginChips({ chips }: { chips: readonly PluginChip[] }) {
  return (
    <>
      {chips.map((chip, i) => {
        const text = chipText(chip);
        const shape = chip.text == null ? styles.count : "";
        const tone = chip.tone === "accent" ? styles.accent : chip.tone === "warn" ? styles.warn : "";
        return (
          <span key={i} className={`${styles.chip} ${shape} ${tone}`} title={text}>
            {text}
          </span>
        );
      })}
    </>
  );
}
