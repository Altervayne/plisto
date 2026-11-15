/*
 * Landing on a Settings target: scroll the row (or section) into place, mark and focus a row once, and
 * keep it pinned while rows above it are still loading. A row that is not rendered yet lands on its
 * section first and upgrades to the row when it appears. The landing owns the scroll for its target.
 */

// -- State Imports --
import { takeSettingsTarget } from "../../state/shell/store";

// -- Utils Imports --
import { createLandingMark } from "./landingMark";
import {
  ROW_LAND_OFFSET,
  SECTION_LAND_OFFSET,
  landingScrollTop,
  resolveLanding,
} from "./settingsTarget";

// -- Type Imports --
import type { SettingsSectionId } from "./settingsSections";

/** How long a landing keeps re-pinning while the page above the target settles. */
export const SETTLE_MS = 500;

/** Input that hands the page back to the reader. */
const TAKEOVER_EVENTS = ["wheel", "keydown", "touchstart", "pointerdown"] as const;

const CONTROL = "button:not([disabled]), input:not([disabled]), select, [tabindex='0']";

export interface Landing {
  /** Ends every timer, observer and listener the landing holds. */
  stop: () => void;
}

export const reducedMotion = (): boolean =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function sectionEl(viewport: HTMLElement, id: SettingsSectionId): HTMLElement | null {
  return viewport.querySelector<HTMLElement>(`[data-settings-section="${id}"]`);
}

export function scrollTopFor(viewport: HTMLElement, el: HTMLElement, offset: number): number {
  return landingScrollTop(
    el.getBoundingClientRect().top,
    viewport.getBoundingClientRect().top,
    viewport.scrollTop,
    offset,
  );
}

/** Lands on `target`, or returns null when nothing on the page answers to it. */
export function land(
  viewport: HTMLElement,
  target: string,
  lock: (id: SettingsSectionId) => void,
): Landing | null {
  const rowExists = (domId: string) => viewport.contains(document.getElementById(domId));
  const surface = viewport.parentElement ?? viewport;
  const cleanups: Array<() => void> = [];
  let marked = false;
  let mark: ReturnType<typeof createLandingMark> | null = null;

  const startMark = (row: HTMLElement) => {
    marked = true;
    mark = createLandingMark((phase) => {
      if (phase) row.dataset.landed = phase;
      else delete row.dataset.landed;
    });
    const reduced = reducedMotion();
    mark.show(reduced);
    row.querySelector<HTMLElement>(CONTROL)?.focus({ preventScroll: true });
    if (reduced) {
      const dismiss = () => mark?.dismiss();
      (["keydown", "pointerdown"] as const).forEach((name) => {
        document.addEventListener(name, dismiss, { once: true });
        cleanups.push(() => document.removeEventListener(name, dismiss));
      });
    }
  };

  // Resolves the target against the page as it is now, then pins it. Returns false when nothing matches.
  const place = (): boolean => {
    const anchor = resolveLanding(target, rowExists);
    if (!anchor) return false;
    const isRow = anchor.kind === "row";
    const el = isRow ? document.getElementById(anchor.domId) : sectionEl(viewport, anchor.section);
    if (!el) return false;
    const section = isRow
      ? (el.closest<HTMLElement>("[data-settings-section]")?.dataset.settingsSection as
          | SettingsSectionId
          | undefined)
      : anchor.section;
    if (section) lock(section);
    viewport.scrollTo({
      top: scrollTopFor(viewport, el, isRow ? ROW_LAND_OFFSET : SECTION_LAND_OFFSET),
      behavior: "instant",
    });
    if (isRow && !marked) startMark(el);
    return true;
  };

  if (!place()) return null;

  // Genres and plugins load after mount and push the target down: re-place on every content resize
  // until the page settles or the reader takes over.
  let observer: ResizeObserver | null = null;
  let settle: ReturnType<typeof setTimeout> | null = null;
  const endSettle = () => {
    observer?.disconnect();
    observer = null;
    if (settle != null) clearTimeout(settle);
    settle = null;
    TAKEOVER_EVENTS.forEach((name) => surface.removeEventListener(name, endSettle));
  };
  const content = viewport.firstElementChild;
  if (content && typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(() => {
      place();
    });
    observer.observe(content);
    settle = setTimeout(endSettle, SETTLE_MS);
    TAKEOVER_EVENTS.forEach((name) => surface.addEventListener(name, endSettle, { passive: true }));
  }

  return {
    stop: () => {
      endSettle();
      cleanups.forEach((off) => off());
      mark?.dismiss();
    },
  };
}

/** Takes the waiting target and lands on it; null when none waits, so a target lands once. */
export function consumeTarget(
  viewport: HTMLElement | null,
  lock: (id: SettingsSectionId) => void,
): Landing | null {
  const target = takeSettingsTarget();
  return target && viewport ? land(viewport, target, lock) : null;
}

/**
 * Keeps the running landing across a dev-mode effect double-run: a release stops it on the next tick
 * unless a retain arrives first, so a real unmount still stops everything.
 */
export function createLandingHold() {
  let current: Landing | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancel = () => {
    if (timer != null) clearTimeout(timer);
    timer = null;
  };

  return {
    /** Makes `landing` the running one, ending the previous. */
    start(landing: Landing) {
      current?.stop();
      current = landing;
    },
    retain: cancel,
    release() {
      cancel();
      timer = setTimeout(() => {
        timer = null;
        current?.stop();
        current = null;
      }, 0);
    },
  };
}
