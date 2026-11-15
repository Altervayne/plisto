// -- Component Imports --
import { ScrollArea } from "../common/ScrollArea/ScrollArea";
import { FinderRow } from "./FinderRow";

// -- Utils Imports --
import { entryKey } from "./finderIndex";

// -- Type Imports --
import type { RefObject } from "react";
import type { FinderModel, FinderScope, FinderSection } from "./useFinderModel";
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
  settings: (d) => d.finder.settings,
  sections: (d) => d.finder.sections,
  // A scoped group names itself through its title.
  scoped: () => "",
};

/**
 * The finder's result list: labelled sections of rows, or the one quiet line that stands in when there
 * is nothing to show. Row indexes run across every section, matching the keyboard cursor. A scoped miss
 * keeps the quiet line and adds the one row that drops the scope.
 */
export function FinderResults({
  model,
  query,
  scope,
  listId,
  rowId,
  active,
  viewportRef,
  onHover,
  onActivate,
}: {
  model: FinderModel;
  query: string;
  scope: FinderScope | null;
  listId: string;
  rowId: (index: number) => string;
  active: number;
  viewportRef: RefObject<HTMLDivElement | null>;
  onHover: (index: number) => void;
  onActivate: (index: number) => void;
}) {
  const t = useT();

  if (model.noMatch) {
    const q = query.trim();
    if (scope == null) return <p className={styles.quiet}>{t((d) => d.finder.noMatch, { q })}</p>;
    return (
      <>
        <p className={styles.quiet}>{t((d) => d.finder.scopeNoMatch, { q })}</p>
        <div id={listId} role="listbox" aria-label={t((d) => d.finder.label)} className={styles.section}>
          <div
            id={rowId(0)}
            role="option"
            aria-selected={active === 0}
            data-index={0}
            data-active={active === 0 ? "" : undefined}
            className={styles.showAll}
            onPointerMove={() => onHover(0)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onActivate(0)}
          >
            {t((d) => d.finder.searchEverything)}
          </div>
        </div>
      </>
    );
  }
  if (model.noRecents) {
    return <p className={styles.quiet}>{t((d) => d.finder.recentEmpty)}</p>;
  }

  let index = 0;
  return (
    <ScrollArea className={styles.results} viewportRef={viewportRef}>
      <div id={listId} role="listbox" aria-label={t((d) => d.finder.label)} className={styles.sections}>
        {model.sections.map((section) => {
          const label = section.title ?? t(SECTION_LABEL[section.key]);
          return (
            <div key={`${section.key}:${section.title ?? ""}`} role="group" aria-label={label} className={styles.section}>
              <div className={styles.sectionLabel} aria-hidden="true">
                {label}
              </div>
              {section.items.map((item) => {
                const i = index++;
                if (item.type === "showAll") {
                  const text =
                    item.target === "settings"
                      ? t((d) => d.finder.showAllSettings, { n: item.count })
                      : t((d) => d.finder.showAll, { n: item.count });
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
                      {text}
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
