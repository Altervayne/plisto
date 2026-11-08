// -- Framework Imports --
import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

// -- Component Imports --
import { DefaultsAside } from "./DefaultsAside";
import { GroupChips } from "./GroupChips";
import { KindStrip } from "./KindStrip";
import { SheetFooter } from "./SheetFooter";

// -- Hook Imports --
import { useVisualizerPick } from "../useVisualizerPick";
import { useVisualizerResolution } from "../useVisualizerResolution";

// -- State Imports --
import { useVisualizerSheet, useVisualizerSheetOpen } from "../../../../state/player/visualizerSheet";
import type { VisualizerKind } from "../../../../state/player/visualizerKind";

// -- Local Imports --
import type { VisualizerFallback } from "../visualizerTarget";
import { nextFocus, type NavDirection } from "../tiles/focusNav";
import { SHEET_GROUPS, type SheetGroupId } from "./sheetGroups";
import { groupScroll } from "./stripMath";
import { useSheetDefaults } from "./useSheetDefaults";

// -- i18n Imports --
import { useT } from "../../../../i18n";

// -- Style Imports --
import styles from "./VisualizerSheet.module.css";

// Every control the arrows walk: the chips, the tiles and the footer. The chevrons are hidden from it.
const NAV_ITEMS = 'button:not([aria-hidden="true"]):not([aria-disabled="true"])';

const ARROWS: readonly string[] = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];

/**
 * The visualizer picker: a sheet rising from the bottom of the stage over a filmstrip of every kind, with
 * group chips above it and the reactivity controls below. `place` sets the geometry: docked to the
 * Player panel's bottom edge, or floating above the ambient chrome. The sheet mounts while the sheet
 * store is open, so it rises on open only; a pick updates it in place. It shows and picks for track
 * `trackId`, and closes when its place goes away. `fallback` says why the stage draws something else than
 * the pick, for the footer's line.
 */
export function VisualizerSheet({
  place,
  trackId,
  fallback = null,
}: {
  place: "player" | "ambient";
  trackId: number;
  fallback?: VisualizerFallback | null;
}) {
  const open = useVisualizerSheetOpen();
  useEffect(() => () => useVisualizerSheet.getState().close(), []);
  return open ? <SheetBody place={place} trackId={trackId} fallback={fallback} /> : null;
}

function SheetBody({
  place,
  trackId,
  fallback,
}: {
  place: "player" | "ambient";
  trackId: number;
  fallback: VisualizerFallback | null;
}) {
  const t = useT();
  const resolved = useVisualizerResolution(trackId);
  const { picked } = resolved.resolution;
  const { tagFor, markers } = useSheetDefaults(resolved.resolution);
  const pick = useVisualizerPick(trackId);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const [group, setGroup] = useState<SheetGroupId>(SHEET_GROUPS[0].id);

  // A press outside dismisses the sheet. The control that opened it toggles it instead.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      const { anchor, close } = useVisualizerSheet.getState();
      if (sheetRef.current?.contains(target) || anchor?.contains(target)) return;
      close();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, []);

  // On open, focus moves to the checked tile once the strip has scrolled to it and painted.
  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      stripRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus({ preventScroll: true }),
    );
    return () => cancelAnimationFrame(frame);
  }, []);

  const onPick = useCallback(
    (kind: VisualizerKind) => {
      useVisualizerSheet.getState().clearPreview();
      pick(kind);
    },
    [pick],
  );

  const onJump = (id: SheetGroupId) => {
    const strip = stripRef.current;
    const run = strip?.querySelector<HTMLElement>(`[data-group="${id}"]`);
    if (!strip || !run) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    strip.scrollTo({
      left: groupScroll(run.offsetLeft, strip.scrollWidth - strip.clientWidth),
      behavior: reduced ? "auto" : "smooth",
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      const { anchor, close } = useVisualizerSheet.getState();
      close();
      anchor?.focus({ preventScroll: true });
      return;
    }
    if (!ARROWS.includes(event.key) || !sheetRef.current) return;
    const items = [...sheetRef.current.querySelectorAll<HTMLElement>(NAV_ITEMS)].filter(
      (el) => el.offsetParent !== null,
    );
    const here = items.indexOf(document.activeElement as HTMLElement);
    if (here < 0) return;
    event.preventDefault();
    const next = nextFocus(
      items.map((el) => el.getBoundingClientRect()),
      here,
      event.key as NavDirection,
    );
    // The default focus scroll keeps the tile in view as the arrows walk the strip.
    if (next != null) items[next].focus();
  };

  return (
    <div
      ref={sheetRef}
      className={styles.sheet}
      data-place={place}
      role="menu"
      aria-label={t((d) => d.player.visualizer)}
      onKeyDown={onKeyDown}
    >
      <div className={styles.head}>
        <GroupChips current={group} onJump={onJump} markers={markers} />
      </div>
      <KindStrip checked={picked} stripRef={stripRef} onPick={onPick} onGroupChange={setGroup} tagFor={tagFor} />
      <SheetFooter picked={picked} aside={<DefaultsAside resolved={resolved} fallback={fallback} />} />
    </div>
  );
}
