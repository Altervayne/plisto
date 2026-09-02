// -- Framework Imports --
import { useEffect } from "react";

// -- Icon Imports --
import { Play, Square } from "lucide-react";

// -- Component Imports --
import { QuietButton } from "../common/QuietButton";

// -- Hook Imports --
import { usePreviewToggle } from "./usePreviewToggle";

// -- State Imports --
import { usePlayerStatus } from "../../state/player/store";

// -- Utils Imports --
import { formatDuration } from "../../lib/format";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./MiniTransport.module.css";

/**
 * The workbench transport: it auditions the source through the engine's transient preview, never the
 * library's queue-replace play. A preview plays from the playhead to the end of the file and stops at
 * the boundary on its own; the Stop control halts it early through the player stop path.
 *
 * A sounding preview is the engine playing with no library track (preview holds `track_id` at null),
 * so its position drives the playhead while it runs. When nothing is auditioning the playhead follows
 * the scrub position the lane reports. `suspendSync` holds that position drive off while the user is
 * scrubbing, so a mid-drag tick never yanks the cursor back.
 */
export function MiniTransport({
  path,
  playheadSecs,
  durationSecs,
  onPlayhead,
  suspendSync = false,
}: {
  path: string;
  playheadSecs: number;
  durationSecs: number;
  onPlayhead: (secs: number) => void;
  suspendSync?: boolean;
}) {
  const t = useT();
  const status = usePlayerStatus();
  const { sounding, toggle } = usePreviewToggle(path, playheadSecs, durationSecs);

  // While a preview sounds, the engine's position is the playhead. Its counter is seeded at the
  // in-point, so the reported seconds are absolute file time. A scrub suspends the drive so the drag wins.
  useEffect(() => {
    if (sounding && !suspendSync) onPlayhead(status.position_secs);
  }, [sounding, suspendSync, status.position_secs, onPlayhead]);

  return (
    <div className={styles.transport}>
      <QuietButton
        onClick={toggle}
        aria-label={sounding ? t((d) => d.splice.stopPreview) : t((d) => d.splice.preview)}
      >
        {sounding ? (
          <Square size={15} strokeWidth={1.8} />
        ) : (
          <Play size={15} strokeWidth={1.8} />
        )}
        <span>{sounding ? t((d) => d.splice.stopPreview) : t((d) => d.splice.preview)}</span>
      </QuietButton>
      <span className={`${styles.elapsed} tabular`}>
        {formatDuration(playheadSecs)} / {formatDuration(durationSecs)}
      </span>
    </div>
  );
}
