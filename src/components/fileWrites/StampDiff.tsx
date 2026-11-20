// -- Framework Imports --
import { memo, useMemo, useState } from "react";

// -- Icon Imports --
import { ArrowRight, ChevronDown } from "lucide-react";

// -- Component Imports --
import { StampFileList } from "./StampRows";

// -- Utils Imports --
import { CHANGE_ROW_LIMIT, fieldsOf, groupByChange, planRef } from "../../lib/stampShape";
import type { ChangeRow } from "../../lib/stampShape";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Type Imports --
import type { StampFilePlan } from "../../types";

// -- Style Imports --
import styles from "./StampDiff.module.css";

export type DiffView = "change" | "file";

/** One field's change and the files it touches; opens to name them. */
const DiffRow = memo(function DiffRow({ row }: { row: ChangeRow }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const field = t((d) => d.fileWrites.field[row.field]);
  // Only a title change is worth its before and after on the file's own line.
  const fromTo =
    row.field === "title" && row.from != null
      ? t((d) => d.fileWrites.stamp.fromTo, { from: row.from, to: row.to })
      : undefined;
  const whatOf = fromTo ? () => fromTo : undefined;
  return (
    <div className={styles.list}>
      <div className={styles.row}>
        <button
          type="button"
          className={styles.toggle}
          data-open={open}
          aria-expanded={open}
          aria-label={field}
          onClick={() => setOpen((v) => !v)}
        >
          <ChevronDown size={14} strokeWidth={1.8} aria-hidden="true" />
        </button>
        <span className={styles.field}>{field}</span>
        <span className={styles.change}>
          {row.from == null || row.from === "" ? (
            <span className={`${styles.from} ${styles.empty}`}>{t((d) => d.fileWrites.empty)}</span>
          ) : (
            <span className={styles.from}>{row.from}</span>
          )}
          <span className={styles.arrow}>
            <ArrowRight size={13} strokeWidth={1.8} aria-hidden="true" />
          </span>
          <span className={styles.to}>{row.to}</span>
        </span>
        <span className={styles.count}>{t((d) => d.fileWrites.files, { n: row.files.length })}</span>
      </div>
      {open ? <StampFileList tracks={row.files} whatOf={whatOf} /> : null}
    </div>
  );
});

/** The diff of a preview, by change (grouped, expandable to files) or by file. */
export const StampDiff = memo(function StampDiff({ files, view }: { files: StampFilePlan[]; view: DiffView }) {
  const t = useT();
  const [limit, setLimit] = useState(CHANGE_ROW_LIMIT);
  const grouped = useMemo(() => (view === "change" ? groupByChange(files, limit) : null), [files, view, limit]);
  const refs = useMemo(() => files.map(planRef), [files]);
  const labels = useMemo(() => {
    if (view !== "file") return null;
    return new Map(
      files.map((file) => [
        file.trackId,
        fieldsOf(file.changes)
          .map((field) => t((d) => d.fileWrites.field[field]))
          .join(", "),
      ]),
    );
  }, [files, view, t]);

  if (grouped) {
    return (
      <div className={styles.list}>
        {grouped.rows.map((row) => (
          <DiffRow key={row.key} row={row} />
        ))}
        {grouped.hiddenFiles > 0 ? (
          <button type="button" className={styles.more} onClick={() => setLimit((n) => n + CHANGE_ROW_LIMIT)}>
            {t((d) => d.fileWrites.stamp.showMore, { n: grouped.hiddenFiles })}
          </button>
        ) : null}
      </div>
    );
  }
  return <StampFileList tracks={refs} flat whatOf={(track) => labels?.get(track.trackId)} />;
});
