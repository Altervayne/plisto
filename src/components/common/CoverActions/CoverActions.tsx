// -- Icon Imports --
import { Trash2 } from "lucide-react";

// -- Style Imports --
import styles from "./CoverActions.module.css";

/** One action in the over-art bar: a label and what it does. */
export interface CoverAction {
  label: string;
  onClick: () => void;
}

/**
 * The hover-revealed glass overlay over a cover. It spans the whole tile so a hover or a keyboard focus
 * anywhere on the cover reveals its controls: the `actions` sit along the bottom as glass buttons, and an
 * optional `remove` rides the top-right corner as a small destructive icon - kept out of the bottom bar so
 * the primary Replace owns the full width. The glass palette is fixed white-on-translucent by design: it
 * reads over arbitrary album art, not over a themed surface, so it does not draw from the theme tokens.
 */
export function CoverActions({ actions, remove }: { actions: CoverAction[]; remove?: CoverAction }) {
  return (
    <div className={styles.overlay}>
      {remove ? (
        <button
          type="button"
          className={styles.remove}
          onClick={remove.onClick}
          aria-label={remove.label}
          title={remove.label}
        >
          <Trash2 size={15} strokeWidth={1.9} />
        </button>
      ) : null}
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
