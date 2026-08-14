// -- Framework Imports --
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";

/** Everything the Resizer atom needs: the live aria values, a drag flag, and the input handlers. */
export interface ResizerControl {
  dragging: boolean;
  valueNow: number;
  valueMin: number;
  valueMax: number;
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
}
