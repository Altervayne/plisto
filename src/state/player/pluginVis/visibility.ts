/*
 * Whether a plugin visualizer's slot may be ticked. A throttled or off-screen frame goes quiet while
 * healthy, so the host stops ticking it instead of reading the silence as a hang. A mount that is still
 * compiling sits under the dip at opacity 0 and keeps ticking, because its compile polls advance on ticks.
 */

/** What the predicate reads, gathered by the mount from the page. */
export interface VisibilityInputs {
  documentVisible: boolean;
  // The slot intersects the viewport.
  intersecting: boolean;
  // The slot's computed opacity, 0..1.
  opacity: number;
  // True until the mount reports its first frame.
  mounting: boolean;
  minimized: boolean;
}

/** Whether ticks may flow: the page is shown and the slot is on screen and not faded out. */
export function isSlotVisible(inputs: VisibilityInputs): boolean {
  if (!inputs.documentVisible || inputs.minimized || !inputs.intersecting) return false;
  // Under the dip a mounting slot is at opacity 0 by design.
  return inputs.mounting || inputs.opacity > 0;
}

/** A mutable set of inputs, so the event sources report into one place. */
export interface VisibilityState {
  set: (patch: Partial<VisibilityInputs>) => void;
  get: () => VisibilityInputs;
  visible: () => boolean;
}

/** Starts off screen until the sources report; `onChange` fires when `visible` flips. */
export function createVisibilityState(
  initial: Partial<VisibilityInputs> = {},
  onChange?: (visible: boolean) => void,
): VisibilityState {
  const inputs: VisibilityInputs = {
    documentVisible: true,
    intersecting: false,
    opacity: 1,
    mounting: true,
    minimized: false,
    ...initial,
  };
  let last = isSlotVisible(inputs);
  return {
    set(patch) {
      Object.assign(inputs, patch);
      const now = isSlotVisible(inputs);
      if (now === last) return;
      last = now;
      onChange?.(now);
    },
    get: () => ({ ...inputs }),
    visible: () => isSlotVisible(inputs),
  };
}
