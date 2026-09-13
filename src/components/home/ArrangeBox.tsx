// -- Framework Imports --
import { useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";

// -- Library Imports --
import { useSortable } from "@dnd-kit/sortable";

// -- Icon Imports --
import { X } from "lucide-react";

// -- Registry Imports --
import { BOX_COMPONENTS } from "./boxRegistry";
import { BOX_CATALOG, SIZE_SPAN } from "./boxCatalog";
import { BOX_LABEL } from "./BoxPicker";

// -- Unit Imports --
import { nearestAllowedSize } from "./homeLayout";

// -- Type Imports --
import type { BoxSeed, BoxSize, BoxType } from "./boxCatalog";
import type { Mode } from "../shell/navVisibility";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./ArrangeBox.module.css";

/** The live grid metrics a drag-resize reads its target cells against. */
export interface GridMetrics {
  cols: number;
  cellWidth: number;
  rowHeight: number;
  gap: number;
}

interface ArrangeBoxProps {
  seed: BoxSeed;
  layout: BoxSeed[];
  metrics: GridMetrics;
  onNavigate: (mode: Mode) => void;
  reorder: (fromType: BoxType, toType: BoxType) => void;
  resize: (type: BoxType, size: BoxSize) => void;
  cycle: (type: BoxType) => void;
  remove: (type: BoxType) => void;
  isDropTarget: boolean;
}

/** The pixel span a footprint of `count` cells covers, cells parted by the gap. */
function footprint(count: number, cell: number, gap: number): number {
  return count * cell + (count - 1) * gap;
}

/**
 * A box lifted into an object for arrange: it carries the surface and shadow, a whole-box drag surface
 * for reorder, a corner grip and a size chip for resize, and a remove control. The box's own content
 * stays inert under a pointer-events veil, so StatBox and PreviewBox never learn about arrange. Drag
 * reorder rides @dnd-kit's pointer sensor, the same one the queue uses; the grip rides pointer capture
 * so it tracks past the box edge, and its pointerdown stops the sort from arming.
 */
export function ArrangeBox({
  seed,
  layout,
  metrics,
  onNavigate,
  reorder,
  resize,
  cycle,
  remove,
  isDropTarget,
}: ArrangeBoxProps) {
  const t = useT();
  const Box = BOX_COMPONENTS[seed.type];
  const outerRef = useRef<HTMLDivElement | null>(null);
  // The origin the grip measures against, and whether a grip drag is live so a stray move is ignored.
  const originRef = useRef({ left: 0, top: 0 });
  const grippingRef = useRef(false);
  const [ghost, setGhost] = useState<BoxSize | null>(null);

  // No transform off useSortable: the boxes are variable-span, so a scale/translate would size a card to
  // whatever slot it slides through. The grid itself reflows in real order, and the DragOverlay carries
  // the moving copy; this hook only feeds the node, collisions, and the lifted/hidden source state.
  const { attributes, listeners, setNodeRef, isDragging } = useSortable({ id: seed.type });

  const span = SIZE_SPAN[seed.size];
  // Clamp the footprint to the live grid, matching the rest render: a box loses one row per column it
  // cannot get, so it folds to a shorter tile rather than a tower and never jumps size between modes.
  const displayCols = Math.min(span.cols, metrics.cols);
  const colDeficit = Math.max(0, span.cols - displayCols);
  const displayRows = Math.max(1, span.rows - colDeficit);
  const cell: CSSProperties = {
    gridColumn: `span ${displayCols}`,
    gridRow: `span ${displayRows}`,
  };

  const resizing = ghost != null;

  // -- Keyboard reorder: Ctrl+Arrow slides the focused box one slot along the array --
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!event.ctrlKey) return;
    const back = event.key === "ArrowLeft" || event.key === "ArrowUp";
    const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
    if (!back && !forward) return;
    event.preventDefault();
    const index = layout.findIndex((box) => box.type === seed.type);
    const target = layout[index + (back ? -1 : 1)];
    if (target) reorder(seed.type, target.type);
  };

  // -- Resize grip: read the pointer against the live cell metrics, snap to an allowed size --
  const onGripMove = (event: PointerEvent<HTMLButtonElement>) => {
    if (!grippingRef.current) return;
    const { cols, cellWidth, rowHeight, gap } = metrics;
    const width = event.clientX - originRef.current.left;
    const height = event.clientY - originRef.current.top;
    // Round the covered pixels to whole cells, capped to the live column count so a snap never asks for
    // more columns than the grid shows.
    const wantCols = Math.min(cols, Math.max(1, Math.round((width + gap) / (cellWidth + gap))));
    const wantRows = Math.max(1, Math.round((height + gap) / (rowHeight + gap)));
    setGhost(nearestAllowedSize(seed.type, wantCols, wantRows));
  };

  const onGripDown = (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = outerRef.current?.getBoundingClientRect();
    if (rect) originRef.current = { left: rect.left, top: rect.top };
    event.currentTarget.setPointerCapture(event.pointerId);
    grippingRef.current = true;
    setGhost(seed.size);
  };

  const onGripUp = (event: PointerEvent<HTMLButtonElement>) => {
    event.currentTarget.releasePointerCapture(event.pointerId);
    grippingRef.current = false;
    if (ghost && ghost !== seed.size) resize(seed.type, ghost);
    setGhost(null);
  };

  const allowedCount = BOX_CATALOG[seed.type].allowedSizes.length;

  return (
    <div
      ref={(node) => {
        outerRef.current = node;
        setNodeRef(node);
      }}
      className={styles.box}
      style={cell}
      {...attributes}
      {...listeners}
      data-dragging={isDragging ? "" : undefined}
      data-drop={isDropTarget && !isDragging ? "" : undefined}
      data-active={resizing ? "" : undefined}
      tabIndex={0}
      role="group"
      aria-label={t(BOX_LABEL[seed.type])}
      onKeyDown={onKeyDown}
    >
      <div className={styles.content} aria-hidden="true">
        <Box onNavigate={onNavigate} />
      </div>

      {resizing ? (
        <div
          className={styles.footprint}
          style={{
            width: footprint(SIZE_SPAN[ghost].cols, metrics.cellWidth, metrics.gap),
            height: footprint(SIZE_SPAN[ghost].rows, metrics.rowHeight, metrics.gap),
          }}
        />
      ) : null}

      <div className={styles.controls}>
        <button
          type="button"
          className={styles.remove}
          aria-label={t((d) => d.home.removeBox)}
          onClick={() => remove(seed.type)}
        >
          <X size={13} strokeWidth={2.4} />
        </button>
      </div>

      {allowedCount > 1 ? (
        <div className={styles.sizing}>
          <button
            type="button"
            className={styles.sizeChip}
            aria-label={t((d) => d.home.resize)}
            onClick={() => cycle(seed.type)}
          >
            {seed.size}
          </button>
          <button
            type="button"
            className={styles.grip}
            aria-label={t((d) => d.home.resize)}
            onPointerDown={onGripDown}
            onPointerMove={onGripMove}
            onPointerUp={onGripUp}
            draggable={false}
          />
        </div>
      ) : null}
    </div>
  );
}
