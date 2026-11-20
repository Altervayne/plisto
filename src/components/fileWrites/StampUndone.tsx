// -- Icon Imports --
import { Info, Undo2 } from "lucide-react";

// -- Component Imports --
import { StampBanner, StampBigLine, StampFileList, StampLabel, StampReasonGroup } from "./StampRows";

// -- Utils Imports --
import { isSkip } from "../../lib/stampShape";
import type { UndoneView } from "../../lib/stampShape";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./StampUndone.module.css";

/**
 * The body of a finished undo: how many files went back, the rule that only Plisto's own writes were
 * reverted, the edit-layer note, then the files that kept what they hold and the ones reverted.
 */
export function StampUndone({ view }: { view: UndoneView }) {
  const t = useT();
  return (
    <>
      <StampBigLine>{t((d) => d.fileWrites.run.undoneTitle, { n: view.reverted.length })}</StampBigLine>
      <div className={styles.block}>
        <span className={styles.glyph}>
          <Undo2 size={17} strokeWidth={1.8} aria-hidden="true" />
        </span>
        <div className={styles.text}>
          <span className={styles.title}>{t((d) => d.fileWrites.run.undoneBlockTitle)}</span>
          <span className={styles.line}>{t((d) => d.fileWrites.run.undoneBlockLine)}</span>
        </div>
      </div>
      <StampBanner icon={<Info size={16} strokeWidth={1.8} aria-hidden="true" />}>
        {t((d) => d.fileWrites.run.undoneInfo)}
      </StampBanner>

      {view.kept.length > 0 ? (
        <>
          <StampLabel>{t((d) => d.fileWrites.run.keptGroup, { n: view.keptCount })}</StampLabel>
          {view.kept.map((group) =>
            isSkip(group.outcome) ? (
              <StampReasonGroup key={group.outcome} reason={group.outcome} tracks={group.tracks} defaultOpen />
            ) : null,
          )}
        </>
      ) : null}

      {view.reverted.length > 0 ? (
        <>
          <StampLabel>{t((d) => d.fileWrites.run.revertedGroup, { n: view.reverted.length })}</StampLabel>
          <StampFileList tracks={view.reverted} flat />
        </>
      ) : null}
    </>
  );
}
