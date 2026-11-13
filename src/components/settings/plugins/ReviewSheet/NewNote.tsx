// -- Utils Imports --
import { hasNewCapabilities } from "../../../../state/plugins/review";

// -- i18n Imports --
import { useT } from "../../../../i18n";

// -- Type Imports --
import type { ReviewSubject } from "../../../../state/plugins/review";

// -- Style Imports --
import styles from "./ReviewSheet.module.css";

/** The line that explains the New badge, shown only when something is marked. */
export function NewNote({ subject }: { subject: ReviewSubject }) {
  const t = useT();
  if (!subject.previous || !hasNewCapabilities(subject)) return null;
  return (
    <p className={styles.note}>
      {t((d) => d.plugins.sheet.newNote, { previous: subject.previous.version })}
    </p>
  );
}
