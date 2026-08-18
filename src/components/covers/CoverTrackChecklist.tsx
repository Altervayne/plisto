// -- Framework Imports --
import { useState } from "react";

// -- Icon Imports --
import { Check, X } from "lucide-react";

// -- Component Imports --
import { Cover } from "../common/Cover/Cover";
import { PrimaryButton } from "../common/PrimaryButton";
import { Tooltip } from "../common/Tooltip/Tooltip";

// -- Hook Imports --
import { useTrackThumb, invalidateTrackThumb } from "./useTrackThumb";

// -- IPC Imports --
import { importTrackCover } from "../../lib/ipc";

// -- Type Imports --
import type { TrackRow } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./CoverTrackChecklist.module.css";

/** A track's display title: the edited value, then the scanned tag, then its filename. */
function trackTitle(track: TrackRow): string {
  return track.title_edit ?? track.raw_title ?? track.filename;
}

/**
 * The inline checklist the row expands into for "Set on specific tracks". Each of the folder's tracks
 * shows its current cover so the bare ones stand out; checking a subset and confirming binds the chosen
 * image onto exactly those tracks. The one solid accent in this view lives on the confirm here, never on
 * the wall. This is the multi-select cover model from the album drawer, minus the disk dialog - the
 * image is already chosen.
 */
export function CoverTrackChecklist({
  tracks,
  imagePath,
  onClose,
}: {
  tracks: TrackRow[];
  imagePath: string;
  onClose: () => void;
}) {
  const t = useT();
  const [selected, setSelected] = useState<Set<number>>(() => new Set());

  // The chosen image's own filename, shown at the head so its name is one more cue for matching it to
  // the right tracks - the same info the tile carries, kept in view while the subset is picked.
  const fileName = imagePath.split(/[\\/]/).pop() ?? imagePath;

  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  };

  // Binds the picked image onto the checked tracks, drops their cached thumbnails so a reopened checklist
  // shows the fresh art, then closes. A per-track cover resolves backend-side, so nothing else reloads.
  const apply = async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    await importTrackCover(ids, imagePath);
    ids.forEach(invalidateTrackThumb);
    onClose();
  };

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <div className={styles.heading}>
          <span className={styles.title}>{t((d) => d.covers.checklistTitle)}</span>
          <Tooltip label={fileName}>
            <span className={styles.imageName}>{fileName}</span>
          </Tooltip>
        </div>
        <button
          type="button"
          className={styles.close}
          onClick={onClose}
          aria-label={t((d) => d.common.close)}
        >
          <X size={15} strokeWidth={1.9} />
        </button>
      </div>

      <div className={styles.list}>
        {tracks.map((track) => (
          <ChecklistRow
            key={track.id}
            track={track}
            checked={selected.has(track.id)}
            onToggle={() => toggle(track.id)}
          />
        ))}
      </div>

      <div className={styles.foot}>
        <PrimaryButton onClick={() => void apply()} disabled={selected.size === 0}>
          {t((d) => d.covers.apply, { n: selected.size })}
        </PrimaryButton>
      </div>
    </div>
  );
}

/** One checklist row: the track's current cover thumb, its title, and a checkbox toggling its selection. */
function ChecklistRow({
  track,
  checked,
  onToggle,
}: {
  track: TrackRow;
  checked: boolean;
  onToggle: () => void;
}) {
  const thumb = useTrackThumb(track.id);

  return (
    <button
      type="button"
      className={`${styles.row} ${checked ? styles.checked : ""}`}
      role="checkbox"
      aria-checked={checked}
      onClick={onToggle}
    >
      <span className={styles.thumb}>
        <Cover src={thumb} alt="" />
      </span>
      <span className={styles.name}>{trackTitle(track)}</span>
      <span className={styles.box} aria-hidden="true">
        {checked ? <Check size={13} strokeWidth={2.4} /> : null}
      </span>
    </button>
  );
}
