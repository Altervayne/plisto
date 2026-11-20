// -- Framework Imports --
import { useMemo } from "react";

// -- Icon Imports --
import { Info } from "lucide-react";

// -- Component Imports --
import { StampBanner, StampBigLine, StampCounters, StampFileList, StampLabel, StampReasonGroup } from "./StampRows";

// -- Utils Imports --
import { isSkip } from "../../lib/stampShape";
import type { FlowSummary, ResultsView } from "../../lib/stampShape";
import type { RunProgress } from "../../lib/stampFlow";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Type Imports --
import type { TrackRef } from "../../types";

/**
 * The body of a finished write: the headline and tallies, what a stop left unstarted, then the failed,
 * skipped and written files. In-use and failed files carry Retry. When no restore point could be saved
 * the write never ran, and the sheet says only that.
 */
export function StampResults({
  summary,
  view,
  run,
  onRetry,
}: {
  summary: FlowSummary;
  view: ResultsView;
  /** The finished run, for the "stopped after" line. */
  run: RunProgress | null;
  /** Absent when the batch has no real id, so Retry is not offered. */
  onRetry: ((tracks: TrackRef[]) => void) | undefined;
}) {
  const t = useT();
  // One stable callback, so a group that did not change is not redrawn when another one does.
  const retry = useMemo(() => (onRetry ? (tracks: TrackRef[]) => onRetry(tracks) : undefined), [onRetry]);

  if (summary.pointSaved === false && view.written.length === 0) {
    return <StampBigLine>{t((d) => d.fileWrites.run.pointNotSaved)}</StampBigLine>;
  }

  return (
    <>
      <StampBigLine>
        {summary.cancelled
          ? t((d) => d.fileWrites.run.stoppedTitle, { i: run?.done ?? view.written.length, n: run?.total ?? 0 })
          : t((d) => d.fileWrites.run.wrote, { n: view.written.length })}
      </StampBigLine>
      <StampCounters written={view.written.length} skipped={view.skippedCount} failed={view.failed.length} />

      {summary.cancelled ? (
        <>
          <StampBanner icon={<Info size={16} strokeWidth={1.8} aria-hidden="true" />}>
            {t((d) => d.fileWrites.run.stoppedInfo, { n: view.notStarted.length })}
          </StampBanner>
          {view.notStarted.length > 0 ? (
            <>
              <StampLabel>{t((d) => d.fileWrites.run.notStarted, { n: view.notStarted.length })}</StampLabel>
              <StampFileList tracks={view.notStarted} flat />
            </>
          ) : null}
        </>
      ) : null}

      {view.failed.length > 0 ? (
        <>
          <StampLabel>{t((d) => d.fileWrites.run.failedGroup, { n: view.failed.length })}</StampLabel>
          <StampReasonGroup
            reason="failed"
            tracks={view.failed}
            defaultOpen
            hint={t((d) => d.fileWrites.run.failedHint)}
            onRetry={retry}
            retryLabel={t((d) => d.fileWrites.retry)}
          />
        </>
      ) : null}

      {view.skipped.length > 0 && !summary.cancelled ? (
        <>
          <StampLabel>{t((d) => d.fileWrites.run.skippedGroup, { n: view.skippedCount })}</StampLabel>
          {view.skipped.map((group) =>
            isSkip(group.outcome) ? (
              <StampReasonGroup
                key={group.outcome}
                reason={group.outcome}
                tracks={group.tracks}
                defaultOpen
                listFiles={group.outcome !== "unchanged"}
                onRetry={retry}
                retryLabel={t((d) => d.fileWrites.run.retryN, { n: group.tracks.length })}
              />
            ) : null,
          )}
        </>
      ) : null}

      {view.written.length > 0 ? (
        <>
          <StampLabel>{t((d) => d.fileWrites.run.writtenGroup, { n: view.written.length })}</StampLabel>
          <StampFileList tracks={view.written} flat />
        </>
      ) : null}
    </>
  );
}
