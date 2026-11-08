/*
 * The visualizer sheet: whether it is open, the control that opened it, and the kind it previews on the
 * stage. A preview change waits out a short dwell, so a pointer sweeping across the strip never dips the
 * stage through every tile it crosses. A preview only aims the stage: it never writes a pick. Closing
 * drops the preview at once.
 */

// -- Library Imports --
import { create } from "zustand";

// -- Type Imports --
import type { VisualizerKind } from "./visualizerKind";

/** How long a tile is hovered or focused before the stage previews it. */
export const PREVIEW_DWELL_MS = 120;

interface VisualizerSheetStore {
  isOpen: boolean;
  // The control that opened the sheet: a press on it toggles rather than dismisses, and Esc returns to it.
  anchor: HTMLElement | null;
  previewKind: VisualizerKind | null;

  open: (anchor?: HTMLElement | null) => void;
  toggle: (anchor?: HTMLElement | null) => void;
  close: () => void;
  // Aims the stage at `kind`, or back at the pick with null, once the dwell passes.
  preview: (kind: VisualizerKind | null) => void;
  clearPreview: () => void;
}

// The change waiting out its dwell. One at a time: a newer change replaces it.
let pending: { kind: VisualizerKind | null; timer: ReturnType<typeof setTimeout> } | null = null;

function cancelPending(): void {
  if (pending) clearTimeout(pending.timer);
  pending = null;
}

export const useVisualizerSheet = create<VisualizerSheetStore>((set, get) => ({
  isOpen: false,
  anchor: null,
  previewKind: null,

  open: (anchor = null) => set({ isOpen: true, anchor }),
  toggle: (anchor = null) => {
    if (get().isOpen) get().close();
    else get().open(anchor);
  },
  close: () => {
    cancelPending();
    set({ isOpen: false, previewKind: null });
  },
  preview: (kind) => {
    if (!get().isOpen || pending?.kind === kind) return;
    cancelPending();
    if (kind === get().previewKind) return;
    const timer = setTimeout(() => {
      pending = null;
      if (get().isOpen) set({ previewKind: kind });
    }, PREVIEW_DWELL_MS);
    pending = { kind, timer };
  },
  clearPreview: () => {
    cancelPending();
    if (get().previewKind != null) set({ previewKind: null });
  },
}));

export const useVisualizerSheetOpen = () => useVisualizerSheet((s) => s.isOpen);

export const useVisualizerPreview = () => useVisualizerSheet((s) => s.previewKind);
