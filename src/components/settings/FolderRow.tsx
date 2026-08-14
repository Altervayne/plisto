// -- Framework Imports --
import { useState } from "react";

// -- Component Imports --
import { QuietButton } from "../common/QuietButton";

// -- Icon Imports --
import { RotateCw, X } from "lucide-react";

// -- State Imports --
import { useLoadRoots, useRemoveRoot, useRescanRoot, useScanStatus } from "../../state/store";

// -- IPC Imports --
import { rootRemovalImpact } from "../../lib/ipc";

// -- Type Imports --
import type { Root, RootRemovalImpact } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./FolderRow.module.css";

/** The trailing folder name of a root path, tolerant of either separator and a trailing slash. */
function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

/**
 * One library root as a quiet row: its folder name over the dimmed full path, the track count trailing,
 * and rescan/remove glyphs that dissolve until the row is hovered. Remove is never bare - it first reads
 * the removal impact, then arms a counted two-step confirm naming the blast radius before the drop.
 */
export function FolderRow({ root }: { root: Root }) {
  const rescanRoot = useRescanRoot();
  const removeRoot = useRemoveRoot();
  const loadRoots = useLoadRoots();
  const scanning = useScanStatus() === "scanning";
  const t = useT();

  const [impact, setImpact] = useState<RootRemovalImpact | null>(null);

  const onRescan = async () => {
    await rescanRoot(root.id);
    // A rescan reloads only the tracks, so refresh the roots to true up this row's count.
    await loadRoots();
  };

  const onRemoveClick = async () => {
    try {
      setImpact(await rootRemovalImpact(root.id));
    } catch {
      setImpact(null);
    }
  };

  const onConfirm = async () => {
    setImpact(null);
    await removeRoot(root.id);
  };

  // The confirm line leads with the question, always names the tracks dropped, then adds only the
  // album clauses that actually bite.
  const prompt = impact
    ? [
        t((d) => d.settings.removeConfirm),
        t((d) => d.settings.removeDrops, { n: impact.tracks }),
        impact.albums_losing_members > 0
          ? t((d) => d.settings.removeLosing, { n: impact.albums_losing_members })
          : null,
        impact.albums_emptied > 0
          ? t((d) => d.settings.removeEmptied, { n: impact.albums_emptied })
          : null,
      ]
        .filter(Boolean)
        .join(" ")
    : "";

  return (
    <div className={styles.rowWrap}>
      <div className={styles.row}>
        <div className={styles.main}>
          <span className={styles.name}>{folderName(root.path)}</span>
          <span className={styles.path} title={root.path}>
            {root.path}
          </span>
        </div>
        <span className={styles.count}>
          {t((d) => d.settings.trackCount, { n: root.track_count })}
        </span>
        <div className={styles.controls}>
          <button
            type="button"
            className={styles.glyph}
            aria-label={t((d) => d.settings.rescan)}
            onClick={() => void onRescan()}
            disabled={scanning}
          >
            <RotateCw size={15} strokeWidth={1.8} />
          </button>
          <button
            type="button"
            className={`${styles.glyph} ${styles.remove}`}
            aria-label={t((d) => d.settings.remove)}
            onClick={() => void onRemoveClick()}
            disabled={scanning}
          >
            <X size={16} strokeWidth={1.8} />
          </button>
        </div>
      </div>

      {impact ? (
        <div className={styles.confirm}>
          <span className={styles.prompt}>{prompt}</span>
          <QuietButton onClick={() => void onConfirm()}>
            {t((d) => d.settings.removeAction)}
          </QuietButton>
          <QuietButton onClick={() => setImpact(null)}>{t((d) => d.common.cancel)}</QuietButton>
        </div>
      ) : null}
    </div>
  );
}
