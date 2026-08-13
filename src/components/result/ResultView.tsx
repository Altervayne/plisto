// -- Component Imports --
import { EmptyState } from "../common/EmptyState";
import { QuietButton } from "../common/QuietButton";
import { TopBar } from "../topbar/TopBar";

// -- State Imports --
import { useChangeWorkspace, useScanSummary } from "../../state/store";

// -- Style Imports --
import styles from "./ResultView.module.css";

/**
 * The view over an indexed workspace: the top area above the content region. When the scan found
 * no audio it is its own terminal state, not an empty grid. The track grid lands in the content.
 */
export function ResultView() {
  const summary = useScanSummary();
  const changeWorkspace = useChangeWorkspace();
  const count = summary?.total ?? 0;

  if (count === 0) {
    return (
      <EmptyState
        tone="warn"
        title="No audio files here"
        line="This folder holds no tracks Plisto can read. Try another one."
        action={
          <QuietButton onClick={() => void changeWorkspace()}>Change folder</QuietButton>
        }
      />
    );
  }

  return (
    <div className={styles.view}>
      <TopBar />
      <div className={styles.content}>
        <p className={styles.placeholder}>
          {count} {count === 1 ? "track" : "tracks"} indexed. The track grid arrives next.
        </p>
      </div>
    </div>
  );
}
