// -- Framework Imports --
import { useState } from "react";

// -- Icon Imports --
import { RotateCw } from "lucide-react";

// -- Component Imports --
import { Tooltip } from "../common/Tooltip/Tooltip";

// -- Hook Imports --
import { useDelayedFlag } from "../../hooks/useDelayedFlag";
import { useAddedCaption } from "./useAddedCaption";

// -- State Imports --
import {
  useGoneCount,
  useOfflineRoots,
  useQuietCheckFailed,
  useRescanQuiet,
  useRoots,
  useScanAdded,
  useScanCheckedAt,
  useScanMode,
  useScanProgress,
  useScanStatus,
} from "../../state/store";
import { useOpenSettings } from "../../state/shell/store";

// -- Utils Imports --
import { relativeAge } from "../../lib/format";
import { healthReasons } from "./libraryHealth";

// -- i18n Imports --
import { useT } from "../../i18n";
import type { Translate } from "../../i18n";

// -- Type Imports --
import type { LibraryLabel } from "../../state/store";
import type { Root } from "../../types";

// -- Style Imports --
import styles from "./LibraryStatus.module.css";

// A quiet scan shorter than this never spins the glyph, so an instant pass does not flicker.
const SPIN_DELAY_MS = 400;

/** The trailing folder of a path, so the indicator reads as a name rather than a full mono path. */
function folderName(path: string): string {
  const leaf = path.split(/[\\/]/).filter(Boolean).pop();
  return leaf ?? path;
}

/** "Checked 5 min ago", worded in the active locale. */
function checkedLine(t: Translate, atMs: number, nowMs: number): string {
  const age = relativeAge(atMs, nowMs);
  const time =
    age.unit === "now"
      ? t((d) => d.time.justNow)
      : age.unit === "minutes"
        ? t((d) => d.time.minutesAgo, { n: age.n })
        : age.unit === "hours"
          ? t((d) => d.time.hoursAgo, { n: age.n })
          : t((d) => d.time.daysAgo, { n: age.n });
  return t((d) => d.window.checked, { time });
}

/** A tooltip body: a lead line over dimmer detail lines. */
function TipLines({ lead, detail }: { lead?: string; detail: string[] }) {
  return (
    <>
      {lead ? <span className={styles.tipLead}>{lead}</span> : null}
      {detail.map((line) => (
        <span key={line} className={styles.tipDetail}>
          {line}
        </span>
      ))}
    </>
  );
}

/**
 * The idle refresh tooltip. It mounts with each opening of the bubble, so the relative time is read
 * fresh every time it shows.
 */
function IdleTip({ checkedAt, failed }: { checkedAt: number | null; failed: boolean }) {
  const t = useT();
  const [now] = useState(() => Date.now());
  const detail = failed
    ? [t((d) => d.window.checkFailed)]
    : checkedAt != null
      ? [checkedLine(t, checkedAt, now)]
      : [];
  return <TipLines lead={t((d) => d.window.refresh)} detail={detail} />;
}

/** The warn lines for the folder label, one per reason the library is out of sync. */
function reasonLines(
  t: Translate,
  reasons: ReturnType<typeof healthReasons>,
  roots: Root[],
): string[] {
  return reasons.map((reason) => {
    switch (reason.kind) {
      case "offline": {
        const root = reason.rootIds.length === 1 ? roots.find((r) => r.id === reason.rootIds[0]) : null;
        return root
          ? t((d) => d.window.offline, { folder: folderName(root.path) })
          : t((d) => d.window.offlineMany, { n: reason.rootIds.length });
      }
      case "checkFailed":
        return t((d) => d.window.checkFailed);
      case "gone":
        return t((d) => d.tracks.goneSummary, { n: reason.n });
    }
  });
}

/**
 * The title bar's library cluster: a status dot and the folder name, then the refresh glyph. The dot
 * turns warn while the library is out of sync, and its tooltip names why; clicking the label opens
 * Settings. The glyph starts a quiet rescan of every root, spins while one runs past a short grace, and
 * a brief caption counts what a quiet scan added.
 */
export function LibraryStatus({ label }: { label: LibraryLabel }) {
  const t = useT();
  const roots = useRoots();
  const status = useScanStatus();
  const quiet = useScanMode() === "quiet";
  const progress = useScanProgress();
  const checkedAt = useScanCheckedAt();
  const failed = useQuietCheckFailed();
  const offlineRoots = useOfflineRoots();
  const goneCount = useGoneCount();
  const rescanQuiet = useRescanQuiet();
  const openSettings = useOpenSettings();
  const caption = useAddedCaption(useScanAdded());

  const running = status === "scanning" && quiet;
  const spinning = useDelayedFlag(running, SPIN_DELAY_MS);

  const reasons = healthReasons({ offlineRoots, checkFailed: failed, goneCount });
  const lines = reasonLines(t, reasons, roots);
  const path = label.kind === "single" ? label.path : undefined;
  const labelTip =
    path || lines.length > 0 ? <TipLines lead={path} detail={lines} /> : undefined;

  const total = progress?.total ?? 0;
  const refreshTip = running ? (
    <TipLines
      lead={t((d) => d.window.checking)}
      detail={
        total > 0
          ? [t((d) => d.window.checkProgress, { scanned: progress?.scanned ?? 0, total })]
          : []
      }
    />
  ) : (
    <IdleTip checkedAt={checkedAt} failed={failed} />
  );

  return (
    <div className={styles.workspace}>
      <Tooltip label={labelTip}>
        <button type="button" className={styles.label} onClick={openSettings}>
          <span
            className={styles.dot}
            data-warn={reasons.length > 0 ? "" : undefined}
            aria-hidden="true"
          />
          {/* One root reads as its folder name (full path on hover); several as a plain count. */}
          <span className={styles.path}>
            {label.kind === "single"
              ? folderName(label.path)
              : t((d) => d.window.folders, { n: label.count })}
          </span>
        </button>
      </Tooltip>

      <Tooltip label={refreshTip}>
        <button
          type="button"
          className={styles.refresh}
          data-spinning={spinning ? "" : undefined}
          aria-label={t((d) => d.window.refresh)}
          onClick={() => void rescanQuiet()}
        >
          <RotateCw size={14} strokeWidth={1.8} />
        </button>
      </Tooltip>

      {caption.mounted ? (
        <span className={styles.added} data-state={caption.state}>
          {t((d) => d.window.added, { n: caption.n })}
        </span>
      ) : null}
    </div>
  );
}
