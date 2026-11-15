/*
 * The finder's entrance and exit, drawn on the DOM. Opened from an on-screen search pill, the palette's own
 * input row starts as the pill's exact box and flies to its resting place while the card unfolds around
 * it, and a dismissal flies it back. Opened with no pill on screen, the card plays its own entrance. Under
 * reduced motion the overlay fades. Flight frames go straight to inline styles, so React renders once per
 * open and once per close. The timing and branches live in finderLifecycle.ts, the frame math in
 * finderMorph.ts; this file measures, paints and wires them to React.
 *
 * The pill hides itself while the finder is open (its aria-expanded state), so nothing here touches it.
 */

// -- Framework Imports --
import { useLayoutEffect, useRef, useState } from "react";

// -- Unit Imports --
import { createFinderLifecycle } from "./finderLifecycle";
import { cardFrame, fieldFrame, flightBackground, insetRect, measurable, rectInside, revealClip } from "./finderMorph";
import type { Scheduler } from "./finderLifecycle";
import type { CloseReason, FinderMotion, Insets, MorphEnd, MorphFrame, Rect } from "./finderMorph";

/** The palette parts the flight moves. The icon and the input are found inside the field. */
interface Parts {
  backdrop: HTMLDivElement;
  card: HTMLDivElement;
  field: HTMLLabelElement;
  label: HTMLSpanElement;
  hint: HTMLSpanElement;
  body: HTMLDivElement;
}

/** Everything one flight needs, measured once at its start with the palette at rest. */
interface Geometry {
  parts: Parts;
  icon: SVGElement;
  input: HTMLInputElement;
  from: MorphEnd;
  to: MorphEnd;
  panel: Rect;
  panelRadius: number;
  body: Rect;
  colors: { pill: string; ground: string; field: string; card: string };
}

const rectOf = (el: Element): Rect => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
};
const px = (n: number) => `${n.toFixed(2)}px`;
const insetText = (i: Insets) => `${px(i.top)} ${px(i.right)} ${px(i.bottom)} ${px(i.left)}`;
const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const browserScheduler: Scheduler = {
  frame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (id) => cancelAnimationFrame(id),
  timer: (callback, ms) => window.setTimeout(callback, ms),
  cancelTimer: (id) => window.clearTimeout(id),
  now: () => performance.now(),
};

/** Whether the pill shows whole, inside both the window and its own rail. */
export function originOnScreen(el: HTMLElement): boolean {
  const box = rectOf(el);
  const rail = el.closest("aside");
  return (
    rectInside(box, { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight }) &&
    (rail == null || rectInside(box, rectOf(rail)))
  );
}

/**
 * Measures the pill and the resting palette. The pill marks its parts with data-pill-label and
 * data-pill-hint. Null when a part is missing or either end has no size, which falls back to the card.
 */
function measure(origin: HTMLElement, parts: Parts): Geometry | null {
  const pillIcon = origin.querySelector("svg");
  const pillLabel = origin.querySelector("[data-pill-label]");
  const pillHint = origin.querySelector("[data-pill-hint]");
  const icon = parts.field.querySelector("svg");
  const input = parts.field.querySelector("input");
  if (!pillIcon || !pillLabel || !pillHint || !icon || !input) return null;

  const pill = rectOf(origin);
  const field = rectOf(parts.field);
  const pillStyle = getComputedStyle(origin);
  const fieldStyle = getComputedStyle(parts.field);
  const cardStyle = getComputedStyle(parts.card);
  const pillIconBox = rectOf(pillIcon);
  const pillHintBox = rectOf(pillHint);
  const iconBox = rectOf(icon);
  const from: MorphEnd = {
    box: pill,
    radius: Math.min(parseFloat(pillStyle.borderTopLeftRadius) || 0, pill.h / 2, pill.w / 2),
    iconX: pillIconBox.x - pill.x,
    iconSize: pillIconBox.w,
    textX: rectOf(pillLabel).x - pill.x,
    hintGap: pill.x + pill.w - (pillHintBox.x + pillHintBox.w),
  };
  const to: MorphEnd = {
    box: field,
    radius: parseFloat(fieldStyle.borderTopLeftRadius) || 0,
    iconX: iconBox.x - field.x,
    iconSize: iconBox.w,
    textX: rectOf(input).x - field.x,
    hintGap: 0,
  };
  if (!measurable(from, to)) return null;

  // The flying label wears the pill label's own type and colour, whatever state the pill was in.
  const labelStyle = getComputedStyle(pillLabel);
  parts.label.style.fontSize = labelStyle.fontSize;
  parts.label.style.fontWeight = labelStyle.fontWeight;
  parts.label.style.lineHeight = labelStyle.lineHeight;
  parts.label.style.letterSpacing = labelStyle.letterSpacing;
  parts.label.style.color = labelStyle.color;

  return {
    parts,
    icon,
    input,
    from,
    to,
    panel: rectOf(parts.card),
    panelRadius: parseFloat(cardStyle.borderTopLeftRadius) || 0,
    body: rectOf(parts.body),
    // The body paints the ambient ground, and its background colour is that ground's opaque base.
    colors: {
      pill: pillStyle.backgroundColor,
      ground: getComputedStyle(document.body).backgroundColor,
      field: fieldStyle.backgroundColor,
      card: cardStyle.backgroundColor,
    },
  };
}

function paint(geo: Geometry, frame: MorphFrame): void {
  const { parts } = geo;
  const f = fieldFrame(geo.from, geo.to, frame.k);
  parts.field.style.transform = `translate(${px(f.shiftX)}, ${px(f.shiftY)})`;
  parts.field.style.clipPath = `inset(${insetText(f.clip)} round ${px(f.radius)})`;
  parts.field.style.backgroundColor = flightBackground(geo.colors, frame.k);
  geo.icon.style.transformOrigin = "0 50%";
  geo.icon.style.transform = `translateX(${px(f.iconShift)}) scale(${f.iconScale.toFixed(4)})`;
  geo.input.style.transform = `translateX(${px(f.textShift)})`;
  geo.input.style.opacity = String(frame.placeholder);
  parts.label.style.transform = `translate(${px(f.labelX)}, -50%)`;
  parts.label.style.opacity = String(frame.label);
  parts.hint.style.transform = `translate(${px(f.hintShift)}, -50%)`;
  parts.hint.style.opacity = String(frame.hint);
  parts.backdrop.style.opacity = String(frame.scrim);

  const card = cardFrame(f.box, f.radius, geo.panel, geo.panelRadius, frame.card);
  parts.card.style.inset = insetText(card.inset);
  parts.card.style.borderRadius = px(card.radius);
  parts.card.style.opacity = String(card.opacity);
  // The results show only where the unfolding surface already covers them.
  parts.body.style.clipPath = `inset(${insetText(revealClip(geo.body, insetRect(geo.panel, card.inset)))})`;
  parts.body.style.opacity = String(frame.card);
}

function clear(geo: Geometry): void {
  const { parts } = geo;
  for (const el of [parts.field, parts.backdrop, parts.card, parts.body, parts.hint, geo.icon, geo.input]) {
    el.style.transform = "";
    el.style.transformOrigin = "";
    el.style.clipPath = "";
    el.style.opacity = "";
  }
  parts.field.style.backgroundColor = "";
  parts.card.style.inset = "";
  parts.card.style.borderRadius = "";
  parts.label.style.cssText = "";
}

/**
 * Runs the palette's motion. `origin` is the on-screen pill the palette opened from, or null. Returns the
 * part refs to attach, the current motion and phase, and the two controls: `close` with its reason, and
 * `land`, which ends an entrance at once when the user starts typing. `onClose` gets the reason once the
 * exit has played.
 */
export function useFinderMotion(origin: HTMLElement | null, onClose: (reason: CloseReason) => void) {
  const refs = {
    backdrop: useRef<HTMLDivElement | null>(null),
    card: useRef<HTMLDivElement | null>(null),
    field: useRef<HTMLLabelElement | null>(null),
    label: useRef<HTMLSpanElement | null>(null),
    hint: useRef<HTMLSpanElement | null>(null),
    body: useRef<HTMLDivElement | null>(null),
  };
  const [reduced] = useState(prefersReducedMotion);
  const [motion, setMotion] = useState<FinderMotion | null>(null);
  const [closing, setClosing] = useState(false);
  const [closed, setClosed] = useState<CloseReason | null>(null);

  const [lifecycle] = useState(() => {
    const parts = (): Parts | null => {
      const { backdrop, card, field, label, hint, body } = refs;
      if (!backdrop.current || !card.current || !field.current || !label.current || !hint.current || !body.current) {
        return null;
      }
      return { backdrop: backdrop.current, card: card.current, field: field.current, label: label.current, hint: hint.current, body: body.current };
    };
    return createFinderLifecycle<Geometry>({
      reduced,
      hasOrigin: origin != null,
      scheduler: browserScheduler,
      stage: {
        measure: () => {
          const p = parts();
          return origin && p ? measure(origin, p) : null;
        },
        paint,
        clear,
        originOnScreen: () => origin != null && originOnScreen(origin),
      },
      events: { motion: setMotion, closing: () => setClosing(true), unmount: setClosed },
    });
  });

  // The entrance, once per open: the origin and the entrance kind are fixed for the palette's life.
  useLayoutEffect(() => {
    lifecycle.open();
    return () => lifecycle.dispose();
  }, [lifecycle]);

  // Once the exit has played, the parent drops the palette before the next paint, so the pill is back in
  // its slot in the same frame the overlay leaves.
  useLayoutEffect(() => {
    if (closed) onClose(closed);
  }, [closed, onClose]);

  return {
    refs,
    motion: motion ?? lifecycle.motion,
    closing,
    mounted: closed == null,
    flies: origin != null && !reduced,
    close: lifecycle.close,
    land: lifecycle.land,
  };
}
