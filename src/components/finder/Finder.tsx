// -- Framework Imports --
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { createPortal } from "react-dom";

// -- Icon Imports --
import { Search } from "lucide-react";

// -- Component Imports --
import { FinderResults } from "./FinderResults";

// -- Hook Imports --
import { useMountTransition } from "../../hooks/useMountTransition";
import { useFinderActions, isPlayable } from "./useFinderActions";
import { useFinderModel } from "./useFinderModel";

// -- State Imports --
import { useLoadGenres } from "../../state/organize/store";
import { usePlayerEnabled } from "../../state/player/store";

// -- Type Imports --
import type { FinderNav } from "./useFinderActions";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./Finder.module.css";

/** The card's exit before it unmounts, matching --dur-soft on the exit keyframe. */
const EXIT_MS = 200;

/**
 * The quick finder: a palette over the whole app that searches the library and jumps to what it finds.
 * Focus stays in the search input throughout; the arrow keys move a cursor over the rows, Enter goes
 * there, and with the player on, Ctrl+Enter plays and Shift+Enter queues. Any action closes it. The
 * search runs on every keystroke over a prebuilt index. Portals to the body.
 */
export function Finder({ nav, onClose }: { nav: FinderNav; onClose: () => void }) {
  const t = useT();
  const playerEnabled = usePlayerEnabled();
  const loadGenres = useLoadGenres();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const model = useFinderModel(query);
  const actions = useFinderActions(nav);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();
  const rowId = (index: number) => `${listId}-${index}`;
  const count = model.items.length;
  const active = Math.min(cursor, count - 1);

  // Own the card's lifetime so a close plays its exit before the parent drops it.
  const [open, setOpen] = useState(true);
  const card = useMountTransition(open, EXIT_MS);
  const requestClose = useCallback(() => setOpen(false), []);
  useEffect(() => {
    if (!card.mounted) onClose();
  }, [card.mounted, onClose]);

  // The genre vocabulary loads lazily elsewhere, so pull it in case nothing has yet.
  useEffect(() => {
    void loadGenres();
  }, [loadGenres]);

  // Escape still closes when focus has strayed from the input.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  // Keep the cursor row on screen as the keys walk past the list's edge.
  useEffect(() => {
    viewportRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  // A closing card ignores input, so a second press during the exit never acts twice.
  const activate = (index: number) => {
    const item = model.items[index];
    if (!open || !item) return;
    if (item.type === "showAll") {
      actions.showAllTracks(query.trim());
    } else {
      model.remember(item.entry);
      actions.open(item.entry);
    }
    requestClose();
  };

  const playAt = (index: number, mode: "play" | "enqueue") => {
    const item = model.items[index];
    if (!open || !playerEnabled || item?.type !== "entry" || !isPlayable(item.entry)) return;
    if (mode === "play") actions.play(item.entry);
    else actions.enqueue(item.entry);
    requestClose();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setCursor(Math.min(active + 1, count - 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setCursor(Math.max(active - 1, 0));
        break;
      case "Home":
        event.preventDefault();
        setCursor(0);
        break;
      case "End":
        event.preventDefault();
        setCursor(Math.max(count - 1, 0));
        break;
      case "Enter":
        event.preventDefault();
        if (event.ctrlKey || event.metaKey) playAt(active, "play");
        else if (event.shiftKey) playAt(active, "enqueue");
        else activate(active);
        break;
      // Held here so a peek or drawer listening on the document underneath stays open.
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        requestClose();
        break;
    }
  };

  if (!card.mounted) return null;

  const legend = [
    t((d) => d.finder.keyOpen),
    ...(playerEnabled ? [t((d) => d.finder.keyPlay), t((d) => d.finder.keyQueue)] : []),
    t((d) => d.finder.keyClose),
  ];

  return createPortal(
    <div className={styles.overlay} data-state={card.state}>
      <div className={styles.backdrop} onClick={requestClose} aria-hidden="true" />

      <div
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label={t((d) => d.finder.label)}
      >
        <label className={styles.field}>
          <Search size={17} strokeWidth={1.8} className={styles.fieldIcon} aria-hidden="true" />
          <input
            className={styles.input}
            type="text"
            autoFocus
            spellCheck={false}
            autoComplete="off"
            role="combobox"
            aria-expanded={count > 0}
            aria-autocomplete="list"
            aria-controls={count > 0 ? listId : undefined}
            aria-activedescendant={count > 0 ? rowId(active) : undefined}
            placeholder={t((d) => d.finder.placeholder)}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setCursor(0);
            }}
            onKeyDown={onKeyDown}
          />
        </label>

        <FinderResults
          model={model}
          query={query}
          listId={listId}
          rowId={rowId}
          active={active}
          viewportRef={viewportRef}
          onHover={setCursor}
          onActivate={activate}
        />

        <div className={styles.legend} aria-hidden="true">
          {legend.map((part) => (
            <span key={part}>{part}</span>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
