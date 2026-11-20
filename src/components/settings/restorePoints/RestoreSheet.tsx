// -- Component Imports --
import { ConfirmDialog } from "../../common/ConfirmDialog/ConfirmDialog";
import { LostFacts } from "./LostFacts";
import { UnmatchedList } from "./UnmatchedList";

// -- Utils Imports --
import { formatDateTime } from "../../../lib/format";
import { lostItems } from "./restorePointModel";

// -- i18n Imports --
import { useLocale, useT } from "../../../i18n";

// -- Type Imports --
import type { RestorePointRow, RestoreSummary } from "../../../types";

// -- Style Imports --
import styles from "./RestorePoints.module.css";

function Stat({ n, label, locale }: { n: number; label: string; locale: string }) {
  return (
    <div className={styles.stat}>
      <span className={`${styles.statNumber} ${n === 0 ? styles.statDim : ""}`}>{n.toLocaleString(locale)}</span>
      <span className={styles.statLabel}>{label}</span>
    </div>
  );
}

/**
 * The sheet before a restore, from the dry run: the counts that come back, then only what is lost, the
 * unmatched tracks when some are missing, and the line that a point of right now is saved first. The
 * confirm is plain, since a restore is undoable; when no track is found it warns and still lets it
 * through. Cancel holds focus.
 */
export function RestoreSheet({
  row,
  summary,
  onConfirm,
  onClose,
}: {
  row: RestorePointRow;
  summary: RestoreSummary;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const lost = lostItems(summary);
  const status = row.status.kind === "ready" ? row.status : null;
  const edits = status?.edited_tracks ?? 0;
  const genres = status?.genre_tracks ?? 0;

  let comeBack: string | null = null;
  if (!lost.allUnmatched) {
    if (edits > 0 && genres > 0) {
      comeBack = t((d) => d.restorePoints.comeBackBoth, {
        edits: t((d) => d.restorePoints.tracks, { n: edits }),
        genres: t((d) => d.restorePoints.tracks, { n: genres }),
      });
    } else if (edits > 0) {
      comeBack = t((d) => d.restorePoints.comeBackEdits, { tracks: t((d) => d.restorePoints.tracks, { n: edits }) });
    } else if (genres > 0) {
      comeBack = t((d) => d.restorePoints.comeBackGenres, { tracks: t((d) => d.restorePoints.tracks, { n: genres }) });
    }
  }

  return (
    <ConfirmDialog
      open
      width="wide"
      title={t((d) => d.restorePoints.sheetTitle, { when: formatDateTime(row.created_at, locale) })}
      prompt={t((d) => d.restorePoints.sheetPrompt)}
      confirmLabel={t((d) => d.restorePoints.confirm)}
      cancelLabel={t((d) => d.common.cancel)}
      onConfirm={onConfirm}
      onClose={onClose}
    >
      <div className={styles.body}>
        <div className={styles.stats}>
          <Stat n={summary.albums} label={t((d) => d.restorePoints.statAlbums)} locale={locale} />
          <Stat n={summary.singles} label={t((d) => d.restorePoints.statSingles)} locale={locale} />
          <Stat n={summary.playlists} label={t((d) => d.restorePoints.statPlaylists)} locale={locale} />
        </div>
        {lost.allUnmatched ? (
          <div className={styles.warnBox}>
            <b>{t((d) => d.restorePoints.allTitle)}</b>
            <span>
              {summary.playlists > 0
                ? t((d) => d.restorePoints.allLine, { n: summary.playlists })
                : t((d) => d.restorePoints.allLineNone)}
            </span>
          </div>
        ) : null}
        <LostFacts
          summary={summary}
          foundLine
          lead={comeBack ? <li>{comeBack}</li> : null}
        />
        {summary.unmatched.length > 0 && !lost.allUnmatched ? <UnmatchedList groups={summary.unmatched} showPaths={false} /> : null}
        <p className={styles.safe}>{t((d) => d.restorePoints.safe)}</p>
      </div>
    </ConfirmDialog>
  );
}
