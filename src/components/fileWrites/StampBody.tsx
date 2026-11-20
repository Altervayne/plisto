// -- Component Imports --
import { StampConfirm } from "./StampConfirm";
import { StampResults } from "./StampResults";
import { StampRunning } from "./StampRunning";
import { StampUndone } from "./StampUndone";

// -- Utils Imports --
import type { FlowState } from "../../lib/stampFlow";
import type { ResultsView, ScopeInfo, UndoneView } from "../../lib/stampShape";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Type Imports --
import type { TrackRef } from "../../types";

// -- Style Imports --
import styles from "./StampSheet.module.css";

/** The views the sheet derives from its state, so the body only chooses among them. */
export interface StampBodyViews {
  results: ResultsView | null;
  undone: UndoneView | null;
  /** The path of the file in hand while a batch runs. */
  current: string | null;
  /** An undo opened from Settings, with no write to list behind its confirm. */
  bare: boolean;
}

/** The sheet's body for the phase it is in. */
export function StampBody({
  state,
  views,
  scope,
  scopeLine,
  confirmDead,
  onRetry,
}: {
  state: FlowState;
  views: StampBodyViews;
  scope: ScopeInfo;
  scopeLine: string;
  confirmDead: boolean;
  onRetry: ((tracks: TrackRef[]) => void) | undefined;
}) {
  const t = useT();
  const { phase, run, summary, preview } = state;
  if (phase === "running" || phase === "undoing") {
    return run ? <StampRunning run={run} current={views.current} /> : null;
  }
  if (phase === "undone") return views.undone ? <StampUndone view={views.undone} /> : null;
  if (phase === "results") {
    return summary && views.results && !views.bare ? (
      <StampResults summary={summary} view={views.results} run={run} onRetry={onRetry} />
    ) : null;
  }
  if (confirmDead) return null;
  if (preview) return <StampConfirm preview={preview} scope={scope} scopeLine={scopeLine} exportHeld={state.exportHeld} />;
  return <p className={styles.sub}>{t((d) => d.fileWrites.stamp.checking)}</p>;
}
