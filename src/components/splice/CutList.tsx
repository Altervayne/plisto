// -- Framework Imports --
import type { ReactNode } from "react";

// -- Component Imports --
import { ScrollArea } from "../common/ScrollArea/ScrollArea";
import { EditableField } from "../common/EditableField/EditableField";
import { CutRow } from "./CutRow";

// -- Local Imports --
import type { DerivedSegment } from "./cutModel";

// -- Utils Imports --
import { projectFilename, type SpliceFormat } from "../../lib/splice";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./CutList.module.css";

// The example the naming pattern previews against, so the field shows what a real cut lands as.
const EXAMPLE_META = { title: "Golden", artist: "Artist", track_no: 3 };

/**
 * The cut list peek: the naming pattern over one row per output segment, on the album pane's detail
 * chassis. The pattern field previews live against a sample name; the format snap note, when the
 * source is not sample-accurate, sits under the header. The rows scroll on their own; the output
 * config and the Split CTA ride in a pinned foot below them, always in reach. Highlight is shared with
 * the lane through the hover and select callbacks.
 */
export function CutList({
  segments,
  pattern,
  onPattern,
  ext,
  format,
  sampleRate,
  path,
  hoveredSegmentId,
  selectedSegmentId,
  onHover,
  onSelect,
  onSetMeta,
  onMoveMarker,
  snapNote,
  foot,
}: {
  segments: DerivedSegment[];
  pattern: string;
  onPattern: (next: string) => void;
  ext: string;
  format: SpliceFormat | null;
  sampleRate: number;
  path: string;
  hoveredSegmentId: string | null;
  selectedSegmentId: string | null;
  onHover: (id: string | null) => void;
  onSelect: (id: string) => void;
  onSetMeta: (leadingId: string, title: string | undefined) => void;
  onMoveMarker: (id: string, frame: number) => void;
  snapNote: string | null;
  foot: ReactNode;
}) {
  const t = useT();
  const example = projectFilename(pattern, EXAMPLE_META, 2, ext);

  return (
    <aside className={styles.list} aria-label={t((d) => d.splice.cutList)}>
      <ScrollArea className={styles.scroll} contentClassName={styles.inner}>
        <div className={styles.header}>
          <span className={styles.label}>{t((d) => d.splice.namingPattern)}</span>
          <EditableField
            value={pattern}
            ariaLabel={t((d) => d.splice.namingPattern)}
            placeholder="{track_no} - {title}"
            onCommit={onPattern}
          />
          <div className={styles.example}>{example}</div>
          {snapNote ? <p className={styles.note}>{snapNote}</p> : null}
        </div>

        <div className={styles.rows}>
          {segments.map((segment, index) => (
            <CutRow
              key={segment.id}
              index={index}
              segment={segment}
              pattern={pattern}
              ext={ext}
              format={format}
              sampleRate={sampleRate}
              path={path}
              active={segment.id === hoveredSegmentId || segment.id === selectedSegmentId}
              onSetMeta={onSetMeta}
              onMoveMarker={onMoveMarker}
              onHover={onHover}
              onSelect={onSelect}
            />
          ))}
        </div>
      </ScrollArea>

      <div className={styles.foot}>{foot}</div>
    </aside>
  );
}
