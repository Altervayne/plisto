/*
 * The shelf's keys and wheel. Keys belong to the listbox alone, so Enter on a record's action button
 * never also plays it; each handled key is consumed, which keeps the window shortcuts off it. The wheel
 * scrubs: one notch is one record, and a trackpad's small deltas add up to a notch.
 */

// -- Framework Imports --
import { useEffect, useRef } from "react";
import type { KeyboardEvent, RefObject } from "react";

// -- Unit Imports --
import { jumpGroup, stepFocus } from "./browseNav";

// -- Type Imports --
import type { BrowseShape } from "./browseNav";

/** What a key asks of the shelf. */
export type ShelfIntent =
  | { kind: "step"; by: 1 | -1 }
  | { kind: "page"; dir: 1 | -1 }
  | { kind: "home" }
  | { kind: "end" }
  | { kind: "activate" }
  | { kind: "menu" };

/** The keydown fields the shelf reads. */
export interface ShelfKey {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

/**
 * Resolves a key to its shelf intent, or null to leave it alone. A key held with Ctrl, Meta or Alt is
 * left to the app shortcuts, and so is Shift with anything but F10.
 */
export function shelfIntent(e: ShelfKey): ShelfIntent | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.shiftKey) return e.key === "F10" ? { kind: "menu" } : null;
  switch (e.key) {
    case "ArrowRight":
    case "ArrowDown":
      return { kind: "step", by: 1 };
    case "ArrowLeft":
    case "ArrowUp":
      return { kind: "step", by: -1 };
    case "PageDown":
      return { kind: "page", dir: 1 };
    case "PageUp":
      return { kind: "page", dir: -1 };
    case "Home":
      return { kind: "home" };
    case "End":
      return { kind: "end" };
    case "Enter":
    case " ":
      return { kind: "activate" };
    case "ContextMenu":
      return { kind: "menu" };
    default:
      return null;
  }
}

/** Pixels of scroll per record. */
export const WHEEL_STEP = 60;

/** A line-mode delta (a mouse wheel on some systems) in pixels. */
export const WHEEL_LINE = 33;

/** Idle time after which a partial scroll is forgotten. */
export const WHEEL_IDLE_MS = 220;

/** The wheel fields the accumulator reads. */
export interface WheelDelta {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
}

/**
 * Adds one wheel event to the running total and returns the whole records it makes, plus what is
 * left over. The dominant axis wins, so a sideways trackpad swipe scrubs too.
 */
export function accumulateWheel(acc: number, e: WheelDelta): { steps: number; acc: number } {
  const raw = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  const total = acc + raw * (e.deltaMode === 1 ? WHEEL_LINE : 1);
  const steps = Math.trunc(total / WHEEL_STEP);
  return { steps, acc: total - steps * WHEEL_STEP };
}

export interface ShelfKeysOptions {
  stageRef: RefObject<HTMLDivElement | null>;
  shape: BrowseShape;
  focus: number;
  /** Moves the focus; `jump` asks for the cut fade rather than a slide. */
  onFocus: (index: number, jump: boolean) => void;
  onActivate: () => void;
  /** Opens the focused record's menu at a viewport point; absent, the menu keys are left alone. */
  onMenu?: (x: number, y: number) => void;
}

/** Binds the wheel to the stage and returns the listbox's keydown handler. */
export function useShelfKeys(options: ShelfKeysOptions): (event: KeyboardEvent<HTMLDivElement>) => void {
  // The latest options, read by the wheel listener that binds once.
  const ref = useRef(options);
  ref.current = options;
  // The focus last asked for, so a burst of wheel events between renders keeps counting from it.
  const live = useRef(options.focus);
  live.current = options.focus;
  const moveRef = useRef((index: number, jump: boolean) => {
    live.current = index;
    ref.current.onFocus(index, jump);
  });

  useEffect(() => {
    const stage = options.stageRef.current;
    if (!stage) return;
    let acc = 0;
    let idle: ReturnType<typeof setTimeout> | null = null;
    // Not passive: the wheel scrubs the shelf, so the page must not scroll under it.
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const { shape } = ref.current;
      if (shape.count < 2) return;
      if (idle !== null) clearTimeout(idle);
      idle = setTimeout(() => {
        acc = 0;
      }, WHEEL_IDLE_MS);
      const next = accumulateWheel(acc, event);
      acc = next.acc;
      if (next.steps !== 0) moveRef.current(stepFocus(shape, live.current, next.steps), false);
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      stage.removeEventListener("wheel", onWheel);
      if (idle !== null) clearTimeout(idle);
    };
  }, [options.stageRef]);

  return (event) => {
    const intent = shelfIntent(event);
    if (!intent) return;
    const { shape, onActivate, onMenu, stageRef } = ref.current;
    const move = moveRef.current;
    if (intent.kind === "menu") {
      const record = stageRef.current?.querySelector("[aria-selected='true']");
      if (!onMenu || !record) return;
      event.preventDefault();
      const box = record.getBoundingClientRect();
      onMenu(box.left + box.width / 2, box.top + box.height / 2);
      return;
    }
    event.preventDefault();
    // One record has nowhere to go: every move is inert, and only activation acts.
    if (intent.kind === "activate") onActivate();
    else if (shape.count < 2) return;
    else if (intent.kind === "step") move(stepFocus(shape, live.current, intent.by), false);
    else if (intent.kind === "page") move(jumpGroup(shape, live.current, intent.dir), true);
    else if (intent.kind === "home") move(0, true);
    else move(shape.count - 1, true);
  };
}
