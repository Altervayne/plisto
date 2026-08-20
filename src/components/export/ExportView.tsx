// -- Framework Imports --
import { useCallback, useMemo, useState } from "react";

// -- Component Imports --
import { CenteredStage } from "../common/CenteredStage";
import { PrimaryButton } from "../common/PrimaryButton";
import { QuietButton } from "../common/QuietButton";
import { ScrollArea } from "../common/ScrollArea/ScrollArea";
import { Tooltip } from "../common/Tooltip/Tooltip";
import { ProgressLine } from "../scan/ProgressLine";
import { StaffSpinner } from "../scan/StaffSpinner";
import { ExportDestination } from "./ExportDestination";
import { ExportLayout } from "./ExportLayout";
import { ExportReadiness } from "./ExportReadiness";
import { ExportReport } from "./ExportReport";
import { ExportSections } from "./ExportSections";

// -- State Imports --
import { useAlbums, useMembership, useSingles } from "../../state/organize/store";
import { useTracks } from "../../state/store";
import { PREF_KEYS, usePreference, useSetPreference } from "../../state/preferences/store";

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

// -- Local Imports --
import { DEFAULT_PRESET, presetIdFor } from "./templates";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Type Imports --
import type { ExportPreset } from "./templates";
import type { PlaylistShape } from "./ExportSections";
import type { DestinationCheck, ExportProgress, ExportSummary } from "../../types";

// -- Style Imports --
import styles from "./ExportView.module.css";

/** Which of the three screens is showing: pick-and-confirm, the live run, or the report. */
type Phase = "idle" | "running" | "done";

/**
 * The export screen. Idle is a titled region: the readiness summary upfront, a destination control, the
 * layout template picker, and the one solid Export CTA footed and dead until a valid destination holds
 * exportable tracks. Running and done stay a centered column - determinate progress, then the report.
 * The single solid accent moves with the state: the idle CTA, the progress fill, then nothing (the good
 * dot carries done). A destination inside the workspace is refused; a non-empty one takes a two-step
 * confirm before writing.
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
  // Custom mode is a UI intent: the picker holds Custom even while its patterns still spell a preset, so
  // the fields stay open until the user leaves them. The persisted patterns remain the source of truth.
  const [customMode, setCustomMode] = useState(false);
  // The three top-level sections and, when playlists are on, the shape each takes. Albums and singles
  // default on (the pre-1.5 shape); playlists opt in, since they duplicate tracks already in an album.
  const [includeAlbums, setIncludeAlbums] = useState(true);
  const [includeSingles, setIncludeSingles] = useState(true);
  const [includePlaylists, setIncludePlaylists] = useState(false);
  const [playlistShape, setPlaylistShape] = useState<PlaylistShape>("mimic");

  const setPreference = useSetPreference();
  // The template is the two persisted album patterns; absent, the Artist/Album default stands in. An
  // empty folder is a real value (the Flat preset), so only a missing key falls to the default.
  const folder = usePreference(PREF_KEYS.exportFolderPattern) ?? DEFAULT_PRESET.folder;
  const file = usePreference(PREF_KEYS.exportFilePattern) ?? DEFAULT_PRESET.file;
  const derivedId = presetIdFor(folder, file);
  const selectedPreset = customMode || derivedId === null ? "custom" : derivedId;

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

  const onSelectPreset = useCallback(
    (preset: ExportPreset) => {
      setCustomMode(false);
      setPreference(PREF_KEYS.exportFolderPattern, preset.folder);
      setPreference(PREF_KEYS.exportFilePattern, preset.file);
    },
    [setPreference],
  );

  const onCustomPatterns = useCallback(
    (nextFolder: string, nextFile: string) => {
      setPreference(PREF_KEYS.exportFolderPattern, nextFolder);
      setPreference(PREF_KEYS.exportFilePattern, nextFile);
    },
    [setPreference],
  );

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

    const sections = {
      albums: includeAlbums,
      singles: includeSingles,
      playlists: includePlaylists,
      playlistShape,
    };

    try {
      setSummary(await exportLibrary(destination, channel, folder, file, sections));
      setPhase("done");
    } catch {
      // A destination that went invalid mid-run drops back to idle; the source is untouched.
      setPhase("idle");
    }
  }, [
    destination,
    folder,
    file,
    includeAlbums,
    includeSingles,
    includePlaylists,
    playlistShape,
  ]);

  const onToggleSection = useCallback(
    (section: "albums" | "singles" | "playlists", value: boolean) => {
      if (section === "albums") setIncludeAlbums(value);
      else if (section === "singles") setIncludeSingles(value);
      else setIncludePlaylists(value);
    },
    [],
  );

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
          <StaffSpinner />
          <h1 className={styles.title}>{t((d) => d.export.exporting)}</h1>
          {destination ? (
            <Tooltip label={destination}>
              <p className={styles.path}>{destination}</p>
            </Tooltip>
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

  // At least one section must be on and hold something to export: an album/single section counts only
  // when the library has that kind, while playlists is taken on trust (an empty playlist set simply
  // writes nothing). All three off leaves nothing to write, so the CTA stays dead.
  const hasContent =
    (includeAlbums && counts.albums > 0) ||
    (includeSingles && counts.singles > 0) ||
    includePlaylists;
  const canExport = !!destination && !!check?.ok && hasContent;
  return (
    <div className={styles.view}>
      <div className={styles.head}>
        <h1 className={styles.title}>{t((d) => d.export.title)}</h1>
        <ExportReadiness
          albums={counts.albums}
          tracks={counts.tracks}
          singles={counts.singles}
          unsorted={counts.unsorted}
          missing={counts.missing}
        />
      </div>

      <ScrollArea className={styles.scroll} contentClassName={styles.sections}>
        <section className={styles.section}>
          <span className={styles.label}>{t((d) => d.export.destination)}</span>
          <ExportDestination destination={destination} onPick={() => void onPick()} />
          {check?.inside_workspace ? (
            <p className={styles.warn}>{t((d) => d.export.insideWorkspace)}</p>
          ) : null}
          {/* A picked destination the probe could not write to: read-only, gone, or otherwise blocked. */}
          {check && !check.inside_workspace && !check.writable ? (
            <p className={styles.warn}>{t((d) => d.export.notWritable)}</p>
          ) : null}
          {check?.ok && check.non_empty ? (
            <p className={styles.warn}>{t((d) => d.export.nonEmpty)}</p>
          ) : null}
          {/* With nothing chosen yet, steer away from the silent dead-end of a USB phone: an MTP device
              has no real path the picker can return, so selecting one reads here as no selection at all. */}
          {!destination ? (
            <p className={styles.hint}>{t((d) => d.export.phoneHint)}</p>
          ) : null}
        </section>

        <section className={styles.section}>
          <span className={styles.label}>{t((d) => d.export.include)}</span>
          <ExportSections
            albums={includeAlbums}
            singles={includeSingles}
            playlists={includePlaylists}
            shape={playlistShape}
            onToggle={onToggleSection}
            onShape={setPlaylistShape}
          />
        </section>

        <section className={styles.section}>
          <span className={styles.label}>{t((d) => d.export.layout)}</span>
          <ExportLayout
            folder={folder}
            file={file}
            selected={selectedPreset}
            onSelectPreset={onSelectPreset}
            onSelectCustom={() => setCustomMode(true)}
            onCustomPatterns={onCustomPatterns}
          />
        </section>
      </ScrollArea>

      <div className={styles.cta}>
        {confirming ? (
          <div className={styles.confirm}>
            <span className={styles.warn}>{t((d) => d.export.nonEmpty)}</span>
            <div className={styles.confirmActions}>
              <PrimaryButton onClick={() => void runExport()}>
                {t((d) => d.export.confirm)}
              </PrimaryButton>
              <QuietButton onClick={() => setConfirming(false)}>
                {t((d) => d.export.cancel)}
              </QuietButton>
            </div>
          </div>
        ) : (
          <PrimaryButton onClick={onExport} disabled={!canExport}>
            {t((d) => d.export.action)}
          </PrimaryButton>
        )}
      </div>
    </div>
  );
}
