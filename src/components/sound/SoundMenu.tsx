// -- Framework Imports --
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { createPortal } from "react-dom";

// -- Component Imports --
import { IconToggle } from "../common/IconToggle";
import { EqIndicator } from "./EqIndicator";
import { SoundPopover } from "./SoundPopover";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./SoundMenu.module.css";

const POPOVER_WIDTH = 320;
const EDGE_GAP = 8;
const BUTTON_GAP = 10;

/** The waveform glyph of the Sound button, drawn to the app's 24px stroke icon grid. */
function SoundGlyph({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 15c2.6 0 3-9 5.8-9s2.9 12 5.7 12 3.2-8 6.5-8" />
    </svg>
  );
}

/**
 * The Sound button and the card it opens upward. The EQ-on dot rides the glyph. The card renders in a
 * fixed layer on the body, so a surface that clips its children (the mini-player) cannot cut it; it lines
 * up with `alignRef` when given, else with the button, and is kept inside the window. An outside press or
 * Escape closes it.
 */
export function SoundMenu({
  size = "md",
  alignRef,
}: {
  size?: "sm" | "md";
  alignRef?: RefObject<HTMLElement | null>;
}) {
  const t = useT();
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const buttonRef = useRef<HTMLSpanElement | null>(null);
  const layerRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [spot, setSpot] = useState<{ bottom: number; left: number } | null>(null);

  // Opens above the button, left-aligned to the anchor and clamped inside the window.
  useLayoutEffect(() => {
    if (!open) {
      setSpot(null);
      return;
    }
    const place = () => {
      const button = buttonRef.current?.getBoundingClientRect();
      const anchor = (alignRef?.current ?? buttonRef.current)?.getBoundingClientRect();
      if (!button || !anchor) return;
      const maxLeft = window.innerWidth - POPOVER_WIDTH - EDGE_GAP;
      setSpot({
        bottom: window.innerHeight - button.top + BUTTON_GAP,
        left: Math.max(EDGE_GAP, Math.min(anchor.left, maxLeft)),
      });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, alignRef]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!wrapRef.current?.contains(target) && !layerRef.current?.contains(target)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  // On open, focus moves into the card once it has painted.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() =>
      layerRef.current?.querySelector("button")?.focus({ preventScroll: true }),
    );
    return () => cancelAnimationFrame(frame);
  }, [open]);

  return (
    <span
      ref={wrapRef}
      className={styles.wrap}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
          buttonRef.current?.querySelector("button")?.focus();
        }
      }}
    >
      <span ref={buttonRef} className={styles.button}>
        <IconToggle
          size={size === "sm" ? "sm" : "md"}
          pressed={open}
          aria-label={t((d) => d.sound.title)}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((was) => !was)}
        >
          <span className={styles.glyph}>
            <SoundGlyph size={size === "sm" ? 16 : 20} />
            <EqIndicator />
          </span>
        </IconToggle>
      </span>

      {open && spot
        ? createPortal(
            <div
              ref={layerRef}
              className={styles.layer}
              style={{ bottom: spot.bottom, left: spot.left }}
            >
              <SoundPopover onClose={() => setOpen(false)} />
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
