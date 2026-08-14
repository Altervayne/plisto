// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./ExportView.module.css";

/**
 * The idle readiness line: a good-tone dot beside a disclosing summary of what a run would write.
 * Only non-zero parts show, mirroring the scan summary idiom. The unsorted clause carries warn tone
 * (it is excluded from export), and missing-source tracks fall to their own warn line beneath.
 */
export function ExportReadiness({
  albums,
  tracks,
  singles,
  unsorted,
  missing,
}: {
  albums: number;
  tracks: number;
  singles: number;
  unsorted: number;
  missing: number;
}) {
  const t = useT();

  const parts: string[] = [];
  if (albums > 0) {
    parts.push(
      `${t((d) => d.export.albums, { n: albums })}, ${t((d) => d.export.tracks, { n: tracks })}`,
    );
  }
  if (singles > 0) parts.push(t((d) => d.export.singles, { n: singles }));
  const normal = parts.join(" - ");

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
