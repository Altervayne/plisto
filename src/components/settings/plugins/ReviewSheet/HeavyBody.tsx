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
 * The sheet for a native plugin: a program that runs with the user's access. The warning, the reason the
 * plugin declared for needing to be native, then its capabilities. The reason is manifest text and is
 * shown as plain text.
 */
export function HeavyBody({
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
      <div className={styles.box}>{t((d) => d.plugins.sheet.nativeWarning)}</div>
      <ChangeNotes subject={subject} mode={mode} lead={lead} />
      {subject.nativeReason ? (
        <div className={styles.sect}>
          <span className={styles.label}>{t((d) => d.plugins.sheet.nativeReasonLabel)}</span>
          <p className={styles.prompt}>{subject.nativeReason}</p>
        </div>
      ) : null}
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
