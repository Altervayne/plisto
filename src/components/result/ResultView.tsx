// -- Framework Imports --
import { useState } from "react";

// -- Component Imports --
import { EmptyState } from "../common/EmptyState";
import { QuietButton } from "../common/QuietButton";
import { TopBar } from "../topbar/TopBar";
import { ScanSummaryLine } from "../tracks/ScanSummaryLine";
import { TrackDetail } from "../tracks/TrackDetail";
import { TrackGrid } from "../tracks/TrackGrid";

// -- State Imports --
import { useChangeWorkspace, useScanSummary } from "../../state/store";

// -- Type Imports --
import type { TrackRow } from "../../types";

// -- Style Imports --
import styles from "./ResultView.module.css";

/**
 * The view over an indexed workspace: the top area above the grid. A scan that found no audio is
 * its own terminal state, not an empty grid. A row click opens the read-only detail peek beside
 * the grid; it stays a continuous surface, so the grid narrows rather than being covered.
 */
export function ResultView() {
  const summary = useScanSummary();
  const changeWorkspace = useChangeWorkspace();
  const [selected, setSelected] = useState<TrackRow | null>(null);
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
        <TrackGrid
          summary={summary ? <ScanSummaryLine summary={summary} /> : null}
          selectedId={selected?.id ?? null}
          onSelect={setSelected}
        />
        {selected ? (
          <TrackDetail track={selected} onClose={() => setSelected(null)} />
        ) : null}
      </div>
    </div>
  );
}
