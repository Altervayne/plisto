// -- Framework Imports --
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";

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
 * so a wide box never spills a narrow grid. At rest the boxes are frameless and live; in arrange each
 * lifts into a movable object and a trailing tile adds a new box.
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
  const [draggingType, setDraggingType] = useState<BoxType | null>(null);
  const [dropTargetType, setDropTargetType] = useState<BoxType | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const measure = () => {
      const width = grid.clientWidth;
      const count = columnCount(width, BASE_COL, GAP);
      setCols(count);
      // The flexible track width the boxes actually occupy, the gaps taken out of the content width.
      setCellWidth((width - (count - 1) * GAP) / count);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    return () => observer.disconnect();
  }, []);

  // Leaving arrange drops any transient arrange state, so re-entering starts clean.
  useEffect(() => {
    if (!arranging) {
      setPickerOpen(false);
      setDraggingType(null);
      setDropTargetType(null);
    }
  }, [arranging]);

  return (
    <div
      ref={gridRef}
      className={styles.grid}
      style={{ "--home-cols": cols } as CSSProperties}
    >
      {arranging
        ? layout.map((seed) => (
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
              draggingType={draggingType}
              setDraggingType={setDraggingType}
              dropTargetType={dropTargetType}
              setDropTargetType={setDropTargetType}
            />
          ))
        : layout.map((seed) => {
            const Box = BOX_COMPONENTS[seed.type];
            const span = SIZE_SPAN[seed.size];
            const cell: CSSProperties = {
              gridColumn: `span ${Math.min(span.cols, cols)}`,
              gridRow: `span ${span.rows}`,
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
