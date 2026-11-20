// -- Icon Imports --
import { Info, ShieldCheck } from "lucide-react";

// -- Component Imports --
import { PrimaryButton } from "../common/PrimaryButton";
import { QuietButton } from "../common/QuietButton";

// -- Utils Imports --
import { canWrite } from "../../lib/stampFlow";
import type { FlowState } from "../../lib/stampFlow";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./StampSheet.module.css";

/** What the footer's buttons do; the sheet owns the state behind each. */
export interface StampFooterActions {
  close: () => void;
  write: () => void;
  stop: () => void;
  askUndo: () => void;
}

/**
 * The sheet's footer for the phase it is in: the safety line and the actions that fit it. `confirmDead`
 * is a confirm that cannot go on (a failed check or call), which leaves only Close.
 */
export function StampFooter({
  state,
  undoCount,
  canUndo,
  nothing,
  confirmDead,
  actions,
}: {
  state: FlowState;
  undoCount: number;
  canUndo: boolean;
  nothing: boolean;
  confirmDead: boolean;
  actions: StampFooterActions;
}) {
  const t = useT();
  const { phase, run, summary, preview } = state;
  const done = <PrimaryButton onClick={actions.close}>{t((d) => d.fileWrites.done)}</PrimaryButton>;

  if (phase === "running") {
    return (
      <>
        <span className={styles.safety}>{t((d) => d.fileWrites.run.footRunning)}</span>
        <QuietButton onClick={actions.stop} disabled={run?.stopping}>
          {run?.stopping ? t((d) => d.fileWrites.run.stopping) : t((d) => d.fileWrites.run.stop)}
        </QuietButton>
      </>
    );
  }
  if (phase === "undoing") return <span className={styles.safety}>{t((d) => d.fileWrites.run.titleUndoing)}</span>;
  if (phase === "undone") {
    return (
      <>
        <span className={styles.safety}>{t((d) => d.fileWrites.run.undoneFoot)}</span>
        {done}
      </>
    );
  }
  if (phase === "results") {
    return (
      <>
        <span className={styles.safety}>
          {summary?.cancelled ? (
            t((d) => d.fileWrites.run.undoUntil)
          ) : (
            <>
              <Info className={styles.safetyIcon} size={13} strokeWidth={1.8} aria-hidden="true" />
              {t((d) => d.fileWrites.run.doneFoot)}
            </>
          )}
        </span>
        {canUndo ? (
          <QuietButton onClick={actions.askUndo}>
            {summary?.cancelled
              ? t((d) => d.fileWrites.run.undoStopped, { n: undoCount })
              : t((d) => d.fileWrites.run.undoThis)}
          </QuietButton>
        ) : null}
        {done}
      </>
    );
  }
  if (nothing || confirmDead) {
    return (
      <>
        <span className={styles.safety}>{nothing ? t((d) => d.fileWrites.stamp.nothingFoot) : null}</span>
        <PrimaryButton onClick={actions.close}>{t((d) => d.fileWrites.close)}</PrimaryButton>
      </>
    );
  }
  return (
    <>
      <span className={styles.safety}>
        <ShieldCheck className={styles.safetyIcon} size={13} strokeWidth={1.8} aria-hidden="true" />
        {t((d) => d.fileWrites.stamp.footer)}
      </span>
      <QuietButton onClick={actions.close}>{t((d) => d.fileWrites.cancel)}</QuietButton>
      <PrimaryButton onClick={actions.write} disabled={!canWrite(state)}>
        {t((d) => d.fileWrites.stamp.write, { n: preview?.files.length ?? 0 })}
      </PrimaryButton>
    </>
  );
}
