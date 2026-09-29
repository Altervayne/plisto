// -- Framework Imports --
import { useCallback, useMemo, useState } from "react";

// -- Component Imports --
import { CenteredStage } from "../common/CenteredStage";
import { QuietButton } from "../common/QuietButton";
import { ScrollArea } from "../common/ScrollArea/ScrollArea";
import { SegmentedControl } from "../common/SegmentedControl";
import { Tooltip } from "../common/Tooltip/Tooltip";
import { ProgressLine } from "../scan/ProgressLine";
import { StaffSpinner } from "../scan/StaffSpinner";
import { ExportActions } from "./ExportActions";
import { ExportDestination } from "./ExportDestination";
import { ExportLayout } from "./ExportLayout";
import { ExportReadiness } from "./ExportReadiness";
import { ExportReport } from "./ExportReport";
import { ExportScope } from "./ExportScope";
import { ExportSections } from "./ExportSections";

// -- Hook Imports --
import { useExportChanges } from "./useExportChanges";

// -- State Imports --
import { useAlbums, useMembership, useSingles } from "../../state/organize/store";
import { useTracks } from "../../state/store";
import { PREF_KEYS, usePreference, useSetPreference } from "../../state/preferences/store";

// -- IPC Imports --
import {
  adoptExportDestination,
  cancelExport,
  checkDevice,
  createExportChannel,
  exportConfig,
  exportLibrary,
  pickDeviceFolder,
  validateExportDestination,
} from "../../lib/ipc";

// -- Utils Imports --
import { pickFolder } from "../../lib/dialog";
import { openFolder } from "../../lib/opener";

// -- Local Imports --
import { scopeState, showsChangedCounts } from "./scopeState";
import { DEFAULT_PRESET, presetIdFor } from "./templates";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Type Imports --
import type { ExportScope as Scope } from "./scopeState";
import type { ExportPreset } from "./templates";
import type { PlaylistShape } from "./ExportSections";
import type { DestinationCheck, ExportProgress, ExportSummary, ExportTarget } from "../../types";

// -- Style Imports --
import styles from "./ExportView.module.css";

/** Which of the three screens is showing: pick-and-confirm, the live run, or the report. */
type Phase = "idle" | "running" | "done";

/**
 * The export screen. Idle is a titled region: the readiness summary upfront, a destination control, the
 * layout template picker, and the solid Export CTA, dead until a valid destination holds exportable
 * tracks. Running and done stay a centered column - determinate progress, then the report. A destination
 * inside the workspace is refused; a non-empty one takes a two-step confirm before writing. The
 * changed-only scope previews what a run would write against the destination's own export record.
 */
export function ExportView() {
  const albums = useAlbums();
  const singles = useSingles();
  const membership = useMembership();
  const tracks = useTracks();
  const t = useT();

  const [phase, setPhase] = useState<Phase>("idle");
  const [target, setTarget] = useState<ExportTarget | null>(null);
  const [check, setCheck] = useState<DestinationCheck | null>(null);
  // A failed run's reason, shown on the idle screen. Cleared on a fresh pick or a new run.
  const [error, setError] = useState<string | null>(null);
  // Device mode: false drops a dated snapshot folder on the phone, true merges the export into the
  // picked folder in place (incremental update). Only surfaced once a device is the target.
  const [deviceInPlace, setDeviceInPlace] = useState(false);
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
  const [scope, setScope] = useState<Scope>("all");
  const [adopting, setAdopting] = useState(false);

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

  // A dated device snapshot lands in a fresh folder every time, so it has nothing to diff against.
  const datedSnapshot = target?.kind === "device" && !deviceInPlace;
  const changedOnly = scope === "changed" && !datedSnapshot;

  const options = useMemo(
    () => ({
      albums: includeAlbums,
      singles: includeSingles,
      playlists: includePlaylists,
      playlistShape,
      deviceInPlace,
      changedOnly,
    }),
    [includeAlbums, includeSingles, includePlaylists, playlistShape, deviceInPlace, changedOnly],
  );

  // The preview reads the exact config the run would send, so its counts match what Export writes.
  const previewConfig = useMemo(
    () => (target && changedOnly ? exportConfig(target, folder, file, options) : null),
    [target, changedOnly, folder, file, options],
  );
  const { changes, refresh } = useExportChanges(previewConfig);
  const scopeView = scopeState(scope, changes, datedSnapshot, !!check?.non_empty);
  // Merging into a recorded export is the point of a changed-only run, so its non-empty caution and
  // confirm stand down; a full export keeps them.
  const mergesIntoRecord = changedOnly && !!changes?.has_record;

  const onPickFolder = useCallback(async () => {
    const picked = await pickFolder();
    if (!picked) return;
    setTarget({ kind: "folder", path: picked });
    setConfirming(false);
    setError(null);
    try {
      setCheck(await validateExportDestination(picked));
    } catch {
      setCheck(null);
    }
  }, []);

  const onPickDevice = useCallback(async () => {
    const picked = await pickDeviceFolder();
    if (!picked) return;
    setTarget({ kind: "device", target: picked });
    setConfirming(false);
    setError(null);
    if (!deviceInPlace) setScope("all");
    try {
      setCheck(await checkDevice(picked.pidl));
    } catch {
      setCheck(null);
    }
  }, [deviceInPlace]);

  // A dated snapshot always holds everything, so switching to one drops a changed-only scope.
  const onDeviceMode = useCallback((mode: "snapshot" | "inplace") => {
    setDeviceInPlace(mode === "inplace");
    if (mode === "snapshot") setScope("all");
  }, []);

  const onScope = useCallback((next: Scope) => {
    setScope(next);
    setConfirming(false);
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
    if (!target) return;
    setConfirming(false);
    setError(null);
    setProgress(null);
    setSummary(null);
    setPhase("running");

    const channel = createExportChannel((tick) => {
      // exported is monotonic within a phase, but a device export runs two phases at different scales -
      // staging counts bytes staged, transferring counts bytes moved. Carrying the staging max into the
      // transfer would pin the bar full, so the guard resets on a phase change and only clamps within one.
      setProgress((prev) => {
        const exported =
          prev && prev.phase === tick.phase ? Math.max(prev.exported, tick.exported) : tick.exported;
        return { ...tick, exported };
      });
    });

    try {
      setSummary(await exportLibrary(target, channel, folder, file, options));
      setPhase("done");
    } catch {
      // A failed run drops back to idle with the reason surfaced rather than vanishing. The library
      // source is untouched either way; a device that dropped off mid-copy may hold a partial copy (no
      // rollback), which the device message is honest about.
      setPhase("idle");
      setError(
        target.kind === "device"
          ? t((d) => d.export.deviceTransferFailed)
          : t((d) => d.export.exportFailed),
      );
    }
    // Even a failed run may have recorded what landed, so the preview reads the destination afresh.
    refresh();
  }, [target, t, folder, file, options, refresh]);

  // Records the destination as matching the library without copying a file, then re-reads the preview.
  const onAdopt = useCallback(async () => {
    if (!target) return;
    setError(null);
    setAdopting(true);
    try {
      await adoptExportDestination(exportConfig(target, folder, file, options));
    } catch {
      setError(t((d) => d.export.adoptFailed));
    }
    setAdopting(false);
    refresh();
  }, [target, folder, file, options, t, refresh]);

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
    if (check?.non_empty && !mergesIntoRecord) {
      setConfirming(true);
      return;
    }
    void runExport();
  }, [check, mergesIntoRecord, runExport]);

  const onAgain = useCallback(() => {
    setSummary(null);
    setProgress(null);
    setConfirming(false);
    setError(null);
    setPhase("idle");
  }, []);

  // A folder path is the only openable destination, so it alone gates the done-screen Open button. A
  // device has no filesystem path, so this stays null for one and the button drops.
  const path = target?.kind === "folder" ? target.path : null;

  if (phase === "running") {
    const total = progress?.total ?? 0;
    const exported = progress?.exported ?? 0;
    const errors = progress?.errors ?? 0;
    const phaseNow = progress?.phase;
    // The line under the spinner: a folder shows its path, a device its human-readable display name.
    const destLine =
      target?.kind === "folder"
        ? target.path
        : target?.kind === "device"
          ? target.target.display
          : null;
    // A device export runs two named phases; the folder export only ever copies. The title follows the
    // phase so the device reads Writing while it stages, then Transferring while it moves onto the device.
    const title =
      target?.kind === "device" && phaseNow === "copying"
        ? t((d) => d.export.writing)
        : target?.kind === "device" && phaseNow === "transferring"
          ? t((d) => d.export.transferring)
          : t((d) => d.export.exporting);
    // The staging phase counts bytes with no meaningful total to divide against, so the device bar runs
    // indeterminate while it writes the temp folder, then goes determinate once the transfer begins. A
    // folder copy stays determinate throughout.
    const value =
      target?.kind === "device" && phaseNow === "copying"
        ? null
        : total > 0
          ? exported / total
          : null;
    return (
      <CenteredStage>
        <div className={styles.body}>
          <StaffSpinner />
          <h1 className={styles.title}>{title}</h1>
          {destLine ? (
            <Tooltip label={destLine}>
              <p className={styles.path}>{destLine}</p>
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
          {/* A device leaves no folder to open, so name where it went in its place. A cancelled run only
              partly landed, so it says so rather than claiming the whole library reached the phone. */}
          {target?.kind === "device" ? (
            <p className={styles.hint}>
              {summary.cancelled
                ? t((d) => d.export.partlySentTo, { device: target.target.device_name })
                : t((d) => d.export.sentTo, { device: target.target.device_name })}
            </p>
          ) : null}
          <div className={styles.actions}>
            {path ? (
              <QuietButton onClick={() => void openFolder(path)}>
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
  // writes nothing). All three off leaves nothing to write, so the CTA stays dead. A changed-only
  // preview overrules the trust: with nothing changed there is nothing to write.
  const hasContent =
    scopeView !== "nothingChanged" &&
    ((includeAlbums && counts.albums > 0) ||
      (includeSingles && counts.singles > 0) ||
      includePlaylists);
  // A validated target with something to write is ready - a folder or a connected device alike.
  const canExport = !!target && !!check?.ok && hasContent;
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
          changes={changes && showsChangedCounts(scopeView) ? changes : undefined}
        />
      </div>

      <ScrollArea className={styles.scroll} contentClassName={styles.sections}>
        <section className={styles.section}>
          <span className={styles.label}>{t((d) => d.export.destination)}</span>
          <ExportDestination
            target={target}
            onPickFolder={() => void onPickFolder()}
            onPickDevice={() => void onPickDevice()}
          />
          {check?.inside_workspace ? (
            <p className={styles.warn}>{t((d) => d.export.insideWorkspace)}</p>
          ) : null}
          {/* The failed-probe line: a folder that could not be written to, or a device that dropped off
              the bus between the pick and the check. */}
          {check && !check.inside_workspace && !check.writable ? (
            <p className={styles.warn}>
              {target?.kind === "device"
                ? t((d) => d.export.deviceDisconnected)
                : t((d) => d.export.notWritable)}
            </p>
          ) : null}
          {check?.ok && check.non_empty && !mergesIntoRecord ? (
            <p className={styles.warn}>{t((d) => d.export.nonEmpty)}</p>
          ) : null}
          {/* A device offers two shapes: a fresh dated snapshot, or an in-place merge that updates a
              living library on the phone. Only shown once a device is the target. */}
          {target?.kind === "device" ? (
            <div className={styles.deviceMode}>
              <SegmentedControl
                segments={[
                  { value: "snapshot", label: t((d) => d.export.deviceSnapshot) },
                  { value: "inplace", label: t((d) => d.export.deviceUpdate) },
                ]}
                value={deviceInPlace ? "inplace" : "snapshot"}
                onChange={onDeviceMode}
                label={t((d) => d.export.deviceModeLabel)}
              />
              <p className={styles.hint}>
                {deviceInPlace
                  ? t((d) => d.export.deviceUpdateHint)
                  : t((d) => d.export.deviceSnapshotHint)}
              </p>
            </div>
          ) : null}
          {/* Nothing chosen yet: point a phone user at the device doorway above rather than let them
              hunt for their handset in the folder picker. */}
          {!target ? (
            <p className={styles.hint}>{t((d) => d.export.phoneHint)}</p>
          ) : null}
          {/* A run that failed (a device that dropped off mid-copy, a folder gone invalid) surfaces its
              reason here rather than silently returning to idle. */}
          {error ? <p className={styles.warn}>{error}</p> : null}
        </section>

        <section className={styles.section}>
          <span className={styles.label}>{t((d) => d.export.include)}</span>
          <ExportScope scope={scope} state={scopeView} changes={changes} onScope={onScope} />
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

      <ExportActions
        state={scopeView}
        confirming={confirming}
        canExport={canExport}
        canAdopt={!!target && !!check?.ok && !adopting}
        onExport={onExport}
        onConfirm={() => void runExport()}
        onCancelConfirm={() => setConfirming(false)}
        onAdopt={() => void onAdopt()}
        onExportEverything={() => onScope("all")}
      />
    </div>
  );
}
