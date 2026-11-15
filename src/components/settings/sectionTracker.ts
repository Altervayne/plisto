/*
 * Tracks which Settings section is active while the scroller moves. A measure runs at most once per
 * animation frame, on scroll and whenever the viewport or its content changes size, so a window resize
 * or rows loading after mount cannot leave the marker stale. A locked section (picked in the rail or
 * landed on) holds until the reader scrolls by hand.
 */

// -- Utils Imports --
import { activeSectionIndex } from "./activeSection";
import { SETTINGS_SECTIONS } from "./settingsSections";

// -- Type Imports --
import type { SettingsSectionId } from "./settingsSections";

/** Keys that scroll the page; any other key (Tab, letters) leaves a lock alone. */
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

/** Whether a key press is the reader scrolling by hand. */
export function releasesLock(key: string): boolean {
  return SCROLL_KEYS.has(key);
}

/** The held section. Owned by the caller so a lock outlives a tracker that is torn down and rebuilt. */
export interface SectionLock {
  current: SettingsSectionId | null;
}

export interface SectionTracker {
  /** Queues a measure for the next frame. */
  schedule: () => void;
  dispose: () => void;
}

export function createSectionTracker(
  viewport: HTMLElement,
  onActive: (id: SettingsSectionId) => void,
  lock: SectionLock,
): SectionTracker {
  let frame = 0;

  const measure = () => {
    frame = 0;
    if (lock.current) return;
    const base = viewport.getBoundingClientRect().top - viewport.scrollTop;
    const tops = SETTINGS_SECTIONS.map((section) => {
      const el = viewport.querySelector(`[data-settings-section="${section.id}"]`);
      return el ? el.getBoundingClientRect().top - base : Number.POSITIVE_INFINITY;
    });
    const index = activeSectionIndex(tops, viewport.scrollTop, viewport.clientHeight, viewport.scrollHeight);
    onActive(SETTINGS_SECTIONS[index].id);
  };

  const schedule = () => {
    if (frame === 0) frame = requestAnimationFrame(measure);
  };
  const release = () => {
    lock.current = null;
  };
  const onKey = (e: Event) => {
    if (releasesLock((e as KeyboardEvent).key)) release();
  };

  const surface = viewport.parentElement ?? viewport;
  viewport.addEventListener("scroll", schedule, { passive: true });
  surface.addEventListener("wheel", release, { passive: true });
  surface.addEventListener("touchstart", release, { passive: true });
  surface.addEventListener("pointerdown", release, { passive: true });
  surface.addEventListener("keydown", onKey);

  let observer: ResizeObserver | null = null;
  if (typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(schedule);
    observer.observe(viewport);
    if (viewport.firstElementChild) observer.observe(viewport.firstElementChild);
  }

  schedule();

  return {
    schedule,
    dispose: () => {
      viewport.removeEventListener("scroll", schedule);
      surface.removeEventListener("wheel", release);
      surface.removeEventListener("touchstart", release);
      surface.removeEventListener("pointerdown", release);
      surface.removeEventListener("keydown", onKey);
      observer?.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
    },
  };
}
