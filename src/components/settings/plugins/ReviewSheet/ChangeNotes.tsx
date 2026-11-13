// -- Utils Imports --
import { updateChange } from "../../../../state/plugins/review";

// -- i18n Imports --
import { useT } from "../../../../i18n";

// -- Type Imports --
import type { ReviewLead, ReviewMode, ReviewSubject } from "../../../../state/plugins/review";

// -- Style Imports --
import styles from "./ReviewSheet.module.css";

/**
 * The lines that set an update or a changed-permissions review apart: which version replaces which (a
 * downgrade is said plainly), and for a review after an update that the plugin stays off until the new
 * permissions are approved. Renders nothing for a fresh install.
 */
export function ChangeNotes({
  subject,
  mode,
  lead,
}: {
  subject: ReviewSubject;
  mode: ReviewMode;
  lead: ReviewLead;
}) {
  const t = useT();
  const previous = subject.previous?.version ?? "";
  if (!subject.previous && mode !== "consent") return null;
  const vars = { previous, version: subject.version };
  const change = updateChange(subject);

  return (
    <>
      {mode === "consent" ? (
        <p className={styles.prompt}>
          {lead === "changed"
            ? t((d) => d.plugins.sheet.changedIntro)
            : lead === "updated"
              ? t((d) => d.plugins.sheet.consentIntro)
              : t((d) => d.plugins.sheet.adoptedIntro)}
        </p>
      ) : change === "downgrade" ? (
        <p className={`${styles.note} ${styles.warnNote}`}>{t((d) => d.plugins.sheet.changeDowngrade, vars)}</p>
      ) : (
        <p className={styles.note}>
          {change === "upgrade"
            ? t((d) => d.plugins.sheet.changeUpgrade, vars)
            : change === "same"
              ? t((d) => d.plugins.sheet.changeSame, vars)
              : t((d) => d.plugins.sheet.changeUnknown)}
        </p>
      )}
    </>
  );
}
