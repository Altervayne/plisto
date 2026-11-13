/*
 * The placeholder element a plugin page reserves for its frame. The frame layer positions the shown
 * frame over it. Only one page shows at a time, so there is one slot.
 */

// -- Library Imports --
import { create } from "zustand";

export interface FrameSlot {
  id: string;
  el: HTMLElement;
}

interface FrameSlotStore {
  slot: FrameSlot | null;
  setSlot: (slot: FrameSlot) => void;
  /** Clears the slot only if it still holds `slot`, so a page unmounting late cannot clear its successor. */
  clearSlot: (slot: FrameSlot) => void;
}

export const useFrameSlotStore = create<FrameSlotStore>((set) => ({
  slot: null,
  setSlot: (slot) => set({ slot }),
  clearSlot: (slot) =>
    set((s) => (s.slot && s.slot.id === slot.id && s.slot.el === slot.el ? { slot: null } : s)),
}));

export const useFrameSlot = (): FrameSlot | null => useFrameSlotStore((s) => s.slot);
