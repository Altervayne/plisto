// -- Framework Imports --
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

// -- Component Imports --
import { PrimaryButton } from "../common/PrimaryButton";
import { QuietButton } from "../common/QuietButton";
import { GenreAdder } from "../common/GenreAdder";

// -- Icon Imports --
import { X } from "lucide-react";

// -- Hook Imports --
import { useMountTransition } from "../../hooks/useMountTransition";

// -- State Imports --
import { useGenres, useLoadGenres } from "../../state/organize/store";

// -- IPC Imports --
import { bulkEditTracks } from "../../lib/ipc";

// -- Type Imports --
import type { Dict } from "../../i18n/en";
import type { BulkEditResult, BulkSetFields } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./BulkEditPanel.module.css";

/** The card's exit before it unmounts, matching --dur-soft on the exit keyframe. */
const EXIT_MS = 200;

/** A set-field key, doubling as its BulkSetFields payload key. Title and disc stay per-track. */
type SetKey = "artist" | "album" | "album_artist" | "year";

/** The four set-fields, each with its label; the year takes a numeric input. */
const FIELDS: { key: SetKey; label: (d: Dict) => string; numeric?: boolean }[] = [
  { key: "artist", label: (d) => d.tracks.fields.artist },
  { key: "album", label: (d) => d.tracks.fields.album },
  { key: "album_artist", label: (d) => d.tracks.fields.albumArtist },
  { key: "year", label: (d) => d.tracks.fields.year, numeric: true },
];

/** The case- and space-insensitive key, mirroring the backend fold, so a variant does not double up. */
function fold(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * The bulk tag editor, a dimmed modal over a track selection. Each set-field has an enable toggle and
 * an input: an enabled field writes across every track, and an enabled-but-empty field clears it,
 * while a field left off is untouched. The genre section gathers names to add and names to remove,
 * each a chip list over a vocabulary-suggesting adder that also takes a free-typed name. Apply sends
 * the whole patch, holds the result summary until dismissed, and refreshes the grid through the
 * parent. It portals to the body and closes on Escape, a backdrop press, or the close button.
 */
export function BulkEditPanel({
  trackIds,
  onClose,
  onApplied,
}: {
  trackIds: number[];
  onClose: () => void;
  onApplied: () => void;
}) {
  const t = useT();
  const genres = useGenres();
  const loadGenres = useLoadGenres();

  // The vocabulary is global, so pull it once in case the Organize view never opened.
  useEffect(() => {
    void loadGenres();
  }, [loadGenres]);

  // Own the card's lifetime so a close plays its exit before the parent drops it.
  const [open, setOpen] = useState(true);
  const card = useMountTransition(open, EXIT_MS);
  const requestClose = useCallback(() => setOpen(false), []);
  useEffect(() => {
    if (!card.mounted) onClose();
  }, [card.mounted, onClose]);

  // Which set-fields are turned on, and the text held in each field's input.
  const [enabled, setEnabled] = useState<Set<SetKey>>(() => new Set());
  const [values, setValues] = useState<Record<SetKey, string>>({
    artist: "",
    album: "",
    album_artist: "",
    year: "",
  });
  // The genre names queued to add and to remove, each shown as a removable chip.
  const [addNames, setAddNames] = useState<string[]>([]);
  const [removeNames, setRemoveNames] = useState<string[]>([]);

  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<BulkEditResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Escape dismisses, matching the backdrop and close button.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  const toggleField = (key: SetKey) => {
    setEnabled((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  };

  const setValue = (key: SetKey, raw: string) => {
    // The year holds digits only; the others take free text.
    const value = key === "year" ? raw.replace(/[^0-9]/g, "") : raw;
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  // Append a genre name to a queue, folding to skip a spelling already present. A pick resolves its id
  // to the vocabulary name; a create passes the typed text straight through.
  const queueName = (setNames: typeof setAddNames, name: string) => {
    const trimmed = name.trim();
    if (trimmed === "") return;
    setNames((prev) => (prev.some((n) => fold(n) === fold(trimmed)) ? prev : [...prev, trimmed]));
  };
  const dropName = (setNames: typeof setAddNames, name: string) => {
    setNames((prev) => prev.filter((n) => n !== name));
  };

  // The vocabulary ids already queued in a list, so the adder stops suggesting them again.
  const excludeFor = (names: string[]) => {
    const queued = new Set(names.map(fold));
    return genres.filter((g) => queued.has(fold(g.name))).map((g) => g.id);
  };
  const addExclude = useMemo(() => excludeFor(addNames), [genres, addNames]);
  const removeExclude = useMemo(() => excludeFor(removeNames), [genres, removeNames]);

  const nameOf = (id: number) => genres.find((g) => g.id === id)?.name;

  const canApply =
    !pending && (enabled.size > 0 || addNames.length > 0 || removeNames.length > 0);

  const onApply = async () => {
    setError(null);
    setPending(true);
    try {
      const set: BulkSetFields = {};
      for (const field of FIELDS) {
        if (enabled.has(field.key)) set[field.key] = values[field.key].trim();
      }
      const res = await bulkEditTracks(trackIds, set, addNames, removeNames);
      setResult(res);
      onApplied();
    } catch {
      setError(t((d) => d.bulkEdit.applyError));
    } finally {
      setPending(false);
    }
  };

  if (!card.mounted) return null;

  return createPortal(
    <div className={styles.overlay} data-state={card.state}>
      <div className={styles.backdrop} onClick={requestClose} aria-hidden="true" />

      <div
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label={t((d) => d.bulkEdit.title)}
      >
        <div className={styles.header}>
          <div className={styles.heading}>
            <h2 className={styles.title}>{t((d) => d.bulkEdit.title)}</h2>
            <p className={styles.summary}>
              {t((d) => d.bulkEdit.summary, { n: trackIds.length })}
            </p>
          </div>
          <QuietButton onClick={requestClose} aria-label={t((d) => d.common.close)}>
            {t((d) => d.common.close)}
          </QuietButton>
        </div>

        {result ? (
          <div className={styles.result}>
            <p className={styles.resultLine}>
              {t((d) => d.bulkEdit.applied, { n: result.edited })}
            </p>
            <PrimaryButton onClick={requestClose}>{t((d) => d.common.close)}</PrimaryButton>
          </div>
        ) : (
          <>
            <div className={styles.fields} role="group" aria-label={t((d) => d.bulkEdit.fields)}>
              {FIELDS.map((field) => {
                const on = enabled.has(field.key);
                return (
                  <div key={field.key} className={styles.row}>
                    <label className={styles.toggle} data-off={on ? undefined : ""}>
                      <input
                        type="checkbox"
                        className={styles.check}
                        checked={on}
                        onChange={() => toggleField(field.key)}
                      />
                      <span>{t(field.label)}</span>
                    </label>
                    <input
                      type="text"
                      className={styles.input}
                      value={values[field.key]}
                      disabled={!on}
                      spellCheck={false}
                      inputMode={field.numeric ? "numeric" : undefined}
                      aria-label={t(field.label)}
                      onChange={(e) => setValue(field.key, e.target.value)}
                    />
                  </div>
                );
              })}
            </div>
            <p className={styles.hint}>{t((d) => d.bulkEdit.setHint)}</p>

            <div className={styles.genres}>
              <div className={styles.genreGroup}>
                <span className={styles.groupLabel}>{t((d) => d.bulkEdit.addGenres)}</span>
                <div className={styles.chips}>
                  {addNames.map((name) => (
                    <span key={name} className={styles.chip}>
                      <span className={styles.chipName}>{name}</span>
                      <button
                        type="button"
                        className={styles.chipRemove}
                        aria-label={t((d) => d.genre.pillRemove)}
                        onClick={() => dropName(setAddNames, name)}
                      >
                        <X size={12} strokeWidth={3} />
                      </button>
                    </span>
                  ))}
                  <div className={styles.adder}>
                    <GenreAdder
                      genres={genres}
                      exclude={addExclude}
                      onPick={(id) => {
                        const name = nameOf(id);
                        if (name) queueName(setAddNames, name);
                      }}
                      onCreate={(name) => queueName(setAddNames, name)}
                      placeholder={t((d) => d.bulkEdit.addPlaceholder)}
                    />
                  </div>
                </div>
              </div>

              <div className={styles.genreGroup}>
                <span className={styles.groupLabel}>{t((d) => d.bulkEdit.removeGenres)}</span>
                <div className={styles.chips}>
                  {removeNames.map((name) => (
                    <span key={name} className={styles.chip}>
                      <span className={styles.chipName}>{name}</span>
                      <button
                        type="button"
                        className={styles.chipRemove}
                        aria-label={t((d) => d.genre.pillRemove)}
                        onClick={() => dropName(setRemoveNames, name)}
                      >
                        <X size={12} strokeWidth={3} />
                      </button>
                    </span>
                  ))}
                  <div className={styles.adder}>
                    <GenreAdder
                      genres={genres}
                      exclude={removeExclude}
                      onPick={(id) => {
                        const name = nameOf(id);
                        if (name) queueName(setRemoveNames, name);
                      }}
                      onCreate={(name) => queueName(setRemoveNames, name)}
                      placeholder={t((d) => d.bulkEdit.removePlaceholder)}
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className={styles.footer}>
              {error ? <span className={styles.error}>{error}</span> : null}
              <PrimaryButton onClick={() => void onApply()} disabled={!canApply}>
                {pending ? t((d) => d.bulkEdit.applying) : t((d) => d.bulkEdit.apply)}
              </PrimaryButton>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
