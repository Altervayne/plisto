// -- Library Imports --
import { Ban, Check, Feather, SlidersHorizontal, Zap } from "lucide-react";

// -- Component Imports --
import { PrimaryButton } from "../../../common/PrimaryButton";
import { Switch } from "../../../common/Switch/Switch";

// -- i18n Imports --
import { useT } from "../../../../i18n";

// -- Type Imports --
import type { LucideIcon } from "lucide-react";
import type { Ref } from "react";
import type { WarningKind } from "../../../../state/player/visualizerWarning";

// -- Style Imports --
import styles from "./VisualizerWarning.module.css";

/** One switch row: its live state, whether the press would be refused, and the action it applies. */
export interface WarningChoice {
  id: "cozy" | "calm" | "off";
  on: boolean;
  disabled: boolean;
  onChange: (on: boolean) => void;
}

interface RowText {
  icon: LucideIcon;
  label: "warnCozy" | "warnCalm" | "warnOff";
  hint: "warnCozyD" | "warnCalmD" | "warnOffD";
}

const ROWS: Record<WarningChoice["id"], RowText> = {
  cozy: { icon: Feather, label: "warnCozy", hint: "warnCozyD" },
  calm: { icon: SlidersHorizontal, label: "warnCalm", hint: "warnCalmD" },
  off: { icon: Ban, label: "warnOff", hint: "warnOffD" },
};

/**
 * The notice's markup: heading and body for the first-time or after-update wording, one row per choice,
 * the "I understand" box and Carry on, which stays disabled until the box is ticked. A non-modal dialog
 * with no close control: nothing here dismisses it except Carry on. The card itself takes programmatic
 * focus (tabIndex -1), so the tab order inside it is the switches, the box, then Carry on. The box and
 * Carry on sit in one footer that stays pinned if the card ever has to scroll.
 */
export function WarningCard({
  kind,
  choices,
  ack,
  onAck,
  onCarry,
  cardRef,
}: {
  kind: WarningKind;
  choices: readonly WarningChoice[];
  ack: boolean;
  onAck: (next: boolean) => void;
  onCarry: () => void;
  cardRef?: Ref<HTMLDivElement>;
}) {
  const t = useT();
  const first = kind === "first";
  return (
    <div
      ref={cardRef}
      className={styles.notice}
      role="dialog"
      aria-labelledby="visualizer-warning-title"
      aria-describedby="visualizer-warning-body"
      tabIndex={-1}
    >
      <div className={styles.head}>
        <Zap size={20} strokeWidth={1.8} aria-hidden="true" />
        <h2 id="visualizer-warning-title" className={styles.title}>
          {first ? t((d) => d.player.warnTitleFirst) : t((d) => d.player.warnTitleUpdate)}
        </h2>
      </div>
      <p id="visualizer-warning-body" className={styles.body}>
        {first ? t((d) => d.player.warnBodyFirst) : t((d) => d.player.warnBodyUpdate)}
      </p>
      <div className={styles.rows}>
        {choices.map((choice) => {
          const { icon: Icon, label, hint } = ROWS[choice.id];
          const text = t((d) => d.player[label]);
          return (
            <label key={choice.id} className={styles.row} data-disabled={choice.disabled ? "" : undefined}>
              <Icon className={styles.rowIcon} size={18} strokeWidth={1.8} aria-hidden="true" />
              <span className={styles.rowText}>
                <span className={styles.rowLabel}>{text}</span>
                <span id={`visualizer-warning-${choice.id}`} className={styles.rowHint}>
                  {t((d) => d.player[hint])}
                </span>
              </span>
              <Switch
                checked={choice.on}
                disabled={choice.disabled}
                onChange={choice.onChange}
                label={text}
                describedBy={`visualizer-warning-${choice.id}`}
              />
            </label>
          );
        })}
      </div>
      <div className={styles.actions}>
        <button
          type="button"
          role="checkbox"
          aria-checked={ack}
          className={styles.ack}
          onClick={() => onAck(!ack)}
        >
          <span className={styles.box} aria-hidden="true">
            {ack ? <Check size={14} strokeWidth={3} /> : null}
          </span>
          <span>{t((d) => d.player.warnAck)}</span>
        </button>
        <div className={styles.foot}>
          <span className={styles.hint}>{t((d) => d.player.warnHint)}</span>
          <PrimaryButton disabled={!ack} onClick={onCarry}>
            {t((d) => d.player.warnCarry)}
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}
