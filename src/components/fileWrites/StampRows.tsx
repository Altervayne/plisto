// -- Framework Imports --
import { memo, useState } from "react";
import type { ReactNode } from "react";

// -- Icon Imports --
import { ChevronDown, RotateCw } from "lucide-react";

// -- Component Imports --
import { QuietButton } from "../common/QuietButton";

// -- Utils Imports --
import { groupByRoot, isRetryable } from "../../lib/stampShape";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Type Imports --
import type { SkipReason, StampOutcome, TrackRef } from "../../types";

// -- Style Imports --
import styles from "./StampRows.module.css";

/** Files a list draws before it offers the rest. */
const FILE_PAGE = 100;

/** A note on a tinted ground: an icon and a line, warn-toned when it blocks something. */
export function StampBanner({ icon, warn = false, children }: { icon: ReactNode; warn?: boolean; children: ReactNode }) {
  return (
    <div className={styles.banner}>
      <span className={`${styles.bannerIcon} ${warn ? styles.warn : ""}`}>{icon}</span>
      <span>{children}</span>
    </div>
  );
}

/** The written, skipped and failed tallies of a batch. */
export function StampCounters({ written, skipped, failed }: { written: number; skipped: number; failed: number }) {
  const t = useT();
  return (
    <div className={styles.counters}>
      <span>
        <b>{written.toLocaleString()}</b>
        {t((d) => d.fileWrites.run.counterWritten)}
      </span>
      <span>
        <b>{skipped.toLocaleString()}</b>
        {t((d) => d.fileWrites.run.counterSkipped)}
      </span>
      <span className={failed > 0 ? styles.bad : ""}>
        <b>{failed.toLocaleString()}</b>
        {t((d) => d.fileWrites.run.counterFailed)}
      </span>
    </div>
  );
}

/** The headline of a run view. */
export function StampBigLine({ children }: { children: ReactNode }) {
  return <p className={styles.bigline}>{children}</p>;
}

/** A small uppercase label over a group of rows. */
export function StampLabel({ children }: { children: ReactNode }) {
  return <div className={styles.label}>{children}</div>;
}

/** One file: its title over its path, with an optional note on the right. Memoized so a long list holds still. */
export const StampFileRow = memo(function StampFileRow({
  track,
  what,
  flat = false,
}: {
  track: TrackRef;
  what?: string;
  flat?: boolean;
}) {
  return (
    <div className={`${styles.file} ${flat ? styles.flat : ""}`}>
      <div className={styles.name}>
        <span className={styles.title}>{track.title}</span>
        <span className={styles.path}>{track.relPath}</span>
      </div>
      {what ? <span className={styles.what}>{what}</span> : null}
    </div>
  );
});

/** A list of files that draws a page and offers the rest, so a library-wide list stays light. */
export const StampFileList = memo(function StampFileList({
  tracks,
  flat = false,
  whatOf,
}: {
  tracks: TrackRef[];
  flat?: boolean;
  whatOf?: (track: TrackRef) => string | undefined;
}) {
  const t = useT();
  const [shown, setShown] = useState(FILE_PAGE);
  const rest = tracks.length - shown;
  return (
    <>
      {tracks.slice(0, shown).map((track) => (
        <StampFileRow key={track.trackId} track={track} flat={flat} what={whatOf?.(track)} />
      ))}
      {rest > 0 ? (
        <button type="button" className={styles.more} onClick={() => setShown((n) => n + FILE_PAGE)}>
          {t((d) => d.fileWrites.stamp.showMore, { n: rest })}
        </button>
      ) : null}
    </>
  );
});

/** An offline group as one row per folder, each naming how many tracks are kept as they are. */
function StampOfflineRows({ tracks }: { tracks: TrackRef[] }) {
  const t = useT();
  return (
    <>
      {groupByRoot(tracks).map(({ label, count }) =>
        label == null ? (
          <div key="" className={styles.note}>
            {t((d) => d.fileWrites.stamp.offlineGroup, { n: count })}
          </div>
        ) : (
          <div key={label} className={styles.file}>
            <div className={styles.name}>
              <span className={styles.title}>{label}</span>
              <span className={styles.path}>{t((d) => d.fileWrites.stamp.offlineGroup, { n: count })}</span>
            </div>
          </div>
        ),
      )}
    </>
  );
}

/** The tone of a reason's pill. */
function toneOf(outcome: StampOutcome): "warn" | "bad" | "" {
  if (outcome === "failed") return "bad";
  if (outcome === "unchanged" || outcome === "written" || outcome === "reverted") return "";
  return "warn";
}

/**
 * One skip reason with its files: a pill, the count and the reason's explanation. Collapsed or open by
 * default, and a chevron folds it. `listFiles` false leaves a group with nothing worth listing (Unchanged)
 * as a header alone; `onRetry` adds the Retry button.
 */
export const StampReasonGroup = memo(function StampReasonGroup({
  reason,
  tracks,
  defaultOpen,
  listFiles = true,
  hint,
  onRetry,
  retryLabel,
}: {
  reason: SkipReason;
  tracks: TrackRef[];
  defaultOpen: boolean;
  listFiles?: boolean;
  hint?: string;
  onRetry?: (tracks: TrackRef[]) => void;
  retryLabel?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(defaultOpen);
  const tone = toneOf(reason);
  const expandable = listFiles && tracks.length > 0;
  return (
    <div className={styles.group}>
      <div className={styles.head}>
        {expandable ? (
          <button
            type="button"
            className={styles.toggle}
            data-open={open}
            aria-expanded={open}
            aria-label={t((d) => d.fileWrites.reason[reason].label)}
            onClick={() => setOpen((v) => !v)}
          >
            <ChevronDown size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
        ) : (
          <span className={styles.toggleSpace} />
        )}
        <span className={`${styles.reason} ${tone ? styles[tone] : ""}`}>
          {t((d) => d.fileWrites.reason[reason].label)}
        </span>
        <span className={styles.headText}>
          <b>{tracks.length.toLocaleString()}</b>
          {t((d) => d.fileWrites.reason[reason].text)}
          {hint ? ` ${hint}` : ""}
        </span>
        {onRetry && isRetryable(reason) ? (
          <QuietButton onClick={() => onRetry(tracks)}>
            <RotateCw size={14} strokeWidth={1.8} aria-hidden="true" />
            {retryLabel}
          </QuietButton>
        ) : null}
      </div>
      {expandable && open ? (
        reason === "offline" ? (
          <StampOfflineRows tracks={tracks} />
        ) : (
          <StampFileList tracks={tracks} />
        )
      ) : null}
    </div>
  );
});
