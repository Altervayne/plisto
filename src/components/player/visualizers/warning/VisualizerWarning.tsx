// -- Framework Imports --
import { useEffect, useLayoutEffect, useRef, useState } from "react";

// -- Component Imports --
import { WarningCard } from "./WarningCard";

// -- State Imports --
import {
  PREF_KEYS,
  useRetryPreference,
  useVisualizerCatalog,
  usePlayerVisualizer,
  usePlayerVisualizerReactivity,
  usePreferencesStore,
} from "../../../../state/preferences/store";
import {
  acknowledgeWarning,
  cozyOnlyRefused,
  isCalm,
  isCozyOnly,
  isVisualizersOff,
  setCalm,
  setCozyOnly,
  setVisualizersOff,
  settleWarningKind,
  useWarningKind,
  useWarningStatus,
} from "../../../../state/player/visualizerWarning";

// -- Type Imports --
import type { RefObject } from "react";
import type { WarningChoice } from "./WarningCard";

/**
 * The photosensitivity notice's gate. It shows while the acknowledgement is pending, shows nothing while
 * the preferences are still loading, and never shows once acknowledged. An unreadable flag is re-read once
 * on mount; the notice appears only if that re-read still fails, so a read error neither hides the notice
 * from someone who has not acknowledged nor shows it again to someone who has.
 */
export function VisualizerWarning({ floorRef }: { floorRef?: RefObject<HTMLElement | null> }) {
  const status = useWarningStatus();
  const retry = useRetryPreference();
  const [retried, setRetried] = useState(false);

  useEffect(() => {
    if (status !== "unreadable" || retried) return;
    void retry(PREF_KEYS.visualizerWarningAck).finally(() => {
      settleWarningKind();
      setRetried(true);
    });
  }, [status, retried, retry]);

  if (status === "pending" || (status === "unreadable" && retried)) return <WarningNotice floorRef={floorRef} />;
  return null;
}

/** Space kept between the card and the floor element, and above the card for the queue header. */
const FLOOR_GAP = 44; // clears the volume popover that rises above the seek bar
const TOP_CLEARANCE = 56;

/**
 * Rests the card just above `floorRef` (the seek bar) inside its panel, and caps its height to the room
 * between the queue header and that floor, so it covers neither the transport nor the queue's controls.
 * The card scrolls inside itself when the window leaves less room than it needs. Without a floor the
 * stylesheet's offsets apply.
 */
function useAboveFloor(cardRef: RefObject<HTMLDivElement | null>, floorRef?: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const card = cardRef.current;
    const floor = floorRef?.current;
    const panel = card?.parentElement;
    if (!card || !floor || !panel) return;
    const place = () => {
      const gap = panel.getBoundingClientRect().bottom - floor.getBoundingClientRect().top + FLOOR_GAP;
      card.style.bottom = `${gap}px`;
      card.style.maxHeight = `calc(100% - ${gap + TOP_CLEARANCE}px)`;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(panel);
    observer.observe(floor);
    return () => observer.disconnect();
  }, [cardRef, floorRef]);
}

/**
 * The notice with its state. Each switch reads the stored preference, so it shows the real setting
 * whenever the notice mounts, and applies through the same actions Settings uses. The box is local: a
 * remount starts it unticked. Focus moves to the card when it appears.
 */
function WarningNotice({ floorRef }: { floorRef?: RefObject<HTMLElement | null> }) {
  const kind = useWarningKind();
  const catalog = useVisualizerCatalog();
  const reactivity = usePlayerVisualizerReactivity();
  const pick = usePlayerVisualizer();
  const failedKeys = usePreferencesStore((s) => s.failedKeys);
  const [ack, setAck] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);

  useAboveFloor(cardRef, floorRef);
  useEffect(() => {
    cardRef.current?.focus({ preventScroll: true });
  }, []);

  const choices: WarningChoice[] = [
    { id: "cozy", on: isCozyOnly(catalog), disabled: cozyOnlyRefused(catalog), onChange: setCozyOnly },
    {
      id: "calm",
      on: isCalm(reactivity),
      disabled: failedKeys.has(PREF_KEYS.playerVisualizerReactivity),
      onChange: setCalm,
    },
    {
      id: "off",
      on: isVisualizersOff(pick),
      disabled: failedKeys.has(PREF_KEYS.playerVisualizer),
      onChange: setVisualizersOff,
    },
  ];

  return (
    <WarningCard
      kind={kind}
      choices={choices}
      ack={ack}
      onAck={setAck}
      onCarry={() => {
        if (!ack) return;
        acknowledgeWarning();
        // The card unmounts with focus on Carry on: hand focus to the button it unlocked.
        document.querySelector<HTMLElement>("[data-visualizer-trigger]")?.focus({ preventScroll: true });
      }}
      cardRef={cardRef}
    />
  );
}
