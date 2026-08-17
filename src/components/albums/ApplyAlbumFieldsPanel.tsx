// -- Framework Imports --
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

// -- Component Imports --
import { PrimaryButton } from "../common/PrimaryButton";
import { QuietButton } from "../common/QuietButton";

// -- Hook Imports --
import { useMountTransition } from "../../hooks/useMountTransition";

// -- State Imports --
import { useAlbumGenreAggregate } from "../../state/organize/store";

// -- Utils Imports --
import { formatYear } from "./yearField";

// -- IPC Imports --
import { applyAlbumFieldsToMembers } from "../../lib/ipc";

// -- Type Imports --
import type { Dict } from "../../i18n/en";
import type { AlbumRow, AppliedResult } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./ApplyAlbumFieldsPanel.module.css";

/** The card's exit before it unmounts, matching --dur-soft on the exit keyframe. */
const EXIT_MS = 200;

/** A chosen field, doubling as its command-flag key. Album name is deliberately absent. */
type FieldKey = "albumArtist" | "year" | "genre";

/** The three forceable fields, each with its label. Album name is hard-replaced on export, not here. */
const FIELDS: { key: FieldKey; label: (d: Dict) => string }[] = [
  { key: "albumArtist", label: (d) => d.albums.albumArtist },
  { key: "year", label: (d) => d.albums.year },
  { key: "genre", label: (d) => d.albums.genres },
];

/**
 * The force-apply modal over one album: three checkboxes - album artist, year, genre - each showing the
 * album's current value as a quiet subtitle, all checked by default. Apply writes the checked fields onto
 * every member track, overwriting each track's own value (genre unifies to the members' union instead), then
 * holds the count until dismissed and refreshes the caller. It portals to the body and closes on Escape, a
 * backdrop press, or the close button.
 */
export function ApplyAlbumFieldsPanel({
  album,
  onClose,
  onApplied,
}: {
  album: AlbumRow;
  onClose: () => void;
  onApplied: () => void;
}) {
  const t = useT();
  const { entries } = useAlbumGenreAggregate(album.id);

  // Own the card's lifetime so a close plays its exit before the parent drops it.
  const [open, setOpen] = useState(true);
  const card = useMountTransition(open, EXIT_MS);
  const requestClose = useCallback(() => setOpen(false), []);
  useEffect(() => {
    if (!card.mounted) onClose();
  }, [card.mounted, onClose]);

  // Every field starts checked: the common case forces the whole set onto the members.
  const [enabled, setEnabled] = useState<Set<FieldKey>>(
    () => new Set<FieldKey>(["albumArtist", "year", "genre"]),
  );

  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<AppliedResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Escape dismisses, matching the backdrop and close button.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  const toggleField = (key: FieldKey) => {
    setEnabled((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  };

  // The album's current value for each field, shown as a quiet subtitle; an unset field reads "not set".
  const genreNames = entries.map((e) => e.genre.name).join(", ");
  const subtitleFor = (key: FieldKey): string => {
    const none = t((d) => d.applyAlbum.none);
    if (key === "albumArtist") return album.album_artist ?? none;
    if (key === "year") return formatYear(album.year) || none;
    return genreNames || none;
  };

  const canApply = !pending && enabled.size > 0;

  const onApply = async () => {
    setError(null);
    setPending(true);
    try {
      const res = await applyAlbumFieldsToMembers(album.id, {
        albumArtist: enabled.has("albumArtist"),
        year: enabled.has("year"),
        genre: enabled.has("genre"),
      });
      setResult(res);
      onApplied();
    } catch {
      setError(t((d) => d.applyAlbum.applyError));
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
        aria-label={t((d) => d.applyAlbum.title)}
      >
        <div className={styles.header}>
          <div className={styles.heading}>
            <h2 className={styles.title}>{t((d) => d.applyAlbum.title)}</h2>
          </div>
          <QuietButton onClick={requestClose} aria-label={t((d) => d.common.close)}>
            {t((d) => d.common.close)}
          </QuietButton>
        </div>

        {result ? (
          <div className={styles.result}>
            <p className={styles.resultLine}>
              {t((d) => d.applyAlbum.applied, { n: result.tracks })}
            </p>
            <PrimaryButton onClick={requestClose}>{t((d) => d.common.close)}</PrimaryButton>
          </div>
        ) : (
          <>
            <div className={styles.fields} role="group" aria-label={t((d) => d.applyAlbum.title)}>
              {FIELDS.map((field) => {
                const on = enabled.has(field.key);
                return (
                  <label key={field.key} className={styles.row} data-off={on ? undefined : ""}>
                    <input
                      type="checkbox"
                      className={styles.check}
                      checked={on}
                      onChange={() => toggleField(field.key)}
                    />
                    <span className={styles.text}>
                      <span className={styles.name}>{t(field.label)}</span>
                      <span className={styles.subtitle}>{subtitleFor(field.key)}</span>
                    </span>
                  </label>
                );
              })}
            </div>
            <p className={styles.hint}>{t((d) => d.applyAlbum.hint)}</p>

            <div className={styles.footer}>
              {error ? <span className={styles.error}>{error}</span> : null}
              <PrimaryButton onClick={() => void onApply()} disabled={!canApply}>
                {pending ? t((d) => d.applyAlbum.applying) : t((d) => d.applyAlbum.apply)}
              </PrimaryButton>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
