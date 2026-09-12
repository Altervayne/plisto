// -- Framework Imports --
import { useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";

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
  draggingType: BoxType | null;
  setDraggingType: (type: BoxType | null) => void;
  dropTargetType: BoxType | null;
  setDropTargetType: (type: BoxType | null) => void;
}

/** The pixel span a footprint of `count` cells covers, cells parted by the gap. */
function footprint(count: number, cell: number, gap: number): number {
  return count * cell + (count - 1) * gap;
}

/**
 * A box lifted into an object for arrange: it carries the surface and shadow, a whole-box drag surface
 * for reorder, a corner grip and a size chip for resize, and a remove control. The box's own content
 * stays inert under a pointer-events veil, so StatBox and PreviewBox never learn about arrange. Drag
 * reorder rides HTML5 drag-and-drop; the grip rides pointer capture so it tracks past the box edge.
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
  draggingType,
  setDraggingType,
  dropTargetType,
  setDropTargetType,
}: ArrangeBoxProps) {
  const t = useT();
  const Box = BOX_COMPONENTS[seed.type];
  const outerRef = useRef<HTMLDivElement | null>(null);
  // The origin the grip measures against, and whether a grip drag is live so a stray move is ignored.
  const originRef = useRef({ left: 0, top: 0 });
  const grippingRef = useRef(false);
  const [ghost, setGhost] = useState<BoxSize | null>(null);

  const span = SIZE_SPAN[seed.size];
  const cell: CSSProperties = {
    gridColumn: `span ${Math.min(span.cols, metrics.cols)}`,
    gridRow: `span ${span.rows}`,
  };

  const isDragging = draggingType === seed.type;
  const isDropTarget = dropTargetType === seed.type && draggingType !== seed.type;
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

  // -- Drag reorder: the whole box is the handle; dropping onto another box takes its slot --
  const onDrop = () => {
    if (draggingType && draggingType !== seed.type) reorder(draggingType, seed.type);
    setDraggingType(null);
    setDropTargetType(null);
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
      ref={outerRef}
      className={styles.box}
      style={cell}
      // Resizing pins the box down so the grip drag never turns into a reorder drag.
      draggable={!resizing}
      data-dragging={isDragging ? "" : undefined}
      data-drop={isDropTarget ? "" : undefined}
      data-active={resizing ? "" : undefined}
      tabIndex={0}
      role="group"
      aria-label={t(BOX_LABEL[seed.type])}
      onKeyDown={onKeyDown}
      onDragStart={(event) => {
        if (resizing) {
          event.preventDefault();
          return;
        }
        event.dataTransfer.effectAllowed = "move";
        setDraggingType(seed.type);
      }}
      onDragEnd={() => {
        setDraggingType(null);
        setDropTargetType(null);
      }}
      onDragOver={(event) => {
        if (!draggingType || draggingType === seed.type) return;
        event.preventDefault();
        setDropTargetType(seed.type);
      }}
      onDrop={onDrop}
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
