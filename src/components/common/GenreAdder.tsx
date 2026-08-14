// -- Framework Imports --
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Type Imports --
import type { GenreRow } from "../../types";

// -- Style Imports --
import styles from "./GenreAdder.module.css";

/** A stable empty default so an unset `exclude` never busts the suggestion memo. */
const NO_EXCLUDE: number[] = [];

/** The case- and space-insensitive key, mirroring the backend fold: lowercase, trimmed, runs collapsed. */
function fold(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * A quiet autocomplete for picking a genre from the vocabulary or creating a new one. It reads as plain
 * text until focused, then drops a suggestion list; the one highlighted row is the single accent. Typing
 * filters fold-insensitively, so "rock" surfaces "Rock" and nudges reuse of the existing spelling - the
 * "Create" row shows only when nothing in the vocabulary folds to the typed text. Presentational: the
 * parent owns what a pick or a create does, so the same adder serves Settings and the album aggregate.
 */
export function GenreAdder({
  genres,
  onPick,
  onCreate,
  placeholder,
  exclude = NO_EXCLUDE,
}: {
  genres: GenreRow[];
  onPick: (id: number) => void;
  onCreate: (name: string) => void;
  placeholder?: string;
  exclude?: number[];
}) {
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const t = useT();

  const trimmed = query.trim();
  const qf = fold(query);

  // The vocabulary minus what is already present, filtered by the typed text and ranked so an exact
  // fold sits first, then prefixes, then any other substring - the highlight lands on the closest reuse.
  const suggestions = useMemo(() => {
    const excluded = new Set(exclude);
    const pool = genres.filter((g) => !excluded.has(g.id));
    if (qf === "") return pool;
    const rank = (name: string): number => {
      const f = fold(name);
      if (f === qf) return 0;
      if (f.startsWith(qf)) return 1;
      return 2;
    };
    return pool
      .filter((g) => fold(g.name).includes(qf))
      .sort((a, b) => rank(a.name) - rank(b.name));
  }, [genres, exclude, qf]);

  // Offer to create only when no existing genre - present or not - folds to the typed text, so a mere
  // case or spacing variant routes back to the real one instead of spawning a duplicate.
  const showCreate = trimmed !== "" && !genres.some((g) => fold(g.name) === qf);
  const count = suggestions.length + (showCreate ? 1 : 0);
  const open = focused && count > 0;

  useEffect(() => setHighlight(0), [qf]);

  const commit = (index: number) => {
    if (index < suggestions.length) onPick(suggestions[index].id);
    else if (showCreate) onCreate(trimmed);
    else return;
    setQuery("");
    setHighlight(0);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, count - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      commit(highlight);
    } else if (e.key === "Escape") {
      e.stopPropagation();
      setQuery("");
      e.currentTarget.blur();
    }
  };

  return (
    <div className={styles.wrap}>
      <input
        type="text"
        className={styles.field}
        value={query}
        placeholder={placeholder}
        aria-label={placeholder}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        spellCheck={false}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      />

      {open ? (
        <ul className={styles.menu} role="listbox">
          {suggestions.map((genre, i) => (
            <li key={genre.id}>
              <button
                type="button"
                role="option"
                aria-selected={i === highlight}
                className={i === highlight ? `${styles.option} ${styles.active}` : styles.option}
                // Keep focus on the input so the blur does not close the menu before the click lands.
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => commit(i)}
              >
                {genre.name}
              </button>
            </li>
          ))}
          {showCreate ? (
            <li>
              <button
                type="button"
                role="option"
                aria-selected={highlight === suggestions.length}
                className={
                  highlight === suggestions.length
                    ? `${styles.option} ${styles.create} ${styles.active}`
                    : `${styles.option} ${styles.create}`
                }
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setHighlight(suggestions.length)}
                onClick={() => commit(suggestions.length)}
              >
                {t((d) => d.genre.create, { name: trimmed })}
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
