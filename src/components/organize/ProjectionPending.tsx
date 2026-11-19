// -- Component Imports --
import { EmptyState } from "../common/EmptyState";
import { PendingSpinner } from "../common/PendingSpinner";
import { QuietButton } from "../common/QuietButton";

// -- State Imports --
import { orgLoader } from "../../state/organize/store";
import { playlistsLoader } from "../../state/playlists/store";

// -- Type Imports --
import type { ProjectionState } from "../../state/projectionStatus";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./ProjectionPending.module.css";

/** Asks both loaders for an immediate attempt. A loader that is already ready ignores it. */
function tryAgain(): void {
  orgLoader.wake();
  playlistsLoader.wake();
}

/**
 * What a view shows in place of albums or playlists while they have not loaded: a quiet spinner once the
 * wait is noticeable, and a warn state with Try again once it has stalled. Renders nothing when ready.
 */
export function ProjectionPending({ state }: { state: ProjectionState }) {
  const t = useT();

  if (state === "ready") return null;

  // One live region spans both states, so the change to stalled is announced.
  return (
    <div className={styles.live} role="status">
      {state === "stalled" ? (
        <EmptyState
          tone="warn"
          title={t((d) => d.projections.stalledTitle)}
          line={t((d) => d.projections.stalledLine)}
          action={<QuietButton onClick={tryAgain}>{t((d) => d.projections.tryAgain)}</QuietButton>}
        />
      ) : (
        <PendingSpinner title={t((d) => d.projections.loadingTitle)} />
      )}
    </div>
  );
}
