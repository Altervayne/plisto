// -- i18n Imports --
import { useT } from "../../../../i18n";

// -- Type Imports --
import type { ReviewMode } from "../../../../state/plugins/review";
import type { SheetPhase } from "../../../../state/plugins/sheet";

// -- Style Imports --
import styles from "./ReviewSheet.module.css";

type Step = "done" | "now" | "todo";

/**
 * The sheet's content while a command runs: static steps naming where it stands, with Cancel held. Nothing
 * animates. An install reads checking, copying, turning on; an update reads checking, replacing.
 */
export function BusyView({
  name,
  mode,
  phase,
  titleId,
}: {
  name: string;
  mode: ReviewMode;
  phase: SheetPhase;
  titleId: string;
}) {
  const t = useT();
  const updating = mode === "update";
  const consenting = mode === "consent";
  const steps: { label: string; state: Step }[] = consenting
    ? [
        { label: t((d) => d.plugins.sheet.stepChecking), state: "done" },
        { label: t((d) => d.plugins.sheet.stepEnabling), state: "now" },
      ]
    : updating
      ? [
        { label: t((d) => d.plugins.sheet.stepChecking), state: "done" },
        { label: t((d) => d.plugins.sheet.stepUpdating), state: "now" },
      ]
    : [
        { label: t((d) => d.plugins.sheet.stepChecking), state: "done" },
        { label: t((d) => d.plugins.sheet.stepCopying), state: phase === "installing" ? "now" : "done" },
        { label: t((d) => d.plugins.sheet.stepAdding), state: phase === "installing" ? "todo" : "now" },
      ];

  return (
    <div className={styles.body} role="status">
      <h2 id={titleId} className={styles.title}>
        {consenting
          ? t((d) => d.plugins.sheet.enablingTitle, { name })
          : updating
            ? t((d) => d.plugins.sheet.updatingTitle, { name })
            : t((d) => d.plugins.sheet.installingTitle, { name })}
      </h2>
      <ul className={styles.steps}>
        {steps.map((step) => (
          <li key={step.label} className={step.state === "todo" ? undefined : styles[step.state]}>
            <i className={styles.dot} aria-hidden="true" />
            {step.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
