// -- Framework Imports --
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";

// -- Library Imports --
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";

// -- Icon Imports --
import { Plus } from "lucide-react";

// -- Component Imports --
import { ArrangeBox } from "./ArrangeBox";
import { BoxPicker } from "./BoxPicker";

// -- Registry Imports --
import { BOX_COMPONENTS } from "./boxRegistry";
import { SIZE_SPAN } from "./boxCatalog";

// -- Utils Imports --
import { columnCount } from "../tracks/trackCardLayout";

// -- Type Imports --
import type { BoxSeed, BoxSize, BoxType } from "./boxCatalog";
import type { Mode } from "../shell/navVisibility";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./Bento.module.css";

// The base column width the fit math reads: the column count is how many of these span the content
// width, and the flexible tracks then share it. The gap parts the boxes and folds into the fit like a
// gutter does on the walls. The row height mirrors grid-auto-rows, read by the drag-resize snap.
const BASE_COL = 230;
const GAP = 22;
const ROW_H = 190;

interface BentoProps {
  layout: BoxSeed[];
  arranging: boolean;
  onNavigate: (mode: Mode) => void;
  reorder: (fromType: BoxType, toType: BoxType) => void;
  resize: (type: BoxType, size: BoxSize) => void;
  cycle: (type: BoxType) => void;
  remove: (type: BoxType) => void;
  add: (type: BoxType) => void;
}

/**
 * The responsive span grid for the landing's boxes. It measures its own content width to fix the column
 * count and the live cell width, then lays each box across the columns and rows its size names, capped
 * so a wide box never spills a narrow grid. Each box is a surfaced card, so the grid reads as distinct
 * tiles; in arrange each lifts into a movable object and a trailing tile adds a new box.
 */
export function Bento({
  layout,
  arranging,
  onNavigate,
  reorder,
  resize,
  cycle,
  remove,
  add,
}: BentoProps) {
  const t = useT();
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [cols, setCols] = useState(1);
  const [cellWidth, setCellWidth] = useState(BASE_COL);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [activeType, setActiveType] = useState<BoxType | null>(null);
  const [overType, setOverType] = useState<BoxType | null>(null);

  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const measure = () => {
      const width = grid.clientWidth;
      // Cap the columns at six so a wide monitor keeps the arrangement stable instead of thinning the
      // boxes across ever more tracks.
      const count = Math.min(6, columnCount(width, BASE_COL, GAP));
      setCols(count);
      // The flexible track width the boxes actually occupy, the gaps taken out of the content width.
      setCellWidth((width - (count - 1) * GAP) / count);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    return () => observer.disconnect();
  }, []);

  // A few px of travel arms a drag; the keyboard sensor drives the accessible reorder.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // The overlay renders the lifted box, so track it from the start.
  const onDragStart = ({ active }: DragStartEvent) => setActiveType(active.id as BoxType);
  const clearDrag = () => {
    setActiveType(null);
    setOverType(null);
  };

  // Outline the box the drop will land before. Visual only: an outline never shifts the grid, so the
  // over target stays put and the drag can't loop.
  const onDragOver = ({ active, over }: DragOverEvent) => {
    setOverType(over && over.id !== active.id ? (over.id as BoxType) : null);
  };

  // Commit the move once, on drop: reorderLayout slots the box before the target. The grid holds still
  // through the drag and reflows only here, so the over target never shifts under the cursor mid-drag -
  // the reorder-render-reorder loop that a live reflow would spin.
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (over && active.id !== over.id) {
      const from = layout.findIndex((box) => box.type === active.id);
      const to = layout.findIndex((box) => box.type === over.id);
      if (from >= 0 && to >= 0) reorder(active.id as BoxType, over.id as BoxType);
    }
    clearDrag();
  };

  // Leaving arrange drops the picker and any lifted box, so re-entering starts clean.
  useEffect(() => {
    if (!arranging) {
      setPickerOpen(false);
      setActiveType(null);
      setOverType(null);
    }
  }, [arranging]);

  const ActiveBox = activeType ? BOX_COMPONENTS[activeType] : null;

  return (
    <div
      ref={gridRef}
      className={styles.grid}
      style={{ "--home-cols": cols } as CSSProperties}
    >
      {arranging
        ? (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              // Measure droppables live: the reflow re-places boxes mid-drag, so a start snapshot would
              // resolve collisions against stale cells.
              measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
              onDragStart={onDragStart}
              onDragOver={onDragOver}
              onDragEnd={onDragEnd}
              onDragCancel={clearDrag}
            >
              <SortableContext items={layout.map((s) => s.type)} strategy={rectSortingStrategy}>
                {layout.map((seed) => (
                  <ArrangeBox
                    key={seed.type}
                    seed={seed}
                    layout={layout}
                    metrics={{ cols, cellWidth, rowHeight: ROW_H, gap: GAP }}
                    onNavigate={onNavigate}
                    reorder={reorder}
                    resize={resize}
                    cycle={cycle}
                    remove={remove}
                    isDropTarget={overType === seed.type}
                  />
                ))}
              </SortableContext>

              {/* The lifted copy that tracks the cursor at the box's true size, no scaling. It is an inert
                  snapshot: the card chrome and the box content, none of the arrange controls. */}
              <DragOverlay>
                {ActiveBox ? (
                  <div className={styles.overlayCard}>
                    <div className={styles.overlayContent} aria-hidden="true">
                      <ActiveBox onNavigate={onNavigate} />
                    </div>
                  </div>
                ) : null}
              </DragOverlay>
            </DndContext>
          )
        : layout.map((seed) => {
            const Box = BOX_COMPONENTS[seed.type];
            const span = SIZE_SPAN[seed.size];
            // Clamp the footprint to the live grid: a box loses one row per column it cannot get, so a
            // wide box on a narrow grid folds to a shorter tile rather than a tower. Never below one cell.
            const displayCols = Math.min(span.cols, cols);
            const colDeficit = Math.max(0, span.cols - displayCols);
            const displayRows = Math.max(1, span.rows - colDeficit);
            const cell: CSSProperties = {
              gridColumn: `span ${displayCols}`,
              gridRow: `span ${displayRows}`,
            };
            return (
              <div key={seed.type} className={styles.cell} style={cell}>
                <Box onNavigate={onNavigate} />
              </div>
            );
          })}

      {arranging ? (
        <div className={styles.ghostCell}>
          <button
            type="button"
            className={styles.ghost}
            onClick={() => setPickerOpen((open) => !open)}
          >
            <Plus size={15} strokeWidth={2.2} />
            {t((d) => d.home.addBox)}
          </button>
          {pickerOpen ? (
            <BoxPicker
              layout={layout}
              onPick={add}
              onClose={() => setPickerOpen(false)}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
