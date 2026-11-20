// -- Framework Imports --
import { Fragment } from "react";

// -- Utils Imports --
import { groupUnmatched } from "./restorePointModel";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Type Imports --
import type { UnmatchedGroup } from "../../../types";

// -- Style Imports --
import styles from "./RestorePoints.module.css";

// The list is a preview of the copied text: past these it says how many more follow.
const MAX_GROUPS = 100;
const MAX_PATHS = 5;

/**
 * The point's tracks that are not in the library, grouped by the album, single or playlist they sat in.
 * With `showPaths` each group lists its first paths in the mono face; the full list is what Copy list
 * puts on the clipboard.
 */
export function UnmatchedList({ groups, showPaths }: { groups: UnmatchedGroup[]; showPaths: boolean }) {
  const t = useT();
  const grouped = groupUnmatched(groups);

  const section = (heading: string, list: UnmatchedGroup[]) => {
    if (list.length === 0) return null;
    const shown = list.slice(0, MAX_GROUPS);
    return (
      <Fragment key={heading}>
        <div className={styles.group}>{heading}</div>
        {shown.map((group, i) => (
          <div key={`${group.kind}-${group.id ?? i}`}>
            <div className={styles.item}>
              <span className={styles.itemName}>
                {group.title ?? t((d) => d.restorePoints.tracks, { n: group.paths.length })}
              </span>
              {group.title !== null ? (
                <span className={styles.itemCount}>{t((d) => d.restorePoints.tracks, { n: group.paths.length })}</span>
              ) : null}
            </div>
            {showPaths ? (
              <>
                {group.paths.slice(0, MAX_PATHS).map((path) => (
                  <div key={path} className={styles.path}>
                    {path}
                  </div>
                ))}
                {group.paths.length > MAX_PATHS ? (
                  <div className={styles.path}>
                    {t((d) => d.restorePoints.morePaths, { n: group.paths.length - MAX_PATHS })}
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        ))}
        {list.length > shown.length ? (
          <div className={styles.more}>{t((d) => d.restorePoints.moreGroups, { n: list.length - shown.length })}</div>
        ) : null}
      </Fragment>
    );
  };

  return (
    <div className={styles.unmatched}>
      {section(t((d) => d.restorePoints.groupAlbums), grouped.albums)}
      {section(t((d) => d.restorePoints.groupPlaylists), grouped.playlists)}
      {section(t((d) => d.restorePoints.groupOther), grouped.other)}
    </div>
  );
}
