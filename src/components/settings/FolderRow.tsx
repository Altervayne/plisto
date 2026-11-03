// -- Framework Imports --
import { useState } from "react";

// -- Component Imports --
import { QuietButton } from "../common/QuietButton";
import { Tooltip } from "../common/Tooltip/Tooltip";
import { LocatePanel } from "./LocatePanel";

// -- Icon Imports --
import { RotateCw, X } from "lucide-react";

// -- State Imports --
import {
  useBlockingScan,
  useOfflineRoots,
  useRemoveRoot,
  useRescanQuiet,
} from "../../state/store";
import { locateEligible } from "../../state/relocate";

// -- IPC Imports --
import { rootRemovalImpact } from "../../lib/ipc";

// -- Hook Imports --
import { useLocateFlow } from "./useLocateFlow";
import { useMergeHint } from "./useMergeHint";

// -- Utils Imports --
import { folderName, removePrompt } from "./locateCopy";

// -- Type Imports --
import type { Root, RootRemovalImpact } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./FolderRow.module.css";

/**
 * One library root as a quiet row: its folder name over the dimmed full path, the track count trailing,
 * and rescan/remove glyphs that dissolve until the row is hovered. A root the sync reports unreachable,
 * or the last scan skipped, reads Offline before its count, its tracks kept as they were. A root that is
 * offline, or whose tracks are all gone, also carries a persistent Locate button that runs the inline
 * relocate flow beneath the row, and a merge hint when its files already sit in another folder of the
 * library. Remove is never bare - it first reads the removal impact, then arms a counted two-step confirm
 * naming the blast radius before the drop; for a root that may only have moved, that confirm leads with
 * Locate instead.
 */
export function FolderRow({ root }: { root: Root }) {
  const rescanQuiet = useRescanQuiet();
  const removeRoot = useRemoveRoot();
  // A quiet scan never locks the row: a rescan joins it and a remove preempts it.
  const scanning = useBlockingScan();
  const offlineIds = useOfflineRoots();
  const offline = offlineIds.includes(root.id);
  const eligible = locateEligible(root, offlineIds);
  const t = useT();
  const name = folderName(root.path);
  const locate = useLocateFlow(root.id, name);
  const mergeHint = useMergeHint(root);
  const locating = ["checking", "confirm", "running"].includes(locate.step.kind);

  const [impact, setImpact] = useState<RootRemovalImpact | null>(null);

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

  const onLocateInstead = () => {
    setImpact(null);
    locate.start();
  };

  const prompt = impact ? removePrompt(t, impact, { name, offline, eligible }) : "";

  return (
    <div className={styles.rowWrap}>
      <div className={styles.row}>
        <div className={styles.main}>
          <span className={styles.name}>{name}</span>
          <Tooltip label={root.path}>
            <span className={styles.path}>{root.path}</span>
          </Tooltip>
        </div>
        <span className={styles.count}>
          {offline ? <span className={styles.offline}>{t((d) => d.settings.offline)}</span> : null}
          {t((d) => d.settings.trackCount, { n: root.track_count })}
        </span>
        <div className={styles.controls}>
          {eligible ? (
            <QuietButton onClick={locate.start} disabled={scanning || locating}>
              {t((d) => d.settings.locate)}
            </QuietButton>
          ) : null}
          <button
            type="button"
            className={styles.glyph}
            aria-label={t((d) => d.settings.rescan)}
            onClick={() => void rescanQuiet(root.id)}
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

      <LocatePanel
        step={locate.step}
        onConfirm={locate.confirm}
        onRetry={locate.recheck}
        onDismiss={locate.dismiss}
      />

      {mergeHint && locate.step.kind === "idle" ? (
        <div className={styles.confirm}>
          <span className={styles.prompt}>{t((d) => d.settings.locateHint, { folder: mergeHint })}</span>
          <QuietButton onClick={() => locate.checkFolder(mergeHint)} disabled={scanning}>
            {t((d) => d.settings.mergeAction)}
          </QuietButton>
        </div>
      ) : null}

      {impact ? (
        <div className={styles.confirm}>
          <span className={styles.prompt}>{prompt}</span>
          {eligible ? (
            <>
              <QuietButton onClick={onLocateInstead} disabled={scanning}>
                {t((d) => d.settings.locateInstead)}
              </QuietButton>
              <QuietButton destructive onClick={() => void onConfirm()}>
                {t((d) => d.settings.removeAnyway)}
              </QuietButton>
            </>
          ) : (
            <QuietButton onClick={() => void onConfirm()}>
              {t((d) => d.settings.removeAction)}
            </QuietButton>
          )}
          <QuietButton onClick={() => setImpact(null)}>{t((d) => d.common.cancel)}</QuietButton>
        </div>
      ) : null}
    </div>
  );
}
