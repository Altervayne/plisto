// -- Framework Imports --
import { useMemo, useState } from "react";

// -- Icon Imports --
import { Info, Pencil, TriangleAlert } from "lucide-react";

// -- Component Imports --
import { SegmentedControl } from "../common/SegmentedControl";
import { StampDiff } from "./StampDiff";
import type { DiffView } from "./StampDiff";
import { StampBanner, StampLabel, StampReasonGroup } from "./StampRows";

// -- Utils Imports --
import { FIELD_ORDER, fieldsPresent, isNothingToWrite, isSkip, orderedSkips, skippedCount } from "../../lib/stampShape";
import type { ScopeInfo } from "../../lib/stampShape";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Type Imports --
import type { StampPreview } from "../../types";

// -- Style Imports --
import styles from "./StampConfirm.module.css";

/** The note a scope adds above the diff, if any. */
function scopeNote(info: ScopeInfo): "bannerSingle" | "bannerLoose" | "bannerCost" | null {
  if (info.kind === "single") return "bannerSingle";
  if (info.kind === "loose") return "bannerLoose";
  if (info.kind === "library") return "bannerCost";
  return null;
}

/**
 * The confirm body: what is written (the cover struck out), the notes that apply, the diff by change or
 * by file, and the files that will be left alone with their reasons. A preview with no file to write
 * shows the plain "nothing to write" state instead.
 */
export function StampConfirm({
  preview,
  scope,
  scopeLine,
  exportHeld,
}: {
  preview: StampPreview;
  scope: ScopeInfo;
  scopeLine: string;
  exportHeld: boolean;
}) {
  const t = useT();
  const [view, setView] = useState<DiffView>("change");
  const present = useMemo(() => fieldsPresent(preview.files), [preview.files]);
  const skips = useMemo(() => orderedSkips(preview), [preview]);
  const loose = scope.kind === "loose";
  const note = scopeNote(scope);

  if (isNothingToWrite(preview)) {
    return (
      <>
        <div className={styles.scope}>{scopeLine}</div>
        <div className={styles.center} role="status">
          <span className={styles.tone} />
          <p className={styles.centerTitle}>{t((d) => d.fileWrites.stamp.nothingTitle)}</p>
          <small className={styles.centerLine}>{t((d) => d.fileWrites.stamp.nothingLine)}</small>
        </div>
      </>
    );
  }

  return (
    <>
      <div className={styles.scope}>{scopeLine}</div>

      <div className={styles.block}>
        <span className={styles.glyph}>
          <Pencil size={17} strokeWidth={1.8} aria-hidden="true" />
        </span>
        <div className={styles.text}>
          <span className={styles.eyebrow}>{t((d) => d.fileWrites.stamp.writtenEyebrow)}</span>
          <div className={styles.fields}>
            {FIELD_ORDER.map((field) => (
              <span key={field} className={`${styles.chip} ${loose && !present.has(field) ? styles.off : ""}`}>
                {t((d) => d.fileWrites.field[field])}
              </span>
            ))}
            <span className={`${styles.chip} ${styles.off}`}>{t((d) => d.fileWrites.field.cover)}</span>
          </div>
          <span className={styles.never}>
            {loose ? `${t((d) => d.fileWrites.stamp.writtenLoose)} ` : ""}
            {t((d) => d.fileWrites.stamp.writtenNever)}
          </span>
        </div>
      </div>

      {preview.exportRunning || exportHeld ? (
        <StampBanner warn icon={<TriangleAlert size={16} strokeWidth={1.8} aria-hidden="true" />}>
          {t((d) => d.fileWrites.stamp.bannerExport)}
        </StampBanner>
      ) : null}
      {note ? (
        <StampBanner icon={<Info size={16} strokeWidth={1.8} aria-hidden="true" />}>
          {t((d) => d.fileWrites.stamp[note])}
        </StampBanner>
      ) : null}

      <div className={styles.bar}>
        <p className={styles.summary}>
          {t((d) => d.fileWrites.stamp.willWrite, { n: preview.files.length })}{" "}
          {t((d) => d.fileWrites.stamp.willSkip, { n: skippedCount(preview) })}
        </p>
        <SegmentedControl<DiffView>
          label={t((d) => d.fileWrites.stamp.title)}
          value={view}
          onChange={setView}
          segments={[
            { value: "change", label: t((d) => d.fileWrites.stamp.byChange) },
            { value: "file", label: t((d) => d.fileWrites.stamp.byFile) },
          ]}
        />
      </div>

      <StampDiff files={preview.files} view={view} />

      {skips.length > 0 ? (
        <>
          <StampLabel>{t((d) => d.fileWrites.stamp.notWritten)}</StampLabel>
          {skips.map((group) =>
            isSkip(group.outcome) ? (
              <StampReasonGroup key={group.outcome} reason={group.outcome} tracks={group.tracks} defaultOpen={false} />
            ) : null,
          )}
        </>
      ) : null}
    </>
  );
}
