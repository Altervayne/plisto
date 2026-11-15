/*
 * Section paging for the Settings scroller: the section on show, a pick from the rail, and landing on a
 * target another surface asked for. The shown section lives in the shell store, so a target opens on its
 * own section before the first paint and Settings reopens where it was left.
 */

// -- Framework Imports --
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";

// -- Utils Imports --
import { consumeTarget, createLandingHold, rescueFocus } from "./settingsLanding";
import type { LandingHold } from "./settingsLanding";

// -- State Imports --
import {
  useSetSettingsSection,
  useSettingsSection,
  usePendingSettingsTarget,
} from "../../state/shell/store";

/** The shown section, a pick that swaps it, and landing on a waiting target. */
export function useSettingsNav(viewportRef: RefObject<HTMLDivElement | null>) {
  const section = useSettingsSection();
  const pick = useSetSettingsSection();

  const [hold] = useState(createLandingHold);
  const shown = useRef(section);

  // A swap shows the new page from its top, ends a landing aimed at the old page, and keeps focus off
  // the body when the page that held it is now hidden. A landing that focuses a row takes focus after.
  useLayoutEffect(() => {
    if (viewportRef.current) viewportRef.current.scrollTop = 0;
    if (shown.current === section) return;
    shown.current = section;
    hold.stop();
    rescueFocus();
  }, [section, viewportRef, hold]);

  useSettingsLanding(viewportRef, hold);

  return { section, pick };
}

/** Lands on the shell's waiting target on mount and whenever a new one arrives. */
function useSettingsLanding(viewportRef: RefObject<HTMLDivElement | null>, hold: LandingHold) {
  const pending = usePendingSettingsTarget();

  // The effect runs twice in development; the hold keeps the first landing alive across that.
  useEffect(() => {
    hold.retain();
    return () => hold.release();
  }, [hold]);

  useEffect(() => {
    if (!pending) return;
    const landing = consumeTarget(viewportRef.current);
    if (landing) hold.start(landing);
  }, [pending, viewportRef, hold]);
}
