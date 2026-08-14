// -- Framework Imports --
import { useState } from "react";

// -- Component Imports --
import { EditableField } from "../common/EditableField/EditableField";
import { QuietButton } from "../common/QuietButton";

// -- Icon Imports --
import { Merge, Trash2 } from "lucide-react";

// -- State Imports --
import {
  useDeleteGenre,
  useGenreRemovalImpact,
  useMergeGenres,
  useRenameGenre,
} from "../../state/organize/store";

// -- Type Imports --
import type { GenreRow } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./GenreSettingRow.module.css";

/** Idle, then either arming a merge target pick or a counted delete confirm. */
type Mode = "idle" | "merge" | "delete";

/**
 * One vocabulary genre as a quiet row: an inline-editable name, its dimmed usage count, and reveal
 * glyphs for merge and delete. Neither destructive action is bare - merge picks a target then arms a
 * counted confirm naming the tracks that move, and delete first reads the removal impact before its
 * counted confirm. A rejected rename is reverted by remounting the field once the store reloads.
 */
export function GenreSettingRow({ genre, genres }: { genre: GenreRow; genres: GenreRow[] }) {
  const renameGenre = useRenameGenre();
  const deleteGenre = useDeleteGenre();
  const mergeGenres = useMergeGenres();
  const genreRemovalImpact = useGenreRemovalImpact();
  const t = useT();

  const [mode, setMode] = useState<Mode>("idle");
  const [target, setTarget] = useState<GenreRow | null>(null);
  const [impact, setImpact] = useState(0);
  // Bumped after every rename resolves, remounting the field so a rejected name reverts to the stored one.
  const [rev, setRev] = useState(0);

  const others = genres.filter((g) => g.id !== genre.id);

  const reset = () => {
    setMode("idle");
    setTarget(null);
  };

  const onRename = (next: string) => {
    // A genre name is never empty; drop an empty commit and let the field re-seed from the store.
    if (next === "") return;
    void renameGenre(genre.id, next).finally(() => setRev((r) => r + 1));
  };

  const onDeleteClick = async () => {
    setImpact(await genreRemovalImpact(genre.id));
    setMode("delete");
  };

  const onConfirmMerge = async () => {
    if (!target) return;
    reset();
    await mergeGenres(genre.id, target.id);
  };

  const onConfirmDelete = async () => {
    reset();
    await deleteGenre(genre.id);
  };

  return (
    <div className={styles.rowWrap}>
      <div className={styles.row}>
        <div className={styles.main}>
          <EditableField
            key={rev}
            value={genre.name}
            ariaLabel={t((d) => d.settings.renameGenre)}
            onCommit={onRename}
          />
        </div>
        <span className={styles.count}>
          {t((d) => d.settings.genreUsed, { n: genre.track_count })}
        </span>
        <div className={styles.controls}>
          <button
            type="button"
            className={styles.glyph}
            aria-label={t((d) => d.settings.mergeGenre)}
            onClick={() => {
              setTarget(null);
              setMode("merge");
            }}
            disabled={others.length === 0}
          >
            <Merge size={15} strokeWidth={1.8} />
          </button>
          <button
            type="button"
            className={`${styles.glyph} ${styles.remove}`}
            aria-label={t((d) => d.settings.removeGenre)}
            onClick={() => void onDeleteClick()}
          >
            <Trash2 size={15} strokeWidth={1.8} />
          </button>
        </div>
      </div>

      {mode === "merge" && !target ? (
        <div className={styles.picker}>
          <span className={styles.prompt}>{t((d) => d.settings.mergeInto)}</span>
          {others.map((g) => (
            <QuietButton key={g.id} onClick={() => setTarget(g)}>
              {g.name}
            </QuietButton>
          ))}
          <QuietButton onClick={reset}>{t((d) => d.common.cancel)}</QuietButton>
        </div>
      ) : null}

      {mode === "merge" && target ? (
        <div className={styles.confirm}>
          <span className={styles.prompt}>
            {t((d) => d.settings.mergeConfirm, {
              n: genre.track_count,
              name: target.name,
              old: genre.name,
            })}
          </span>
          <QuietButton onClick={() => void onConfirmMerge()}>
            {t((d) => d.settings.mergeAction)}
          </QuietButton>
          <QuietButton onClick={reset}>{t((d) => d.common.cancel)}</QuietButton>
        </div>
      ) : null}

      {mode === "delete" ? (
        <div className={styles.confirm}>
          <span className={styles.prompt}>
            {t((d) => d.settings.removeGenreConfirm, { n: impact, name: genre.name })}
          </span>
          <QuietButton onClick={() => void onConfirmDelete()}>
            {t((d) => d.settings.removeAction)}
          </QuietButton>
          <QuietButton onClick={reset}>{t((d) => d.common.cancel)}</QuietButton>
        </div>
      ) : null}
    </div>
  );
}
