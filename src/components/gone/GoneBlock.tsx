// -- Framework Imports --
import type { ReactNode } from "react";

// -- Icon Imports --
import { Check, FolderSearch, Unplug } from "lucide-react";

// -- Component Imports --
import { PrimaryButton } from "../common/PrimaryButton";
import { QuietButton } from "../common/QuietButton";
import { Tooltip } from "../common/Tooltip/Tooltip";
import { GoneStaffs } from "./GoneStaffs";

// -- Utils Imports --
import { retryable, stepLine } from "../settings/locateCopy";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Type Imports --
import type { LocateStep } from "../settings/locateFlow";

// -- Style Imports --
import styles from "./GoneBlock.module.css";

/** Stands in for a path inside a translated line, so the path can be set apart in the mono face. */
export const PATH_MARK = "\u0001";

/** Renders `text`, setting the marked path apart. A line without the mark renders as it is. */
export function MarkedText({ text, path }: { text: string; path: string }): ReactNode {
  const parts = text.split(PATH_MARK);
  if (parts.length < 2) return text;
  return parts.flatMap((part, i) =>
    i === 0
      ? [part]
      : [
          <span key={i} className={styles.path}>
            {path}
          </span>,
          part,
        ],
  );
}

export interface GoneBlockProps {
  /** An offline root (its tracks are kept) or a folder that looks moved (its tracks are gone). */
  kind: "offline" | "moved";
  /** The folder the block speaks about, as the sheet knows it now. */
  path: string;
  /** Tracks behind the folder. */
  count: number;
  step: LocateStep;
  /** A scan runs: Locate, Rescan and Remove wait. */
  locked: boolean;
  /** Remove cannot run yet (the projections it cascades into have not loaded). */
  removeBlocked: boolean;
  removeTip?: string;
  /** Absent when the folder has no Locate; the block then offers Remove only. */
  onLocate?: () => void;
  onRescan?: () => void;
  onRemove?: () => void;
  onConfirm: () => void;
  onRetry: () => void;
  onDismiss: () => void;
}

/**
 * One notice at the top of the sheet. Idle, it states the problem and offers its fixes; while a Locate
 * runs it becomes that step's line with the choices that fit it, the staff spinner for a check or a
 * relocate, and a check mark once it lands. The folder in a step line is set in the mono face.
 */
export function GoneBlock(props: GoneBlockProps) {
  const t = useT();
  const { step, kind, path, count, locked } = props;
  const eyebrow = kind === "offline" ? t((d) => d.gone.offline) : t((d) => d.gone.likely);
  const folderStep = "folder" in step;
  const line =
    folderStep && step.kind !== "running"
      ? stepLine(t, { ...step, folder: PATH_MARK })
      : null;
  const folder = folderStep ? step.folder : path;

  if (step.kind !== "idle") {
    const waiting = step.kind === "checking" || step.kind === "running";
    const text =
      step.kind === "running" ? t((d) => d.gone.updating, { name: step.name }) : (line ?? "");
    return (
      <div className={styles.block}>
        <span className={`${styles.glyph} ${step.kind === "done" ? styles.good : styles.warn}`}>
          {step.kind === "done" ? <Check size={17} strokeWidth={1.8} /> : <FolderSearch size={17} strokeWidth={1.8} />}
        </span>
        <div className={styles.text}>
          <div className={styles.eyebrow}>{eyebrow}</div>
          <div className={styles.title} role="status">
            <MarkedText text={text} path={folder} />
          </div>
          {waiting ? <GoneStaffs /> : null}
        </div>
        <div className={styles.acts}>
          {step.kind === "confirm" ? (
            <PrimaryButton onClick={props.onConfirm}>
              {step.plan.kind === "merge"
                ? t((d) => d.settings.mergeAction)
                : t((d) => d.settings.locateUse)}
            </PrimaryButton>
          ) : null}
          {step.kind === "refused" && retryable(step.reason) ? (
            <QuietButton onClick={props.onRetry}>{t((d) => d.scan.tryAgain)}</QuietButton>
          ) : null}
          {step.kind === "running" ? null : (
            <QuietButton onClick={props.onDismiss}>
              {step.kind === "checking" || step.kind === "confirm"
                ? t((d) => d.common.cancel)
                : t((d) => d.common.dismiss)}
            </QuietButton>
          )}
        </div>
      </div>
    );
  }

  if (kind === "offline") {
    return (
      <div className={styles.block}>
        <span className={`${styles.glyph} ${styles.warn}`}>
          <Unplug size={17} strokeWidth={1.8} />
        </span>
        <div className={styles.text}>
          <div className={styles.eyebrow}>{eyebrow}</div>
          <div className={styles.title}>
            <MarkedText text={t((d) => d.gone.offlineLine, { path: PATH_MARK })} path={path} />
          </div>
          <div className={styles.line}>{t((d) => d.gone.tracks, { n: count })}</div>
          <div className={`${styles.line} ${styles.muted}`}>{t((d) => d.gone.offlineSub)}</div>
        </div>
        <div className={styles.acts}>
          <PrimaryButton onClick={props.onRescan} disabled={locked}>
            {t((d) => d.gone.rescan)}
          </PrimaryButton>
          <QuietButton onClick={props.onLocate} disabled={locked}>
            {t((d) => d.settings.locate)}
          </QuietButton>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.block}>
      <span className={`${styles.glyph} ${styles.warn}`}>
        <FolderSearch size={17} strokeWidth={1.8} />
      </span>
      <div className={styles.text}>
        <div className={styles.eyebrow}>{eyebrow}</div>
        <div className={styles.title}>
          <MarkedText
            text={t((d) => d.gone.likelyLine, {
              path: PATH_MARK,
              tracks: t((d) => d.gone.tracks, { n: count }),
            })}
            path={path}
          />
        </div>
        {props.onLocate ? (
          <div className={`${styles.line} ${styles.muted}`}>{t((d) => d.gone.likelyMore)}</div>
        ) : null}
      </div>
      <div className={styles.acts}>
        {props.onLocate ? (
          <PrimaryButton onClick={props.onLocate} disabled={locked}>
            {t((d) => d.gone.locateFolder)}
          </PrimaryButton>
        ) : null}
        <Tooltip label={props.removeTip}>
          <QuietButton destructive onClick={props.onRemove} disabled={locked || props.removeBlocked}>
            {t((d) => d.gone.removeGroup)}
          </QuietButton>
        </Tooltip>
      </div>
    </div>
  );
}
