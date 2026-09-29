// -- Component Imports --
import { SegmentedControl } from "../common/SegmentedControl";

// -- Utils Imports --
import { formatShortDate } from "../../lib/format";

// -- i18n Imports --
import { useLocale, useT } from "../../i18n";
import { ageText } from "../../i18n/ageText";

// -- Type Imports --
import type { ExportScope as Scope, ScopeState } from "./scopeState";
import type { ExportChangeSet } from "../../types";

// -- Style Imports --
import styles from "./ExportView.module.css";

/**
 * The scope toggle over its hints: when this destination was last exported, why a dated snapshot has
 * no changed-only choice, and that a changed-only run never removes anything at the destination.
 */
export function ExportScope({
  scope,
  state,
  changes,
  onScope,
}: {
  scope: Scope;
  state: ScopeState;
  changes: ExportChangeSet | null;
  onScope: (scope: Scope) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const last = changes?.has_record ? changes.last_exported_at : null;
  const changedOnly = scope === "changed" && state !== "snapshotDisabled";

  return (
    <div className={styles.scope}>
      <SegmentedControl
        segments={[
          { value: "all", label: t((d) => d.export.scopeAll) },
          {
            value: "changed",
            label: t((d) => d.export.scopeChanged),
            disabled: state === "snapshotDisabled",
          },
        ]}
        value={changedOnly ? "changed" : "all"}
        onChange={onScope}
        label={t((d) => d.export.scopeLabel)}
      />
      {state === "snapshotDisabled" ? (
        <p className={styles.hint}>{t((d) => d.export.snapshotAll)}</p>
      ) : null}
      {changedOnly && last != null ? (
        <p className={styles.hint}>
          {t((d) => d.export.lastHere, {
            when: ageText(t, last * 1000, Date.now()),
            date: formatShortDate(last, locale),
          })}
        </p>
      ) : null}
      {state === "firstExport" ? (
        <p className={styles.hint}>{t((d) => d.export.firstExport)}</p>
      ) : null}
      {state === "noRecord" ? (
        <>
          <p className={styles.hint}>{t((d) => d.export.noRecord)}</p>
          <p className={styles.hint}>{t((d) => d.export.noRecordHint)}</p>
        </>
      ) : null}
      {state === "everythingChanged" ? (
        <p className={styles.hint}>{t((d) => d.export.layoutChanged)}</p>
      ) : null}
      {changedOnly ? <p className={styles.hint}>{t((d) => d.export.noRemoval)}</p> : null}
    </div>
  );
}
