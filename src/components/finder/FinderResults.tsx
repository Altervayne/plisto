// -- Component Imports --
import { ScrollArea } from "../common/ScrollArea/ScrollArea";
import { FinderRow } from "./FinderRow";

// -- Utils Imports --
import { entryKey } from "./finderIndex";

// -- Type Imports --
import type { RefObject } from "react";
import type { FinderModel, FinderSection } from "./useFinderModel";
import type { Dict } from "../../i18n/en";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./FinderResults.module.css";

const SECTION_LABEL: Record<FinderSection["key"], (d: Dict) => string> = {
  recent: (d) => d.finder.recent,
  artists: (d) => d.finder.artists,
  albums: (d) => d.finder.albums,
  playlists: (d) => d.finder.playlists,
  genres: (d) => d.finder.genres,
  tracks: (d) => d.finder.tracks,
  destinations: (d) => d.finder.goTo,
};

/**
 * The finder's result list: labelled sections of rows, or the one quiet line that stands in when there
 * is nothing to show. Row indexes run across every section, matching the keyboard cursor.
 */
export function FinderResults({
  model,
  query,
  listId,
  rowId,
  active,
  viewportRef,
  onHover,
  onActivate,
}: {
  model: FinderModel;
  query: string;
  listId: string;
  rowId: (index: number) => string;
  active: number;
  viewportRef: RefObject<HTMLDivElement | null>;
  onHover: (index: number) => void;
  onActivate: (index: number) => void;
}) {
  const t = useT();

  if (model.noMatch) {
    return <p className={styles.quiet}>{t((d) => d.finder.noMatch, { q: query.trim() })}</p>;
  }
  if (model.noRecents) {
    return <p className={styles.quiet}>{t((d) => d.finder.recentEmpty)}</p>;
  }

  let index = 0;
  return (
    <ScrollArea className={styles.results} viewportRef={viewportRef}>
      <div id={listId} role="listbox" aria-label={t((d) => d.finder.label)} className={styles.sections}>
        {model.sections.map((section) => {
          const label = t(SECTION_LABEL[section.key]);
          return (
            <div key={section.key} role="group" aria-label={label} className={styles.section}>
              <div className={styles.sectionLabel} aria-hidden="true">
                {label}
              </div>
              {section.items.map((item) => {
                const i = index++;
                if (item.type === "showAll") {
                  return (
                    <div
                      key="showAll"
                      id={rowId(i)}
                      role="option"
                      aria-selected={i === active}
                      data-index={i}
                      data-active={i === active ? "" : undefined}
                      className={styles.showAll}
                      onPointerMove={() => onHover(i)}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => onActivate(i)}
                    >
                      {t((d) => d.finder.showAll, { n: item.count })}
                    </div>
                  );
                }
                return (
                  <FinderRow
                    key={entryKey(item.entry.kind, item.entry.id)}
                    entry={item.entry}
                    id={rowId(i)}
                    index={i}
                    active={i === active}
                    onHover={onHover}
                    onActivate={onActivate}
                  />
                );
              })}
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}
