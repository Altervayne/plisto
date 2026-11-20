// -- Framework Imports --
import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";

// -- Component Imports --
import { PrimaryButton } from "../common/PrimaryButton";
import { SegmentedControl } from "../common/SegmentedControl";
import { Tooltip } from "../common/Tooltip/Tooltip";

// -- Hook Imports --
import { useKeepFor } from "./useTrimReplaceFlow";
import type { SaveMode, TrimReplaceFlow, TrimSource } from "./useTrimReplaceFlow";

// -- State Imports --
import { useOpenSettings } from "../../state/shell/store";

// -- Type Imports --
import type { ReplaceBlock } from "../../lib/trimReplace";

// -- i18n Imports --
import { useT } from "../../i18n";
import type { Translate } from "../../i18n";

// -- Style Imports --
import styles from "./TrimSaveControl.module.css";

/** Why Replace the original is unavailable, worded for the line under the Save control. */
function whyLine(t: Translate, block: ReplaceBlock): string | null {
  switch (block.kind) {
    case "format":
      return block.format === "FLAC"
        ? t((d) => d.fileWrites.trim.why.flac)
        : t((d) => d.fileWrites.trim.why.format, { format: block.format });
    case "adHoc":
      return t((d) => d.fileWrites.trim.why.adHoc);
    case "inUse":
      return t((d) => d.fileWrites.trim.why.inUse);
    case "stale":
      return t((d) => d.fileWrites.trim.why.stale);
    case "missing":
      return t((d) => d.fileWrites.trim.missingLine);
    case "offline":
      return t((d) => d.fileWrites.trim.offlineLine, { folder: block.folder });
    case "off":
      return null;
  }
}

/**
 * The trim panel's Save control: as a new file through the destination config passed as `children`, or
 * over the library file itself. A blocked replace keeps its segment, dimmed, with the reason under it;
 * with the feature off there is no choice at all, only the new-file config and a pointer to Settings.
 * A stale analysis blocks both modes, so its reason and Reread show whatever the mode; a failed reread
 * says so above the editor instead. Replace waits while the file is reread. A run that drops back here
 * moves focus to the Save control.
 */
export function TrimSaveControl({
  replace,
  path,
  canTrim,
  source,
  onReplace,
  children,
}: {
  replace: TrimReplaceFlow;
  path: string;
  canTrim: boolean;
  source: TrimSource;
  onReplace: () => void;
  children: ReactNode;
}) {
  const t = useT();
  const openSettings = useOpenSettings();
  const reasonId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const { block, mode, backAt } = replace;
  const { stale, rereadFailed, reading, onReread } = source;

  // The chosen save mode takes focus, or the first live button when replacing is off.
  useEffect(() => {
    if (backAt === 0) return;
    const root = rootRef.current;
    const target =
      root?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]') ??
      root?.querySelector<HTMLButtonElement>("button:not(:disabled)");
    target?.focus();
  }, [backAt]);

  const off = block?.kind === "off";
  const staleWhy = rereadFailed ? null : t((d) => d.fileWrites.trim.why.stale);
  const why = stale ? staleWhy : block ? whyLine(t, block) : null;
  const keep = useKeepFor();
  const waitLine = !canTrim
    ? t((d) => d.splice.trimNothing)
    : reading
      ? t((d) => d.fileWrites.trim.why.rereading)
      : null;

  return (
    <div ref={rootRef} className={styles.control}>
      {off ? null : (
        <div className={styles.block}>
          <span className={styles.label}>{t((d) => d.fileWrites.trim.saveLabel)}</span>
          <SegmentedControl<SaveMode>
            segments={[
              { value: "new", label: t((d) => d.fileWrites.trim.saveNew) },
              { value: "replace", label: t((d) => d.fileWrites.trim.saveReplace), disabled: block != null },
            ]}
            value={mode}
            onChange={replace.choose}
            label={t((d) => d.fileWrites.trim.saveLabel)}
          />
        </div>
      )}
      {why ? (
        <p className={styles.why}>
          {why}
          {stale ? (
            <>
              {" "}
              <button type="button" className={styles.link} onClick={onReread} disabled={reading}>
                {t((d) => d.fileWrites.trim.reread)}
              </button>
            </>
          ) : null}
        </p>
      ) : null}

      {mode === "replace" ? (
        <>
          <div className={styles.block}>
            <span className={styles.label}>{t((d) => d.fileWrites.trim.replacesLabel)}</span>
            <Tooltip label={path}>
              <span className={styles.target}>
                <span className={styles.dot} aria-hidden="true" />
                <span className={styles.path}>{path}</span>
              </span>
            </Tooltip>
            <p className={styles.why}>{t((d) => d.fileWrites.trim.replacesLine, { keep })}</p>
          </div>
          <PrimaryButton
            onClick={onReplace}
            disabled={waitLine != null}
            aria-describedby={waitLine ? reasonId : undefined}
            block
          >
            {t((d) => d.fileWrites.trim.trimAndReplace)}
          </PrimaryButton>
          {waitLine ? (
            <p id={reasonId} className={styles.why}>
              {waitLine}
            </p>
          ) : null}
        </>
      ) : (
        children
      )}

      {off ? (
        <p className={styles.why}>
          {t((d) => d.fileWrites.trim.off)}{" "}
          <button
            type="button"
            className={styles.link}
            onClick={() => openSettings({ target: "trimReplace" })}
          >
            {t((d) => d.fileWrites.trim.turnOn)}
          </button>
        </p>
      ) : null}
    </div>
  );
}
