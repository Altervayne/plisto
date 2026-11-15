/*
 * Section tracking and landing for the Settings scroller: the active section for the rail, a jump to a
 * section, and landing on a target another surface asked for.
 */

// -- Framework Imports --
import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

// -- Utils Imports --
import { createSectionTracker } from "./sectionTracker";
import { SECTION_LAND_OFFSET } from "./settingsTarget";
import { SETTINGS_SECTIONS } from "./settingsSections";
import {
  consumeTarget,
  createLandingHold,
  reducedMotion,
  scrollTopFor,
  sectionEl,
} from "./settingsLanding";

// -- State Imports --
import { usePendingSettingsTarget } from "../../state/shell/store";

// -- Type Imports --
import type { SettingsSectionId } from "./settingsSections";

/** Wires the active section and the rail's jump to the scroller held in `viewportRef`. */
export function useSettingsNav(viewportRef: RefObject<HTMLDivElement | null>) {
  const [active, setActive] = useState<SettingsSectionId>(SETTINGS_SECTIONS[0].id);
  const held = useRef<SettingsSectionId | null>(null);

  const lock = useCallback((id: SettingsSectionId) => {
    held.current = id;
    setActive(id);
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    return createSectionTracker(viewport, setActive, held).dispose;
  }, [viewportRef]);

  const jumpTo = useCallback(
    (id: SettingsSectionId) => {
      const viewport = viewportRef.current;
      const el = viewport ? sectionEl(viewport, id) : null;
      if (!viewport || !el) return;
      lock(id);
      viewport.scrollTo({
        top: scrollTopFor(viewport, el, SECTION_LAND_OFFSET),
        behavior: reducedMotion() ? "instant" : "smooth",
      });
    },
    [viewportRef, lock],
  );

  useSettingsLanding(viewportRef, lock);

  return { active, jumpTo };
}

/** Lands on the shell's waiting target on mount and whenever a new one arrives. */
export function useSettingsLanding(
  viewportRef: RefObject<HTMLDivElement | null>,
  lock: (id: SettingsSectionId) => void,
) {
  const pending = usePendingSettingsTarget();
  const [hold] = useState(createLandingHold);

  // The effect runs twice in development; the hold keeps the first landing alive across that.
  useEffect(() => {
    hold.retain();
    return () => hold.release();
  }, [hold]);

  useEffect(() => {
    if (!pending) return;
    const landing = consumeTarget(viewportRef.current, lock);
    if (landing) hold.start(landing);
  }, [pending, viewportRef, lock, hold]);
}
