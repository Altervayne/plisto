// -- Framework Imports --
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

// -- Component Imports --
import { PrimaryButton } from "../common/PrimaryButton";
import { QuietButton } from "../common/QuietButton";

// -- Icon Imports --
import { ArrowRight } from "lucide-react";

// -- Hook Imports --
import { useMountTransition } from "../../hooks/useMountTransition";

// -- IPC Imports --
import { applyTrackTitles } from "../../lib/ipc";

// -- Utils Imports --
import { sanitizeTitle } from "./sanitizeTitle";

// -- Type Imports --
import type { AppliedResult } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./CleanTitlesPanel.module.css";

/** The card's exit before it unmounts, matching --dur-soft on the exit keyframe. */
const EXIT_MS = 200;

/** One title that sanitizing would change: the track, its current title, and the cleaned one. */
type CleanRow = { id: number; before: string; after: string };

/**
 * The title cleaner, a dimmed modal over a track selection. It sanitizes each selected title, then lists
 * only the ones sanitizing would change - each a before-to-after diff with a checkbox, all on by default
 * - and a quiet count of the titles already clean. Apply writes the checked cleaned titles through the
 * ipc, holds the result summary until dismissed, and refreshes the grid through the parent. When nothing
 * would change it shows an empty-state line and no Apply. It portals to the body and closes on Escape, a
 * backdrop press, or the close button.
 */
export function CleanTitlesPanel({
  tracks,
  onClose,
  onApplied,
}: {
  tracks: { id: number; title: string }[];
  onClose: () => void;
  onApplied: () => void;
}) {
  const t = useT();

  // The rows sanitizing would actually change, computed once over the snapshot.
  const rows = useMemo<CleanRow[]>(
    () =>
      tracks
        .map((track) => ({ id: track.id, before: track.title, after: sanitizeTitle(track.title) }))
        .filter((row) => row.after !== row.before),
    [tracks],
  );
  const alreadyClean = tracks.length - rows.length;

  // Own the card's lifetime so a close plays its exit before the parent drops it.
  const [open, setOpen] = useState(true);
  const card = useMountTransition(open, EXIT_MS);
  const requestClose = useCallback(() => setOpen(false), []);
  useEffect(() => {
    if (!card.mounted) onClose();
  }, [card.mounted, onClose]);

  // Which rows are checked to clean, all on to start.
  const [checked, setChecked] = useState<Set<number>>(() => new Set(rows.map((row) => row.id)));

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

  const toggle = (id: number) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  };

  const canApply = !pending && checked.size > 0;

  const onApply = async () => {
    setError(null);
    setPending(true);
    try {
      const titles = rows
        .filter((row) => checked.has(row.id))
        .map((row) => ({ trackId: row.id, title: row.after }));
      const res = await applyTrackTitles(titles);
      setResult(res);
      onApplied();
    } catch {
      setError(t((d) => d.cleanTitles.applyError));
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
        aria-label={t((d) => d.cleanTitles.title)}
      >
        <div className={styles.header}>
          <div className={styles.heading}>
            <h2 className={styles.title}>{t((d) => d.cleanTitles.title)}</h2>
            {alreadyClean > 0 ? (
              <p className={styles.summary}>
                {t((d) => d.cleanTitles.alreadyClean, { n: alreadyClean })}
              </p>
            ) : null}
          </div>
          <QuietButton onClick={requestClose} aria-label={t((d) => d.common.close)}>
            {t((d) => d.common.close)}
          </QuietButton>
        </div>

        {result ? (
          <div className={styles.result}>
            <p className={styles.resultLine}>
              {t((d) => d.cleanTitles.applied, { n: result.tracks })}
            </p>
            <PrimaryButton onClick={requestClose}>{t((d) => d.common.close)}</PrimaryButton>
          </div>
        ) : rows.length === 0 ? (
          <p className={styles.empty}>{t((d) => d.cleanTitles.empty)}</p>
        ) : (
          <>
            <div className={styles.list} role="group" aria-label={t((d) => d.cleanTitles.title)}>
              {rows.map((row) => (
                <label key={row.id} className={styles.row}>
                  <input
                    type="checkbox"
                    className={styles.check}
                    checked={checked.has(row.id)}
                    onChange={() => toggle(row.id)}
                  />
                  <span className={styles.diff}>
                    <span className={styles.before} title={row.before}>
                      {row.before}
                    </span>
                    <ArrowRight className={styles.arrow} size={13} strokeWidth={2.5} />
                    <span className={styles.after} title={row.after}>
                      {row.after}
                    </span>
                  </span>
                </label>
              ))}
            </div>

            <div className={styles.footer}>
              {error ? <span className={styles.error}>{error}</span> : null}
              <PrimaryButton onClick={() => void onApply()} disabled={!canApply}>
                {pending ? t((d) => d.cleanTitles.applying) : t((d) => d.cleanTitles.apply)}
              </PrimaryButton>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
