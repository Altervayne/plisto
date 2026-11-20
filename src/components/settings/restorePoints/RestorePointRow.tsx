// -- Framework Imports --
import type { ReactNode } from "react";

// -- Component Imports --
import { Tooltip } from "../../common/Tooltip";

// -- Utils Imports --
import { formatDateTime } from "../../../lib/format";
import { ageText } from "../../../i18n/ageText";
import { kindLabel } from "./kindLabel";
import { pointKind } from "./restorePointModel";

// -- i18n Imports --
import { useLocale, useT } from "../../../i18n";

// -- Type Imports --
import type { RestorePointRow as Row } from "../../../types";

// -- Style Imports --
import styles from "./RestorePoints.module.css";

// A middle dot between the facts of a line, spelled by code point to keep the source ASCII.
const SEP = ` ${String.fromCharCode(0xb7)} `;

/**
 * One restore point on the continuous surface, twin to the folder row: the kind over a quiet line of
 * absolute date, app version and counts, with the relative date in the tooltip. A point that cannot be
 * read, or was made by a newer Plisto, is flagged and has no Restore. Only counts show, never a diff.
 */
export function RestorePointRow({
  row,
  canRestore,
  onRestore,
  now = Date.now(),
}: {
  row: Row;
  canRestore: boolean;
  onRestore: (row: Row) => void;
  now?: number;
}) {
  const t = useT();
  const locale = useLocale();
  const when = formatDateTime(row.created_at, locale);
  const status = row.status;
  let meta: string;
  let warn: string | null = null;
  let trailing: ReactNode;
  if (status.kind === "unreadable") {
    meta = when;
    warn = t((d) => d.restorePoints.unreadableLine);
    trailing = <span className={`${styles.tag} ${styles.warnTag}`}>{t((d) => d.restorePoints.unreadable)}</span>;
  } else if (status.kind === "newer") {
    meta = `${when}${SEP}${t((d) => d.restorePoints.newerLine)}`;
    trailing = <span className={styles.tag}>{t((d) => d.restorePoints.newer)}</span>;
  } else {
    meta = [
      when,
      t((d) => d.restorePoints.appVersion, { version: status.app_version }),
      t((d) => d.restorePoints.albums, { n: status.albums }),
      t((d) => d.restorePoints.singles, { n: status.singles }),
      t((d) => d.restorePoints.playlists, { n: status.playlists }),
    ].join(SEP);
    trailing = (
      <button type="button" className={styles.restore} disabled={!canRestore} onClick={() => onRestore(row)}>
        {t((d) => d.restorePoints.restore)}
      </button>
    );
  }

  return (
    <Tooltip label={ageText(t, row.created_at, now)}>
      <div className={styles.row} data-point={row.file}>
        <div className={styles.main}>
          <span className={styles.name}>{kindLabel(t, pointKind(row))}</span>
          <span className={styles.meta}>
            {meta}
            {warn ? (
              <>
                {SEP}
                <span className={styles.warn}>{warn}</span>
              </>
            ) : null}
          </span>
        </div>
        {trailing}
      </div>
    </Tooltip>
  );
}
