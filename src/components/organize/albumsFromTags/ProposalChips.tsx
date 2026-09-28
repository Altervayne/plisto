// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Type Imports --
import type { ProposalNote, ProposalWarning } from "../../../state/organize/groupByAlbumTags";
import type { Translate } from "../../../i18n";

// -- Style Imports --
import styles from "./ProposalRow.module.css";

function noteText(t: Translate, note: ProposalNote): string {
  switch (note.kind) {
    case "years":
      return t((d) => d.tagAlbums.noteYears, { year: note.year });
    case "genres":
      return t((d) => d.tagAlbums.noteGenres);
    case "unnumbered":
      return note.all
        ? t((d) => d.tagAlbums.noteUnnumbered)
        : t((d) => d.tagAlbums.noteSomeUnnumbered, { n: note.count });
    case "gap":
      return t((d) => d.tagAlbums.noteGap);
    case "compilation":
      return t((d) => d.tagAlbums.noteCompilation);
    case "missing":
      return t((d) => d.tagAlbums.noteMissing, { n: note.count });
  }
}

function warningText(t: Translate, warning: ProposalWarning): string {
  switch (warning.kind) {
    case "folders":
      return t((d) => d.tagAlbums.warnFolders);
    case "duplicates":
      return t((d) => d.tagAlbums.warnDuplicates);
    case "collides":
      return t((d) => d.tagAlbums.warnCollides);
  }
}

/**
 * A proposal's chips: the check-first warnings first, warn-tinted, then the neutral notes. Both come
 * from the caller because a numbering clash and a numbering gap depend on the chosen target.
 */
export function ProposalChips({
  warnings,
  notes,
}: {
  warnings: ProposalWarning[];
  notes: ProposalNote[];
}) {
  const t = useT();
  if (warnings.length === 0 && notes.length === 0) return null;

  return (
    <span className={styles.chips}>
      {warnings.map((warning) => (
        <span key={warning.kind} className={`${styles.chip} ${styles.warn}`}>
          {warningText(t, warning)}
        </span>
      ))}
      {notes.map((note) => (
        <span key={note.kind} className={styles.chip}>
          {noteText(t, note)}
        </span>
      ))}
    </span>
  );
}
