// -- Icon Imports --
import { FolderOpen } from "lucide-react";

// -- Component Imports --
import { PrimaryButton } from "../common/PrimaryButton";
import { QuietButton } from "../common/QuietButton";
import { SegmentedControl } from "../common/SegmentedControl";
import { Tooltip } from "../common/Tooltip/Tooltip";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Type Imports --
import type { CollisionPolicy, DestinationCheck } from "../../types";

// -- Style Imports --
import styles from "./SpliceOutputConfig.module.css";

/**
 * The output config pinned under the cut list: where the files land, what happens on a name clash, and
 * the one solid Split CTA. The destination is folder-only - the cutter writes real files, never to a
 * device - and runs the same validation the export destination does, refusing one inside the library or
 * one it cannot write. By default the CTA is dead until there are at least two segments and a valid
 * destination; a non-empty folder arms a two-step confirm before it writes, mirroring the export flow.
 * The cropper reuses this footer with a one-segment gate: `canRun` overrides the segment gate, and
 * `runLabel`/`disabledHint` retitle the CTA and its guidance for a single output.
 */
export function SpliceOutputConfig({
  destination,
  check,
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
  const runnable = gateMet && !!check?.ok;

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
              <span className={styles.chosenDot} aria-hidden="true" />
              <span className={styles.chosenPath}>{destination}</span>
            </span>
          </Tooltip>
        ) : (
          <p className={styles.hint}>{t((d) => d.splice.destinationHint)}</p>
        )}
        {check?.inside_workspace ? (
          <p className={styles.warn}>{t((d) => d.export.insideWorkspace)}</p>
        ) : null}
        {check && !check.inside_workspace && !check.writable ? (
          <p className={styles.warn}>{t((d) => d.export.notWritable)}</p>
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
        <PrimaryButton onClick={onRun} disabled={!runnable} block>
          {runLabel ?? t((d) => d.splice.splitInto, { n: segmentCount })}
        </PrimaryButton>
      )}
      {!gateMet ? (
        <p className={styles.hint}>{disabledHint ?? t((d) => d.splice.runHint)}</p>
      ) : null}
    </div>
  );
}
