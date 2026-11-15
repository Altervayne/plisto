/*
 * The finder's motion lifecycle, free of React and the DOM: which entrance runs, how each close leaves, and
 * when the palette may unmount. Drawing, measuring and scheduling are injected, so tests drive frames and
 * timers by hand. A fly-back unmounts from its own last frame, so the field always lands on the pill; a
 * timer only backs it up when frames stop coming.
 */

// -- Unit Imports --
import { CLOSE_MS, FADE_MS, OPEN_MS, REST_FRAME, closeFrame, closeMotion, openFrame, openMotion } from "./finderMorph";
import type { CloseReason, FinderMotion, MorphFrame } from "./finderMorph";

/** Animation frames, timers and a clock. */
export interface Scheduler {
  frame(callback: (now: number) => void): number;
  cancelFrame(id: number): void;
  timer(callback: () => void, ms: number): number;
  cancelTimer(id: number): void;
  now(): number;
}

/** The drawing side: measure the pill and the resting palette, paint one frame, and return to the stylesheet. */
export interface Stage<G> {
  measure(): G | null;
  paint(geo: G, frame: MorphFrame): void;
  clear(geo: G): void;
  originOnScreen(): boolean;
}

/** What the lifecycle reports to its owner. */
export interface LifecycleEvents {
  motion(motion: FinderMotion): void;
  closing(): void;
  unmount(reason: CloseReason): void;
}

// A fly-back that gets no frames, as in a hidden window, still ends after this long.
const BACKSTOP_MS = CLOSE_MS * 3;

export interface FinderLifecycle {
  // The entrance this palette starts with.
  readonly motion: FinderMotion;
  open(): void;
  close(reason: CloseReason): void;
  // Ends an entrance in flight at once.
  land(): void;
  // Stops everything and clears what was drawn, for an unmount that skipped close.
  dispose(): void;
}

export function createFinderLifecycle<G>(options: {
  reduced: boolean;
  hasOrigin: boolean;
  stage: Stage<G>;
  scheduler: Scheduler;
  events: LifecycleEvents;
}): FinderLifecycle {
  const { reduced, hasOrigin, stage, scheduler, events } = options;
  const motion = openMotion(reduced, hasOrigin);
  let raf = 0;
  let timer = 0;
  let geo: G | null = null;
  let frame: MorphFrame = REST_FRAME;
  let closing = false;
  let unmounted = false;
  let reason: CloseReason = "dismiss";

  const stop = () => {
    if (raf !== 0) scheduler.cancelFrame(raf);
    raf = 0;
  };
  const settle = () => {
    stop();
    if (geo) stage.clear(geo);
    geo = null;
  };
  const finish = () => {
    if (unmounted) return;
    unmounted = true;
    stop();
    scheduler.cancelTimer(timer);
    events.unmount(reason);
  };

  /** Paints the first frame now, then one per animation frame until `length`, then calls `done`. */
  const fly = (g: G, timeline: (t: number) => MorphFrame, length: number, done: () => void) => {
    geo = g;
    const start = scheduler.now();
    const step = (now: number) => {
      const t = Math.min(length, now - start);
      frame = timeline(t);
      stage.paint(g, frame);
      if (t < length) raf = scheduler.frame(step);
      else {
        raf = 0;
        done();
      }
    };
    frame = timeline(0);
    stage.paint(g, frame);
    raf = scheduler.frame(step);
  };

  return {
    motion,
    open() {
      if (motion !== "morph") return;
      const g = stage.measure();
      if (!g) {
        events.motion("card");
        return;
      }
      fly(g, openFrame, OPEN_MS, () => {
        settle();
        frame = REST_FRAME;
      });
    },
    close(why) {
      if (closing) return;
      closing = true;
      reason = why;
      const from = frame;
      let next = closeMotion(reduced, why, hasOrigin && stage.originOnScreen(), raf !== 0);
      if (next === "morph") {
        settle();
        const g = stage.measure();
        if (g) {
          fly(g, (t) => closeFrame(t, from), CLOSE_MS, finish);
          timer = scheduler.timer(finish, BACKSTOP_MS);
        } else {
          next = "card";
        }
      } else if (next === "fade") {
        // The overlay fades as it stands, mid-entrance included.
        stop();
      } else {
        settle();
      }
      if (next !== "morph") timer = scheduler.timer(finish, next === "fade" ? FADE_MS : CLOSE_MS);
      events.motion(next);
      events.closing();
    },
    land() {
      if (closing || raf === 0) return;
      settle();
      frame = REST_FRAME;
    },
    dispose() {
      settle();
      scheduler.cancelTimer(timer);
    },
  };
}
