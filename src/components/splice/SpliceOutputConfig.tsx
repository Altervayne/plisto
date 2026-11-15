// -- Framework Imports --
import { useId } from "react";

// -- Icon Imports --
import { FolderOpen } from "lucide-react";

// -- Component Imports --
import { PrimaryButton } from "../common/PrimaryButton";
import { QuietButton } from "../common/QuietButton";
import { SegmentedControl } from "../common/SegmentedControl";
import { Tooltip } from "../common/Tooltip/Tooltip";

// -- Utils Imports --
import { runBlockers } from "./spliceRunGate";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Type Imports --
import type { CollisionPolicy, DestinationCheck } from "../../types";

// -- Style Imports --
import styles from "./SpliceOutputConfig.module.css";

/**
 * The output config pinned under the cut list: where the files land, what happens on a name clash, and
 * the solid Split CTA. The destination is folder-only and runs the same validation the export does,
 * refusing one inside the library or one it cannot write. The CTA is dead until there are two segments
 * and a valid destination; a non-empty folder arms a two-step confirm. The cropper reuses this footer
 * with a one-segment gate: `canRun` overrides the segment gate, and `runLabel`/`disabledHint` retitle it.
 */
export function SpliceOutputConfig({
  destination,
  check,
  checking,
  collision,
  segmentCount,
  confirming,
  runError,
  onPickDestination,
  onCollision,
  onRun,
  onConfirmRun,
  onCancelConfirm,
  canRun,
  runLabel,
  disabledHint,
}: {
  destination: string | null;
  check: DestinationCheck | null;
  checking: boolean;
  collision: CollisionPolicy;
  segmentCount: number;
  confirming: boolean;
  runError: string | null;
  onPickDestination: () => void;
  onCollision: (collision: CollisionPolicy) => void;
  onRun: () => void;
  onConfirmRun: () => void;
  onCancelConfirm: () => void;
  canRun?: boolean;
  runLabel?: string;
  disabledHint?: string;
}) {
  const t = useT();

  // The body-specific gate: the splitter's two-segment default, or a caller override for the cropper's
  // single output. The run also always needs a valid destination.
  const gateMet = canRun ?? segmentCount >= 2;
  const blockers = runBlockers(destination, check, checking, gateMet);
  const runnable = blockers.length === 0;
  const reasonId = useId();
  const refusalId = useId();

  // One line naming the first thing to fix. A refused folder already shows its own warning above, which
  // the button then describes instead.
  const first = blockers[0];
  const reason =
    first === "noDestination"
      ? t((d) => d.splice.needsDestination)
      : first === "unchecked"
        ? t((d) => d.splice.destinationUnchecked)
        : first === "gate"
          ? (disabledHint ?? t((d) => d.splice.runHint))
          : null;
  const refusalShown = !!check && (check.inside_workspace || !check.writable);
  const describedBy =
    first === "invalidDestination" && refusalShown ? refusalId : reason ? reasonId : undefined;

  return (
    <div className={styles.config}>
      <div className={styles.block}>
        <span className={styles.label}>{t((d) => d.splice.destination)}</span>
        <button type="button" className={styles.destButton} onClick={onPickDestination}>
          <FolderOpen size={15} strokeWidth={1.9} aria-hidden="true" />
          {t((d) => d.splice.chooseDestination)}
        </button>
        {destination ? (
          <Tooltip label={destination}>
            <span className={styles.chosen}>
              <span
                className={`${styles.chosenDot} ${checking ? styles.dotPending : check?.ok ? "" : styles.dotMissing}`}
                aria-hidden="true"
              />
              <span className={styles.chosenPath}>{destination}</span>
            </span>
          </Tooltip>
        ) : (
          <span className={styles.chosen}>
            <span className={`${styles.chosenDot} ${styles.dotMissing}`} aria-hidden="true" />
            <span className={styles.missingText}>{t((d) => d.splice.noFolder)}</span>
          </span>
        )}
        {check?.inside_workspace ? (
          <p id={refusalId} className={styles.warn}>
            {t((d) => d.export.insideWorkspace)}
          </p>
        ) : null}
        {check && !check.inside_workspace && !check.writable ? (
          <p id={refusalId} className={styles.warn}>
            {t((d) => d.export.notWritable)}
          </p>
        ) : null}
        {check?.ok && check.non_empty ? (
          <p className={styles.warn}>{t((d) => d.export.nonEmpty)}</p>
        ) : null}
      </div>

      <div className={styles.block}>
        <span className={styles.label}>{t((d) => d.splice.collisionLabel)}</span>
        <SegmentedControl<CollisionPolicy>
          segments={[
            { value: "skip", label: t((d) => d.splice.collisionSkip) },
            { value: "overwrite", label: t((d) => d.splice.collisionOverwrite) },
            { value: "rename", label: t((d) => d.splice.collisionRename) },
          ]}
          value={collision}
          onChange={onCollision}
          label={t((d) => d.splice.collisionLabel)}
        />
      </div>

      {runError ? <p className={styles.warn}>{runError}</p> : null}

      {confirming ? (
        <div className={styles.confirm}>
          <span className={styles.warn}>{t((d) => d.export.nonEmpty)}</span>
          <div className={styles.confirmActions}>
            <PrimaryButton onClick={onConfirmRun} block>
              {t((d) => d.splice.runConfirm)}
            </PrimaryButton>
            <QuietButton onClick={onCancelConfirm}>{t((d) => d.splice.cancel)}</QuietButton>
          </div>
        </div>
      ) : (
        <PrimaryButton
          onClick={onRun}
          disabled={!runnable}
          aria-describedby={describedBy}
          block
        >
          {runLabel ?? t((d) => d.splice.splitInto, { n: segmentCount })}
        </PrimaryButton>
      )}
      {reason ? (
        <p id={reasonId} className={styles.reason}>
          {reason}
        </p>
      ) : null}
    </div>
  );
}
