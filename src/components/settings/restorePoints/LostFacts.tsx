// -- Framework Imports --
import type { ReactNode } from "react";

// -- Utils Imports --
import { lostItems } from "./restorePointModel";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Type Imports --
import type { RestoreSummary } from "../../../types";

// -- Style Imports --
import styles from "./RestorePoints.module.css";

/**
 * The fact lines under a restore's counts: only what is lost, in the warn tone, after any `lead` lines.
 * `foundLine` adds the good line when nothing is missing, for the sheet that asks before the restore.
 */
export function LostFacts({
  summary,
  lead,
  foundLine = false,
}: {
  summary: RestoreSummary;
  lead?: ReactNode;
  foundLine?: boolean;
}) {
  const t = useT();
  const lost = lostItems(summary);
  return (
    <ul className={styles.facts}>
      {lead}
      {foundLine && lost.notFound === 0 ? (
        <li className={styles.factGood}>{t((d) => d.restorePoints.allFound)}</li>
      ) : null}
      {lost.notFound > 0 ? (
        <li className={styles.factWarn}>{t((d) => d.restorePoints.notFound, { n: lost.notFound })}</li>
      ) : null}
      {lost.notRecreated > 0 ? (
        <li className={lost.allUnmatched ? styles.factWarn : undefined}>
          {lost.allUnmatched
            ? t((d) => d.restorePoints.notRecreatedAll, { n: lost.notRecreated })
            : t((d) => d.restorePoints.notRecreated, { n: lost.notRecreated })}
        </li>
      ) : null}
      {lost.cleared > 0 ? <li>{t((d) => d.restorePoints.cleared, { n: lost.cleared })}</li> : null}
    </ul>
  );
}
