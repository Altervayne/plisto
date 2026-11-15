/*
 * The mark on a row Settings landed on: shown at full strength, held, then one fade and gone. Under
 * reduced motion it is held static and removed with no fade. The controller owns only the timers; the
 * caller applies each phase to the element.
 */

export type MarkPhase = "hold" | "fade";

/** Hold at full strength before the fade starts. */
export const MARK_HOLD_MS = 1600;
/** The single fade; the stylesheet's transition matches it. */
export const MARK_FADE_MS = 600;
/** The static hold under reduced motion. */
export const MARK_REDUCED_HOLD_MS = 4000;

export interface LandingMark {
  /** Starts a mark, replacing any one running. */
  show: (reduced: boolean) => void;
  /** Ends the mark at once. */
  dismiss: () => void;
}

/** `apply` receives the phase to draw, or null to remove the mark. */
export function createLandingMark(apply: (phase: MarkPhase | null) => void): LandingMark {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const stop = () => {
    if (timer != null) clearTimeout(timer);
    timer = null;
  };

  const dismiss = () => {
    stop();
    apply(null);
  };

  const show = (reduced: boolean) => {
    stop();
    apply("hold");
    if (reduced) {
      timer = setTimeout(dismiss, MARK_REDUCED_HOLD_MS);
      return;
    }
    timer = setTimeout(() => {
      apply("fade");
      timer = setTimeout(dismiss, MARK_FADE_MS);
    }, MARK_HOLD_MS);
  };

  return { show, dismiss };
}
