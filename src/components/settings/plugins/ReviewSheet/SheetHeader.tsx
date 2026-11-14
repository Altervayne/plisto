// -- Component Imports --
import { PluginIcon } from "../../../plugins/PluginIcon";
import { PluginTag } from "../../../plugins/PluginTag";

// -- State Imports --
import { useProbe } from "../../../../state/plugins/sandboxStore";

// -- Utils Imports --
import { tagKind } from "../../../../state/plugins/trust";

// -- i18n Imports --
import { useT } from "../../../../i18n";

// -- Type Imports --
import type { IconSource } from "../../../../state/plugins/iconCache";
import type { ReviewSubject } from "../../../../state/plugins/review";

// -- Style Imports --
import styles from "./ReviewSheet.module.css";

/** The plugin's icon, name with tag and version, and who declared it. Name and author are manifest text. */
export function SheetHeader({
  subject,
  icon,
  titleId,
}: {
  subject: ReviewSubject;
  icon: IconSource;
  titleId: string;
}) {
  const t = useT();
  const tag = tagKind(subject.tier, useProbe());

  return (
    <div className={styles.header}>
      <PluginIcon source={icon} size={40} />
      <div className={styles.headText}>
        <div className={styles.nameRow}>
          <h2 id={titleId} className={`${styles.nameText} ${styles.title}`}>
            {subject.name}
          </h2>
          {tag ? <PluginTag kind={tag} /> : null}
          <span className={styles.version}>{subject.version}</span>
        </div>
        <div className={styles.byline}>{t((d) => d.plugins.sheet.byline, { author: subject.author })}</div>
      </div>
    </div>
  );
}
