// -- Framework Imports --
import { Fragment } from "react";
import type { ReactNode } from "react";

// -- Component Imports --
import { MoreMenu } from "./MoreMenu";

// -- Hook Imports --
import { useActionFold } from "./useActionFold";

// -- Type Imports --
import type { MoreStep } from "./MoreMenu";

// -- Style Imports --
import styles from "./FoldedActions.module.css";

/** One bar action: the button as shown, plus what it becomes as a row of the More menu. */
export interface FoldAction {
  id: string;
  /** Lower stays longer; 1 never folds. */
  keep: number;
  /** Adjacent actions of different groups are parted by a hairline. */
  group: number;
  node: ReactNode;
  /** Stands in for `node` when measuring, for a node that carries a menu of its own. */
  measure?: ReactNode;
  /** The menu row's label. */
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /** A second menu this action opens inside More instead of running. */
  steps?: MoreStep[];
}

/**
 * The action row of a selection bar: the actions in order on one line, the lowest-priority ones folded
 * into a trailing More menu when the bar runs out of room, then the always-visible `trailing` control.
 * `separators` draws hairlines between groups; `up` hangs More above the bar (a floating bar) instead of
 * below; `inset` is the margin the bar keeps from its bounding element, both sides together.
 */
export function FoldedActions({
  actions,
  trailing,
  separators,
  up,
  inset,
  className,
}: {
  actions: FoldAction[];
  trailing: ReactNode;
  separators: boolean;
  up: boolean;
  inset: number;
  className?: string;
}) {
  const { rowRef, ghostRef, fold } = useActionFold(actions, separators, inset);
  const folded = new Set(fold.folded);
  const moreEntries = actions
    .filter((action) => folded.has(action.id))
    .map((action) => ({
      id: action.id,
      label: action.label,
      onSelect: action.onSelect,
      disabled: action.disabled,
      steps: action.steps,
    }));

  return (
    <div ref={rowRef} className={className ? `${styles.row} ${className}` : styles.row}>
      {actions
        .filter((action) => !folded.has(action.id))
        .map((action) => (
          <Fragment key={action.id}>
            {separators && fold.separated.has(action.id) ? (
              <span className={styles.sep} role="separator" aria-orientation="vertical" />
            ) : null}
            {action.node}
          </Fragment>
        ))}
      {moreEntries.length > 0 ? <MoreMenu entries={moreEntries} up={up} /> : null}
      {trailing}

      <div className={styles.clip} aria-hidden="true">
        <div ref={ghostRef} className={styles.ghost} inert>
          {actions.map((action) => (
            <span key={action.id} className={styles.cell} data-fold-id={action.id}>
              {action.measure ?? action.node}
            </span>
          ))}
          <span className={styles.sep} data-fold-sep />
          <span className={styles.cell} data-fold-more>
            <MoreMenu entries={[]} up={up} ghost />
          </span>
          <span className={styles.cell} data-fold-trailing>
            {trailing}
          </span>
        </div>
      </div>
    </div>
  );
}
