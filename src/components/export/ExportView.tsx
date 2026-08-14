// -- Framework Imports --
import { useCallback, useMemo, useState } from "react";

// -- Component Imports --
import { CenteredStage } from "../common/CenteredStage";
import { PrimaryButton } from "../common/PrimaryButton";
import { QuietButton } from "../common/QuietButton";
import { ProgressLine } from "../scan/ProgressLine";
import { ExportReadiness } from "./ExportReadiness";
import { ExportReport } from "./ExportReport";

// -- State Imports --
import { useAlbums, useMembership, useSingles } from "../../state/organize/store";
import { useTracks } from "../../state/store";

// -- IPC Imports --
import {
  cancelExport,
  createExportChannel,
  exportLibrary,
  validateExportDestination,
} from "../../lib/ipc";

// -- Utils Imports --
import { pickFolder } from "../../lib/dialog";
import { openFolder } from "../../lib/opener";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Type Imports --
import type { DestinationCheck, ExportProgress, ExportSummary } from "../../types";

// -- Style Imports --
import styles from "./ExportView.module.css";

/** Which of the three screens is showing: pick-and-confirm, the live run, or the report. */
type Phase = "idle" | "running" | "done";

/**
 * The export screen: a three-state centered column twinning the scan view. Idle picks and validates a
 * destination and discloses readiness; running streams determinate progress off the export channel;
 * done reads a persistent report. The single solid accent moves with the state - the idle Export CTA,
 * then the progress fill, then nothing (the good dot carries done). A destination inside the workspace
 * is refused; a non-empty one takes a two-step confirm before writing.
 */
export function ExportView() {
  const albums = useAlbums();
  const singles = useSingles();
  const membership = useMembership();
  const tracks = useTracks();
  const t = useT();

  const [phase, setPhase] = useState<Phase>("idle");
  const [destination, setDestination] = useState<string | null>(null);
  const [check, setCheck] = useState<DestinationCheck | null>(null);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [summary, setSummary] = useState<ExportSummary | null>(null);
  const [confirming, setConfirming] = useState(false);

  // Readiness counts derive from the organize projection: album members are the exportable tracks,
  // singles are their own bucket, unsorted is a track with no membership, missing is a gone source.
  const counts = useMemo(() => {
    const albumIds = new Set(albums.map((a) => a.id));
    const memberIds = new Set(membership.map((m) => m.track_id));
    const albumTracks = membership.filter((m) => albumIds.has(m.album_id)).length;
    const unsorted = tracks.filter((tr) => !memberIds.has(tr.id) && tr.missing_at == null).length;
    const missing = tracks.filter((tr) => tr.missing_at != null).length;
    return {
      albums: albums.length,
      tracks: albumTracks,
      singles: singles.length,
      unsorted,
      missing,
      exportable: membership.length,
    };
  }, [albums, singles, membership, tracks]);

  const onPick = useCallback(async () => {
    const picked = await pickFolder();
    if (!picked) return;
    setDestination(picked);
    setConfirming(false);
    try {
      setCheck(await validateExportDestination(picked));
    } catch {
      setCheck(null);
    }
  }, []);

  const runExport = useCallback(async () => {
    if (!destination) return;
    setConfirming(false);
    setProgress(null);
    setSummary(null);
    setPhase("running");

    const channel = createExportChannel((tick) => {
      // exported is monotonic on the backend; guard an out-of-order tick from regressing it.
      setProgress((prev) => {
        const exported = prev ? Math.max(prev.exported, tick.exported) : tick.exported;
        return { ...tick, exported };
      });
    });

    try {
      setSummary(await exportLibrary(destination, channel));
      setPhase("done");
    } catch {
      // A destination that went invalid mid-run drops back to idle; the source is untouched.
      setPhase("idle");
    }
  }, [destination]);

  // A non-empty destination arms a two-step confirm; otherwise the click runs straight away.
  const onExport = useCallback(() => {
    if (check?.non_empty) {
      setConfirming(true);
      return;
    }
    void runExport();
  }, [check, runExport]);

  const onAgain = useCallback(() => {
    setSummary(null);
    setProgress(null);
    setConfirming(false);
    setPhase("idle");
  }, []);

  if (phase === "running") {
    const total = progress?.total ?? 0;
    const exported = progress?.exported ?? 0;
    const errors = progress?.errors ?? 0;
    const value = total > 0 ? exported / total : null;
    return (
      <CenteredStage>
        <div className={styles.body}>
          <h1 className={styles.title}>{t((d) => d.export.exporting)}</h1>
          {destination ? (
            <p className={styles.path} title={destination}>
              {destination}
            </p>
          ) : null}
          <ProgressLine value={value} />
          <div className={`${styles.counters} tabular`}>
            <span>
              {exported} / {total}
            </span>
            {errors > 0 ? (
              <span className={styles.tally}>{t((d) => d.export.errors, { n: errors })}</span>
            ) : null}
          </div>
          <div className={styles.foot}>
            <QuietButton onClick={() => void cancelExport()}>
              {t((d) => d.export.cancel)}
            </QuietButton>
          </div>
        </div>
      </CenteredStage>
    );
  }

  if (phase === "done" && summary) {
    return (
      <CenteredStage>
        <div className={styles.body}>
          <span className={styles.dot} aria-hidden="true" />
          <h1 className={styles.title}>{t((d) => d.export.exported)}</h1>
          <ExportReport summary={summary} />
          <div className={styles.actions}>
            {destination ? (
              <QuietButton onClick={() => void openFolder(destination)}>
                {t((d) => d.export.openFolder)}
              </QuietButton>
            ) : null}
            <QuietButton onClick={onAgain}>{t((d) => d.export.again)}</QuietButton>
          </div>
        </div>
      </CenteredStage>
    );
  }

  const canExport = !!destination && !!check?.ok && counts.exportable > 0;
  return (
    <CenteredStage>
      <div className={styles.body}>
        <h1 className={styles.title}>{t((d) => d.export.title)}</h1>
        <div className={styles.dest}>
          {destination ? (
            <p className={styles.path} title={destination}>
              {destination}
            </p>
          ) : null}
          <QuietButton onClick={() => void onPick()}>{t((d) => d.export.chooseFolder)}</QuietButton>
        </div>

        {check?.inside_workspace ? (
          <p className={styles.warn}>{t((d) => d.export.insideWorkspace)}</p>
        ) : null}

        {check?.ok ? (
          <ExportReadiness
            albums={counts.albums}
            tracks={counts.tracks}
            singles={counts.singles}
            unsorted={counts.unsorted}
            missing={counts.missing}
          />
        ) : null}

        {confirming ? (
          <div className={styles.confirm}>
            <span className={styles.warn}>{t((d) => d.export.nonEmpty)}</span>
            <PrimaryButton onClick={() => void runExport()}>
              {t((d) => d.export.confirm)}
            </PrimaryButton>
            <QuietButton onClick={() => setConfirming(false)}>
              {t((d) => d.export.cancel)}
            </QuietButton>
          </div>
        ) : (
          <>
            {check?.ok && check.non_empty ? (
              <p className={styles.warn}>{t((d) => d.export.nonEmpty)}</p>
            ) : null}
            <div className={styles.foot}>
              <PrimaryButton onClick={onExport} disabled={!canExport}>
                {t((d) => d.export.action)}
              </PrimaryButton>
            </div>
          </>
        )}
      </div>
    </CenteredStage>
  );
}
