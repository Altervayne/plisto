// -- Component Imports --
import { FinderThumb } from "./FinderThumb";

// -- Type Imports --
import type { FinderEntry } from "./finderIndex";
import type { Translate } from "../../i18n";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./FinderRow.module.css";

/** The dim line under a label: the artist, the Single marker, or a track count. */
function sublabelOf(entry: FinderEntry, t: Translate): string | null {
  switch (entry.kind) {
    case "album":
    case "track":
      return entry.sublabel ?? null;
    case "single": {
      const marker = t((d) => d.singles.marker);
      return entry.sublabel ? `${marker} - ${entry.sublabel}` : marker;
    }
    case "playlist":
      return t((d) => d.playlists.trackCount, { n: entry.count });
    case "genre":
      return t((d) => d.albums.trackCount, { n: entry.count });
    default:
      return null;
  }
}

/**
 * One finder result. Focus never leaves the search input, so the row is an option the input points at
 * rather than a focusable button; a press is held off so the input keeps its caret.
 */
export function FinderRow({
  entry,
  id,
  index,
  active,
  onHover,
  onActivate,
}: {
  entry: FinderEntry;
  id: string;
  index: number;
  active: boolean;
  onHover: (index: number) => void;
  onActivate: (index: number) => void;
}) {
  const t = useT();
  const sublabel = sublabelOf(entry, t);
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      data-index={index}
      className={styles.row}
      data-active={active ? "" : undefined}
      onPointerMove={() => onHover(index)}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onActivate(index)}
    >
      <FinderThumb entry={entry} />
      <span className={styles.text}>
        <span className={styles.label}>{entry.label}</span>
        {sublabel ? <span className={styles.sublabel}>{sublabel}</span> : null}
      </span>
    </div>
  );
}
