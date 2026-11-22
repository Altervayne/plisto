// -- Component Imports --
import { CapabilityList } from "./CapabilityList";
import { ChangeNotes } from "./ChangeNotes";
import { NewNote } from "./NewNote";
import { FlashNote, ListingLine } from "./VisualizerLines";
import { WebsiteLine } from "./WebsiteLine";

// -- Utils Imports --
import { knownCapabilities } from "../../../../state/plugins/capabilities";
import { addsVisualizers, droppedCapabilities } from "../../../../state/plugins/review";

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
  const visualizers = addsVisualizers(subject);
  const dropped = mode === "update" && visualizers ? knownCapabilities(droppedCapabilities(subject)) : [];

  return (
    <div className={styles.body}>
      <ListingLine subject={subject} mode={mode} />
      <ChangeNotes subject={subject} mode={mode} lead={lead} />
      <CapabilityList
        subject={subject}
        heading={changed ? t((d) => d.plugins.sheet.versionAsksLabel) : t((d) => d.plugins.sheet.canLabel)}
      />
      {dropped.length > 0 ? (
        <div className={styles.sect}>
          <span className={styles.label}>{t((d) => d.plugins.vis.capsRemoved)}</span>
          <ul className={styles.caps}>
            {dropped.map((cap) => (
              <li key={cap}>
                <div className={styles.capText}>{t((d) => d.plugins.capability[cap])}</div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <NewNote subject={subject} />
      <FlashNote subject={subject} />
      <p className={styles.note}>
        {reachesNetwork ? t((d) => d.plugins.sheet.calmNote) : t((d) => d.plugins.sheet.calmNoteOffline)}
      </p>
      <WebsiteLine url={subject.homepage} />
    </div>
  );
}
