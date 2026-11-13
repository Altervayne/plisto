// -- Component Imports --
import { ScrollArea } from "../common/ScrollArea/ScrollArea";

// -- Local Imports --
import { parseNotes } from "./parseNotes";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./ReleaseNotes.module.css";

/**
 * The release notes inside the modal's scroll area: headings, paragraphs and bullet lists as plain text
 * nodes, never markup. The region is focusable so the arrow and page keys scroll it. Empty notes say so.
 */
export function ReleaseNotes({ notes }: { notes: string }) {
  const t = useT();
  const blocks = parseNotes(notes);

  return (
    <ScrollArea className={styles.area} edgeFade>
      <div className={styles.notes} tabIndex={0} role="region" aria-label={t((d) => d.updater.notesLabel)}>
        {blocks.length === 0 ? (
          <div className={styles.empty}>
            <b className={styles.emptyTitle}>{t((d) => d.updater.noNotesTitle)}</b>
            <span className={styles.emptyText}>{t((d) => d.updater.noNotes)}</span>
          </div>
        ) : (
          blocks.map((block, index) =>
            block.kind === "heading" ? (
              <h3 key={index} className={styles.heading}>
                {block.text}
              </h3>
            ) : block.kind === "paragraph" ? (
              <p key={index} className={styles.paragraph}>
                {block.text}
              </p>
            ) : (
              <ul key={index} className={styles.list}>
                {block.items.map((item, i) => (
                  <li key={i} className={styles.item}>
                    {item}
                  </li>
                ))}
              </ul>
            ),
          )
        )}
      </div>
    </ScrollArea>
  );
}
