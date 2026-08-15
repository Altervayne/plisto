// -- Framework Imports --
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

// -- Component Imports --
import { PrimaryButton } from "../common/PrimaryButton";
import { QuietButton } from "../common/QuietButton";
import { ScrollArea } from "../common/ScrollArea/ScrollArea";
import { Tooltip } from "../common/Tooltip";

// -- IPC Imports --
import { extractApply, extractPreview } from "../../lib/ipc";

// -- Type Imports --
import type { Dict } from "../../i18n/en";
import type { ExtractedFields, ExtractResult, ExtractRow } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./ExtractPanel.module.css";

/** How long typing settles before the pattern commits, so the preview refetches once per pause. */
const COMMIT_DELAY = 250;

/** One track handed to the panel: enough to preview it and address it in the write. */
export interface ExtractTrack {
  id: number;
  filename: string;
  path: string;
}

/** A writable extracted field, its snake_case DTO key doubling as the apply key. */
type FieldKey = keyof ExtractedFields;

/**
 * The eight writable fields, each paired with the pattern token that fills it and its label. The token
 * name is not always the field key: the album artist reads from `{albumartist}`, the disc from `{disc}`.
 * A field's toggle is relevant only while its token sits in the pattern.
 */
const FIELDS: { key: FieldKey; token: string; label: (d: Dict) => string }[] = [
  { key: "title", token: "title", label: (d) => d.tracks.fields.title },
  { key: "artist", token: "artist", label: (d) => d.tracks.fields.artist },
  { key: "album", token: "album", label: (d) => d.tracks.fields.album },
  { key: "album_artist", token: "albumartist", label: (d) => d.tracks.fields.albumArtist },
  { key: "year", token: "year", label: (d) => d.tracks.fields.year },
  { key: "disc_no", token: "disc", label: (d) => d.tracks.fields.discNo },
  { key: "track_no", token: "track_no", label: (d) => d.tracks.fields.trackNo },
  { key: "genre", token: "genre", label: (d) => d.tracks.fields.genre },
];

/** Starter patterns filled into the field on a click, the last one spanning path folders. */
const PRESETS = [
  "{track_no} - {artist} - {title}",
  "{track_no} - {title}",
  "{artist} - {title}",
  "{track_no}. {title}",
  "{albumartist}/{album}/{track_no} - {title}",
];

/** The `{token}` names present in a pattern, so a field toggle knows whether its token is in play. */
function tokensIn(pattern: string): Set<string> {
  const found = new Set<string>();
  for (const match of pattern.matchAll(/\{(\w+)\}/g)) found.add(match[1]);
  return found;
}

/**
 * The filename-to-metadata extractor, a dimmed modal over a track selection. The pattern field debounces
 * into a live read-only preview: each row shows a filename and the fields it parsed, or a quiet no-match.
 * A field's write toggle is on by default only while its token sits in the pattern, and can be unchecked;
 * a token-less field is disabled. Apply writes just the checked, parsed fields onto the tracks, then holds
 * the result summary until dismissed. It portals to the body and closes on Escape, a backdrop press, or
 * the close button.
 */
export function ExtractPanel({
  tracks,
  onClose,
  onApplied,
}: {
  tracks: ExtractTrack[];
  onClose: () => void;
  onApplied: () => void;
}) {
  const t = useT();

  const trackIds = useMemo(() => tracks.map((track) => track.id), [tracks]);

  const [draft, setDraft] = useState(PRESETS[0]);
  const [pattern, setPattern] = useState(PRESETS[0]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [rows, setRows] = useState<ExtractRow[] | null>(null);
  // Fields the user has turned off by hand; a relevant field stays on unless it sits here.
  const [unchecked, setUnchecked] = useState<Set<FieldKey>>(() => new Set());

  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ExtractResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Commit the pattern once typing pauses, so the preview and toggles settle per pause, not per keystroke.
  const schedule = useCallback((next: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setPattern(next), COMMIT_DELAY);
  }, []);

  // A preset fills the field and commits at once, skipping the debounce.
  const pickPreset = (preset: string) => {
    if (timer.current) clearTimeout(timer.current);
    setDraft(preset);
    setPattern(preset);
  };

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  // Escape dismisses, matching the backdrop and close button.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Refetch the preview on each committed pattern, dropping a stale async result with the `live` guard.
  // An empty pattern clears the list rather than querying.
  useEffect(() => {
    if (pattern.trim() === "") {
      setRows([]);
      return;
    }
    let live = true;
    void extractPreview(pattern, trackIds)
      .then((next) => {
        if (live) setRows(next);
      })
      .catch(() => {
        if (live) setRows([]);
      });
    return () => {
      live = false;
    };
  }, [pattern, trackIds]);

  const present = useMemo(() => tokensIn(pattern), [pattern]);
  const relevant = (key: FieldKey) => present.has(FIELDS.find((f) => f.key === key)!.token);

  const enabledKeys = useMemo(
    () => FIELDS.filter((f) => present.has(f.token) && !unchecked.has(f.key)).map((f) => f.key),
    [present, unchecked],
  );

  const toggleField = (key: FieldKey) => {
    setUnchecked((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  };

  const matched = rows ? rows.filter((r) => r.matched).length : 0;
  const total = rows ? rows.length : tracks.length;
  const canApply = !pending && enabledKeys.length > 0 && matched > 0;

  const onApply = async () => {
    setError(null);
    setPending(true);
    try {
      const res = await extractApply(pattern, trackIds, enabledKeys);
      setResult(res);
      onApplied();
    } catch {
      setError(t((d) => d.extract.applyError));
    } finally {
      setPending(false);
    }
  };

  return createPortal(
    <div className={styles.overlay}>
      <div className={styles.backdrop} onClick={onClose} aria-hidden="true" />

      <div className={styles.panel} role="dialog" aria-modal="true" aria-label={t((d) => d.extract.title)}>
        <div className={styles.header}>
          <div className={styles.heading}>
            <h2 className={styles.title}>{t((d) => d.extract.title)}</h2>
            <p className={styles.caveat}>{t((d) => d.extract.caveat)}</p>
          </div>
          <QuietButton onClick={onClose} aria-label={t((d) => d.common.close)}>
            {t((d) => d.common.close)}
          </QuietButton>
        </div>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>{t((d) => d.extract.patternLabel)}</span>
          <input
            type="text"
            className={styles.input}
            value={draft}
            spellCheck={false}
            placeholder={t((d) => d.extract.patternPlaceholder)}
            onChange={(e) => {
              setDraft(e.target.value);
              schedule(e.target.value);
            }}
          />
        </label>
        <p className={styles.tokens}>{t((d) => d.export.tokens)}</p>
        <p className={styles.pathHint}>{t((d) => d.extract.pathHint)}</p>

        <div className={styles.presets} role="group" aria-label={t((d) => d.extract.presetsLabel)}>
          {PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              className={styles.preset}
              onClick={() => pickPreset(preset)}
            >
              {preset}
            </button>
          ))}
        </div>

        <div className={styles.summary}>
          {t((d) => d.extract.matched, { matched, total })}
        </div>

        <ScrollArea className={styles.preview}>
          <ul className={styles.list}>
            {(rows ?? []).map((row, i) => {
              const track = tracks[i];
              return (
                <li key={row.track_id} className={styles.row}>
                  <Tooltip label={track?.path}>
                    <span className={styles.filename}>{track?.filename ?? row.track_id}</span>
                  </Tooltip>
                  {row.matched ? (
                    <span className={styles.chips}>
                      {FIELDS.map((f) => {
                        const value = row.fields[f.key];
                        if (value == null || value === "") return null;
                        return (
                          <span key={f.key} className={styles.chip}>
                            <span className={styles.chipKey}>{t(f.label)}</span>
                            <span className={styles.chipValue}>{value}</span>
                          </span>
                        );
                      })}
                    </span>
                  ) : (
                    <span className={styles.noMatch}>{t((d) => d.extract.noMatch)}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </ScrollArea>

        {result ? (
          <div className={styles.result}>
            <p className={styles.resultLine}>
              {t((d) => d.extract.resultUpdated, { n: result.applied })}
              {result.unmatched > 0
                ? `, ${t((d) => d.extract.resultUnmatched, { n: result.unmatched })}`
                : ""}
            </p>
            {result.track_no_skipped_loose > 0 ? (
              <p className={styles.resultSkip}>
                {t((d) => d.extract.resultLooseSkipped, { n: result.track_no_skipped_loose })}
              </p>
            ) : null}
            <PrimaryButton onClick={onClose}>{t((d) => d.common.close)}</PrimaryButton>
          </div>
        ) : (
          <div className={styles.footer}>
            <div className={styles.fields} role="group" aria-label={t((d) => d.extract.fieldsLabel)}>
              {FIELDS.map((f) => {
                const on = relevant(f.key) && !unchecked.has(f.key);
                return (
                  <label
                    key={f.key}
                    className={styles.toggle}
                    data-off={relevant(f.key) ? undefined : ""}
                  >
                    <input
                      type="checkbox"
                      className={styles.check}
                      checked={on}
                      disabled={!relevant(f.key)}
                      onChange={() => toggleField(f.key)}
                    />
                    <span>{t(f.label)}</span>
                  </label>
                );
              })}
            </div>

            <div className={styles.actions}>
              {error ? <span className={styles.error}>{error}</span> : null}
              <PrimaryButton onClick={() => void onApply()} disabled={!canApply}>
                {pending ? t((d) => d.extract.applying) : t((d) => d.extract.apply)}
              </PrimaryButton>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
