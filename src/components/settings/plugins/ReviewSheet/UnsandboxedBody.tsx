// -- Component Imports --
import { CapabilityList } from "./CapabilityList";
import { ChangeNotes } from "./ChangeNotes";
import { NewNote } from "./NewNote";
import { WebsiteLine } from "./WebsiteLine";

// -- i18n Imports --
import { useT } from "../../../../i18n";

// -- Type Imports --
import type { ReviewLead, ReviewMode, ReviewSubject } from "../../../../state/plugins/review";

// -- Style Imports --
import styles from "./ReviewSheet.module.css";

/**
 * The sheet for a sandboxed plugin while the sandbox is unproven: the heavy wording that Plisto cannot
 * yet contain it, with no enforcement claim. Kept as a code path for a build whose probe has not passed.
 */
export function UnsandboxedBody({
  subject,
  mode,
  lead,
}: {
  subject: ReviewSubject;
  mode: ReviewMode;
  lead: ReviewLead;
}) {
  const t = useT();
  return (
    <div className={styles.body}>
      <div className={styles.box}>{t((d) => d.plugins.sheet.unsandboxedWarning)}</div>
      <ChangeNotes subject={subject} mode={mode} lead={lead} />
      <CapabilityList
        subject={subject}
        heading={
          subject.previous ? t((d) => d.plugins.sheet.versionAsksLabel) : t((d) => d.plugins.sheet.asksLabel)
        }
      />
      <NewNote subject={subject} />
      <WebsiteLine url={subject.homepage} />
    </div>
  );
}
