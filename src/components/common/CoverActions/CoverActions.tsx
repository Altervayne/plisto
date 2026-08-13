// -- Style Imports --
import styles from "./CoverActions.module.css";

/** One action in the over-art bar: a label and what it does. */
export interface CoverAction {
  label: string;
  onClick: () => void;
}

/**
 * The hover-revealed glass bar over a cover. It overlays the whole tile so a hover or a keyboard
 * focus anywhere on the cover reveals the bar, then holds the action buttons along the bottom.
 * The glass palette here is fixed white-on-translucent by design: it reads over arbitrary album
 * art, not over a themed surface, so it does not draw from the theme tokens.
 */
export function CoverActions({ actions }: { actions: CoverAction[] }) {
  return (
    <div className={styles.overlay}>
      <div className={styles.bar}>
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            className={styles.glassbtn}
            onClick={action.onClick}
          >
            {action.label}
          </button>
        ))}
      </div>
    </div>
  );
}
