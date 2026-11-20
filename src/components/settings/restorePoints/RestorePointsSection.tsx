// -- Framework Imports --
import { useEffect, useReducer, useRef } from "react";

// -- Component Imports --
import { QuietButton } from "../../common/QuietButton";
import { ProgressLine } from "../../scan/ProgressLine";
import { SettingRow } from "../SettingRow";
import { RestoreFailureSheet } from "./RestoreFailureSheet";
import { RestorePointRow } from "./RestorePointRow";
import { RestoreResultSheet } from "./RestoreResultSheet";
import { RestoreSheet } from "./RestoreSheet";
import { useRestoreFlow } from "./useRestoreFlow";

// -- State Imports --
import { useRestorePointsStore, useRestoreAllowed, useRestoreRunning } from "../../../state/restorePoints/store";
import type { RestoreResult } from "../../../state/restorePoints/store";
import { useScanStatus } from "../../../state/store";

// -- Utils Imports --
import { formatBytes, formatDateTime } from "../../../lib/format";
import { isBusyRefusal, shouldClearResult } from "./restorePointModel";
import { sectionAttr } from "../settingsSections";

// -- i18n Imports --
import { useLocale, useT } from "../../../i18n";

// -- Style Imports --
import sectionStyles from "../SettingsView.module.css";
import styles from "./RestorePoints.module.css";

type DoneResult = Extract<RestoreResult, { kind: "done" }>;

/**
 * The Restore points section: the saved points newest first, the folder's disk use, and the restore
 * flow. A dry run opens the sheet that says what comes back and what is lost; confirming closes it and
 * a quiet status line holds the place while albums and playlists reload. The outcome opens a result
 * sheet with Undo restore, or a failure sheet that says nothing changed. Restore waits while a restore
 * or a scan runs.
 */
export function RestorePointsSection() {
  const t = useT();
  const locale = useLocale();
  const points = useRestorePointsStore((s) => s.points);
  const diskPoints = useRestorePointsStore((s) => s.diskPoints);
  const diskBytes = useRestorePointsStore((s) => s.diskBytes);
  const loaded = useRestorePointsStore((s) => s.loaded);
  const error = useRestorePointsStore((s) => s.error);
  const result = useRestorePointsStore((s) => s.result);
  const load = useRestorePointsStore((s) => s.load);
  const clearResult = useRestorePointsStore((s) => s.clearResult);
  const running = useRestoreRunning();
  const allowed = useRestoreAllowed();
  const scanning = useScanStatus() === "scanning";
  const flow = useRestoreFlow();

  useEffect(() => {
    void load();
  }, [load]);

  // A refusal that was only the scan has nothing more to say once the scan is over.
  const busy = isBusyRefusal(result);
  useEffect(() => {
    if (busy && !scanning) clearResult();
  }, [busy, scanning, clearResult]);

  const whenOf = (file: string): string => {
    const row = points.find((p) => p.file === file);
    return row ? formatDateTime(row.created_at, locale) : file;
  };

  // A scan refusing an Undo replaces the result, but the sheet stays so Undo can be tried again.
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const lastDone = useRef<DoneResult | null>(null);
  const keepDone = useRef(false);
  const undoClicked = useRef(false);
  if (result?.kind === "done") {
    lastDone.current = result;
    keepDone.current = false;
  } else if (busy && lastDone.current) {
    keepDone.current = true;
  } else if (running || result !== null) {
    lastDone.current = null;
    keepDone.current = false;
  }
  const shownDone = result?.kind === "done" ? result : keepDone.current ? lastDone.current : null;
  const undoBusy = shownDone !== null && shownDone !== result && scanning;

  // Closing a sheet clears its result only: a newer result is not its to clear. An Undo closes the
  // sheet it starts from, so that close is skipped.
  const dismiss = (shown: RestoreResult) => {
    if (shouldClearResult(shown, useRestorePointsStore.getState().result)) clearResult();
  };
  const closeDone = (shown: DoneResult) => {
    if (undoClicked.current) {
      undoClicked.current = false;
      return;
    }
    lastDone.current = null;
    keepDone.current = false;
    dismiss(shown);
    redraw();
  };

  const { pending } = flow;
  const canRestore = allowed && flow.planning === null;
  const row = flow.restoring !== null ? points.find((p) => p.file === flow.restoring) : undefined;

  return (
    <section className={sectionStyles.section} {...sectionAttr("restorePoints")}>
      <h2 className={sectionStyles.label}>{t((d) => d.restorePoints.section)}</h2>
      <SettingRow id="restorePoints" className={sectionStyles.section}>
        <p className={sectionStyles.helper}>{t((d) => d.restorePoints.helper)}</p>
        {running ? (
          <div className={styles.status} role="status">
            <div className={styles.statusText}>
              <div className={styles.statusTitle}>
                {row
                  ? t((d) => d.restorePoints.working, { when: formatDateTime(row.created_at, locale) })
                  : t((d) => d.restorePoints.workingGeneric)}
              </div>
              <div className={styles.statusLine}>{t((d) => d.restorePoints.workingLine)}</div>
            </div>
            <span className={styles.statusPill}>
              <ProgressLine value={null} />
            </span>
          </div>
        ) : null}
        {busy && scanning ? (
          <p className={`${styles.line} ${styles.lineWarn}`} role="alert">
            {t((d) => d.settings.locateBusy)} {t((d) => d.restorePoints.nothingChanged)}
          </p>
        ) : null}
        {error !== null ? (
          <div className={styles.status}>
            <span className={styles.statusText}>
              <span className={styles.statusLine}>{t((d) => d.restorePoints.loadError)}</span>
            </span>
            <QuietButton onClick={() => void load()}>{t((d) => d.restorePoints.retry)}</QuietButton>
          </div>
        ) : null}
        {loaded && points.length === 0 ? (
          <p className={styles.empty}>
            <b className={styles.emptyTitle}>{t((d) => d.restorePoints.emptyTitle)}</b>
            {t((d) => d.restorePoints.emptyLine)}
          </p>
        ) : null}
        {points.length > 0 ? (
          <>
            <div className={sectionStyles.list}>
              {points.map((point) => (
                <RestorePointRow
                  key={point.file}
                  row={point}
                  canRestore={canRestore}
                  onRestore={(picked) => void flow.start(picked)}
                />
              ))}
            </div>
            <p className={styles.disk}>
              {t((d) => d.restorePoints.disk, { n: diskPoints, size: formatBytes(diskBytes) })}
            </p>
          </>
        ) : null}
      </SettingRow>

      {pending ? (
        <RestoreSheet
          row={pending.row}
          summary={pending.summary}
          onConfirm={() => flow.run(pending.row.file)}
          onClose={flow.cancel}
        />
      ) : null}
      {flow.planFailure ? (
        <RestoreFailureSheet failure={flow.planFailure} onClose={flow.dismissPlanFailure} />
      ) : null}
      {shownDone ? (
        <RestoreResultSheet
          when={whenOf(shownDone.file)}
          summary={shownDone.summary}
          canUndo={shownDone.beforePoint !== null}
          undoBusy={undoBusy}
          onUndo={() => {
            undoClicked.current = true;
            flow.run(shownDone.beforePoint!);
          }}
          onDone={() => closeDone(shownDone)}
        />
      ) : null}
      {result?.kind === "refused" && !busy ? (
        <RestoreFailureSheet failure={result.failure} onClose={() => dismiss(result)} />
      ) : null}
    </section>
  );
}
