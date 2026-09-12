// -- Framework Imports --
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

// -- Icon Imports --
import { Check, ChevronLeft, ChevronRight, ListFilter, X } from "lucide-react";

// -- Component Imports --
import { ScrollArea } from "../common/ScrollArea/ScrollArea";

// -- Utils Imports --
import {
  FACET_KEYS,
  facetOptions,
  hasFacet,
  removeFacet,
  toggleFacet,
} from "./trackFacets";

// -- Type Imports --
import type { FacetKey, GridFacet } from "./trackFacets";
import type { TrackRow } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";
import type { Dict } from "../../i18n/en";

// -- Style Imports --
import styles from "./FacetFilter.module.css";

/** Each facet's dict label, reusing the field names the peek already carries. */
export const FACET_LABEL: Record<FacetKey, (d: Dict) => string> = {
  artist: (d) => d.tracks.fields.artist,
  album_artist: (d) => d.tracks.fields.albumArtist,
  album: (d) => d.tracks.fields.album,
  genre: (d) => d.tracks.fields.genre,
  year: (d) => d.tracks.fields.year,
};

/**
 * The grid's facet control: a quiet trigger opening a two-step menu (pick a facet, then a value), with the
 * active filters trailing as removable accent-weak chips. Values within a facet OR, chips across facets
 * AND, matching filterByFacets. Options come from the passed rows, so the menu offers only values present
 * in the current scope. Presentational over the store: the parent holds the chips and what a pick does.
 * Escape closes the open menu, or clears every chip when the menu is already closed.
 */
export function FacetFilter({
  tracks,
  genreNameById,
  facets,
  onChange,
}: {
  tracks: TrackRow[];
  genreNameById: Map<number, string>;
  facets: GridFacet[];
  onChange: (facets: GridFacet[]) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  // Which facet's values the menu is showing; null rests on the facet list.
  const [step, setStep] = useState<FacetKey | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const options = useMemo(() => facetOptions(tracks, genreNameById), [tracks, genreNameById]);

  const close = () => {
    setOpen(false);
    setStep(null);
  };

  // While open, an outside press dismisses the menu.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) close();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  // Escape closes the open menu; with it already closed, Escape clears the whole chip bar.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    if (open) {
      event.stopPropagation();
      close();
    } else if (facets.length > 0) {
      event.stopPropagation();
      onChange([]);
    }
  };

  return (
    <div className={styles.wrap} ref={wrapRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        className={open ? `${styles.trigger} ${styles.triggerOpen}` : styles.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <ListFilter size={15} strokeWidth={1.8} aria-hidden="true" />
        {t((d) => d.tracks.filter)}
      </button>

      {facets.map(({ facet, value }) => (
        <span key={`${facet}:${value}`} className={styles.chip}>
          <span className={styles.chipText}>
            {t(FACET_LABEL[facet])}: {value}
          </span>
          <button
            type="button"
            className={styles.chipRemove}
            aria-label={t((d) => d.tracks.removeFilter)}
            onClick={() => onChange(removeFacet(facets, facet, value))}
          >
            <X size={12} strokeWidth={3} />
          </button>
        </span>
      ))}

      {facets.length > 0 ? (
        <button type="button" className={styles.clear} onClick={() => onChange([])}>
          {t((d) => d.tracks.clearFilters)}
        </button>
      ) : null}

      {open ? (
        <div className={styles.menu} role="menu">
          {step == null ? (
            <ul className={styles.list}>
              {FACET_KEYS.map((facet) => {
                const count = options[facet].length;
                return (
                  <li key={facet}>
                    <button
                      type="button"
                      className={styles.row}
                      disabled={count === 0}
                      onClick={() => setStep(facet)}
                    >
                      <span className={styles.rowLabel}>{t(FACET_LABEL[facet])}</span>
                      <ChevronRight
                        size={15}
                        strokeWidth={1.8}
                        className={styles.rowIcon}
                        aria-hidden="true"
                      />
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <>
              <button type="button" className={styles.back} onClick={() => setStep(null)}>
                <ChevronLeft size={15} strokeWidth={1.8} aria-hidden="true" />
                {t(FACET_LABEL[step])}
              </button>
              <ScrollArea className={styles.scroll}>
                <ul className={styles.list} role="listbox" aria-label={t(FACET_LABEL[step])}>
                  {options[step].map((value) => {
                    const active = hasFacet(facets, step, value);
                    return (
                      <li key={value}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={active}
                          className={active ? `${styles.row} ${styles.rowActive}` : styles.row}
                          onClick={() => onChange(toggleFacet(facets, step, value))}
                        >
                          <span className={styles.rowLabel}>{value}</span>
                          {active ? (
                            <Check
                              size={14}
                              strokeWidth={2.4}
                              className={styles.rowIcon}
                              aria-hidden="true"
                            />
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </ScrollArea>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
