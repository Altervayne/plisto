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
 * The sheet for a sandboxed plugin once the sandbox is proven: what it can do, and the plain claim that
 * it runs contained. It states enforcement, so it is only reachable when the recorded probe passed.
 */
export function CalmBody({
  subject,
  mode,
  lead,
}: {
  subject: ReviewSubject;
  mode: ReviewMode;
  lead: ReviewLead;
}) {
  const t = useT();
  const changed = subject.previous !== null;
  const reachesNetwork = subject.capabilities.includes("network");

  return (
    <div className={styles.body}>
      <ChangeNotes subject={subject} mode={mode} lead={lead} />
      <CapabilityList
        subject={subject}
        heading={changed ? t((d) => d.plugins.sheet.versionAsksLabel) : t((d) => d.plugins.sheet.canLabel)}
      />
      <NewNote subject={subject} />
      <p className={styles.note}>
        {reachesNetwork ? t((d) => d.plugins.sheet.calmNote) : t((d) => d.plugins.sheet.calmNoteOffline)}
      </p>
      <WebsiteLine url={subject.homepage} />
    </div>
  );
}
