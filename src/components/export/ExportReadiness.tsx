// -- Utils Imports --
import { formatShortDate } from "../../lib/format";

// -- i18n Imports --
import { useLocale, useT } from "../../i18n";
import type { Translate } from "../../i18n";
import type { Locale } from "../../i18n/types";

// -- Type Imports --
import type { ExportChangeSet } from "../../types";

// -- Style Imports --
import styles from "./ExportView.module.css";

/**
 * The idle readiness line: a good-tone dot beside a disclosing summary of what a run would write.
 * Only non-zero parts show, mirroring the scan summary idiom. The unsorted clause carries warn tone
 * (it is excluded from export), and missing-source tracks fall to their own warn line beneath. With
 * `changes`, the summary counts only what a changed-only run would write instead of the whole library.
 */
export function ExportReadiness({
  albums,
  tracks,
  singles,
  unsorted,
  missing,
  changes,
}: {
  albums: number;
  tracks: number;
  singles: number;
  unsorted: number;
  missing: number;
  changes?: ExportChangeSet;
}) {
  const t = useT();
  const locale = useLocale();

  let normal: string;
  if (changes) {
    normal = changedLine(t, locale, changes);
  } else {
    const parts: string[] = [];
    if (albums > 0) {
      parts.push(
        `${t((d) => d.export.albums, { n: albums })}, ${t((d) => d.export.tracks, { n: tracks })}`,
      );
    }
    if (singles > 0) parts.push(t((d) => d.export.singles, { n: singles }));
    normal = parts.join(" - ");
  }

  return (
    <>
      <div className={styles.readiness}>
        <span className={styles.dot} aria-hidden="true" />
        <p className={styles.readinessLine}>
          {normal ? <span>{normal}</span> : null}
          {unsorted > 0 ? (
            <>
              {normal ? <span> - </span> : null}
              <span className={styles.warn}>{t((d) => d.export.unsorted, { n: unsorted })}</span>
            </>
          ) : null}
        </p>
      </div>
      {missing > 0 ? (
        <p className={styles.warn}>{t((d) => d.export.missing, { n: missing })}</p>
      ) : null}
    </>
  );
}

/** The changed-only summary: the containers holding a change and the file count, or a quiet all-clear. */
function changedLine(t: Translate, locale: Locale, changes: ExportChangeSet): string {
  if (changes.files === 0) {
    return t((d) => d.export.nothingChanged, {
      date: formatShortDate(changes.last_exported_at ?? 0, locale),
    });
  }
  const parts: string[] = [];
  if (changes.albums > 0) parts.push(t((d) => d.export.albums, { n: changes.albums }));
  if (changes.singles > 0) parts.push(t((d) => d.export.singles, { n: changes.singles }));
  if (changes.playlists > 0) parts.push(t((d) => d.export.playlists, { n: changes.playlists }));
  return t((d) => d.export.changedParts, {
    parts: parts.join(" - "),
    files: t((d) => d.export.files, { n: changes.files }),
  });
}
