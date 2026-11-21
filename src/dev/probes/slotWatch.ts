/*
 * Notices when a stage's slot leaves the viewport. A cross-origin frame stops running its animation frames
 * while it is scrolled out of view, though the page keeps running, so a reading taken then is starved by
 * the scroll and not by what the probe measures. A watch records whether the slot was ever less than fully
 * visible after it first showed in full, or never fully visible at all.
 */

/** The share of the slot that must show for it to count as in view; the margin absorbs rounding. */
export const FULL_VISIBLE = 0.98;

/** The line a run reads when its slot left the view. */
export const SCROLLED_OUT =
  "the stage was scrolled out of view, so its frame stopped drawing; keep the stages on screen and run again";

/** The line a run reads when its slot never showed in full, as in a window too small to fit the stage. */
export const NEVER_FIT =
  "the stage never showed fully on screen; widen or enlarge the window so it fits, and run again";

export interface VisibilityEntry {
  isIntersecting: boolean;
  intersectionRatio: number;
}

export interface WatchObserver {
  disconnect(): void;
  /** Reports queued but not yet delivered. */
  takeRecords?(): VisibilityEntry[];
}

/** Builds the observer a watch listens to; the default is the browser's, against the viewport. */
export type ObserverFactory = (onEntries: (entries: VisibilityEntry[]) => void, el: Element) => WatchObserver;

const viewportObserver: ObserverFactory = (onEntries, el) => {
  const observer = new IntersectionObserver((entries) => onEntries(entries), { threshold: [FULL_VISIBLE] });
  observer.observe(el);
  return observer;
};

export function fullyVisible(entry: VisibilityEntry): boolean {
  return entry.isIntersecting && entry.intersectionRatio >= FULL_VISIBLE;
}

export class SlotWatch {
  private reported = false;
  private seen = false;
  private gone = false;
  private readonly observer: WatchObserver | null;

  constructor(el: Element, make: ObserverFactory = viewportObserver) {
    // Without an observer API nothing can be reported, so the watch never claims a departure.
    const available = make !== viewportObserver || typeof IntersectionObserver === "function";
    this.observer = available ? make((entries) => this.take(entries), el) : null;
  }

  private take(entries: VisibilityEntry[]): void {
    for (const e of entries) {
      this.reported = true;
      if (fullyVisible(e)) this.seen = true;
      else if (this.seen) this.gone = true;
    }
  }

  /** True when the slot left full view after showing in full, or never showed in full at all. */
  get leftView(): boolean {
    return this.gone || (this.reported && !this.seen);
  }

  /** The line explaining a true `leftView`. */
  get note(): string {
    return this.gone ? SCROLLED_OUT : NEVER_FIT;
  }

  stop(): void {
    // A departure reported just before the stop may still be queued.
    const pending = this.observer?.takeRecords?.();
    if (pending) this.take(pending);
    this.observer?.disconnect();
  }
}

/** Starts a watch on a slot. */
export function watchSlot(slot: Element): SlotWatch {
  return new SlotWatch(slot);
}
