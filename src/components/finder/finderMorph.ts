/*
 * The math behind the finder's entrance from the sidebar search pill: the pill's own box becomes the
 * palette's input row, then the card unfolds from that row. Pure functions of measured rectangles and
 * time, no DOM, so every frame is deterministic and testable. The input row is never resized: it stays
 * at its resting size and is moved by a translate and cut down by an inset clip, so text never scales.
 */

/** A box in viewport pixels. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Distances cut from each edge of a box, as a CSS inset() takes them. */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** One end of the flight: the pill, or the input row at rest. Part offsets run from the box's left edge. */
export interface MorphEnd {
  box: Rect;
  radius: number;
  iconX: number;
  iconSize: number;
  textX: number;
  // The hint's right edge to the box's right edge. The input row has no hint, so its value is unused.
  hintGap: number;
}

/** Where every part of the input row stands at one instant of the flight. */
export interface FieldFrame {
  // The visible field, in viewport pixels.
  box: Rect;
  // Moves the row from its resting place.
  shiftX: number;
  shiftY: number;
  // Cuts the resting row down to the visible field.
  clip: Insets;
  radius: number;
  iconShift: number;
  iconScale: number;
  // Moves the input from its resting place.
  textShift: number;
  // The pill label's left edge, from the row's left edge.
  labelX: number;
  // Moves the pill hint from the row's right edge.
  hintShift: number;
}

/** The opacities and progress values of one instant. k runs from the pill (0) to the input row (1). */
export interface MorphFrame {
  k: number;
  scrim: number;
  card: number;
  label: number;
  placeholder: number;
  hint: number;
}

/** The palette at rest: the field landed, the card whole, the pill's label and hint gone. */
export const REST_FRAME: MorphFrame = { k: 1, scrim: 1, card: 1, label: 0, placeholder: 1, hint: 0 };

// -- Timing --

// The flight runs --dur-slow and the fly-back --dur-soft. The card unfolds over --dur-soft once the
// field is nearly in place; the offsets inside each run are this motion's own and live only here.
const FLIGHT_MS = 280;
const CARD_DELAY_MS = 160;
const CARD_MS = 200;
const LABEL_OUT_MS = 160;
const PLACEHOLDER_IN_DELAY_MS = 80;
const PLACEHOLDER_IN_MS = 200;
const HINT_OUT_MS = 100;
const FOLD_MS = 80;
const LABEL_IN_DELAY_MS = 60;
const LABEL_IN_MS = 140;
const PLACEHOLDER_OUT_MS = 100;
const HINT_IN_DELAY_MS = 100;
const HINT_IN_MS = 100;

/** The entrance's full length: the flight plus the card finishing under the landed field. */
export const OPEN_MS = CARD_DELAY_MS + CARD_MS;
/** The fly-back's length, matching the card's own exit. */
export const CLOSE_MS = 200;
/** The reduced-motion fade, matching --dur-fast. */
export const FADE_MS = 120;

// -- Easing --

/** A CSS cubic-bezier timing function, solved for y at a given x by bisection. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const at = (t: number, p1: number, p2: number) => 3 * (1 - t) * (1 - t) * t * p1 + 3 * (1 - t) * t * t * p2 + t * t * t;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (at(mid, x1, x2) < x) lo = mid;
      else hi = mid;
    }
    return at((lo + hi) / 2, y1, y2);
  };
}

// The same curves as --ease-cover, --ease-exit and --ease-standard in tokens.css.
const easeCover = cubicBezier(0.2, 0.7, 0.3, 1);
const easeExit = cubicBezier(0.4, 0, 1, 1);
const easeStandard = cubicBezier(0.4, 0, 0.2, 1);

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const ramp = (t: number, start: number, length: number, ease: (x: number) => number) =>
  ease(clamp01((t - start) / length));

// -- Timelines --

/** The entrance at t ms: one flight, the scrim with it, the card unfolding as the field lands. */
export function openFrame(t: number): MorphFrame {
  return {
    k: ramp(t, 0, FLIGHT_MS, easeCover),
    scrim: ramp(t, 0, FLIGHT_MS, easeCover),
    card: ramp(t, CARD_DELAY_MS, CARD_MS, easeCover),
    label: 1 - ramp(t, 0, LABEL_OUT_MS, easeStandard),
    placeholder: ramp(t, PLACEHOLDER_IN_DELAY_MS, PLACEHOLDER_IN_MS, easeStandard),
    hint: 1 - ramp(t, 0, HINT_OUT_MS, easeStandard),
  };
}

/**
 * The fly-back at t ms, starting from `from`: the results fold into the field while the field returns to
 * the pill. Every value runs from where it stands toward the pill, so a close in mid-flight never jumps.
 */
export function closeFrame(t: number, from: MorphFrame = REST_FRAME): MorphFrame {
  const back = ramp(t, 0, CLOSE_MS, easeExit);
  return {
    k: lerp(from.k, 0, back),
    scrim: lerp(from.scrim, 0, back),
    card: lerp(from.card, 0, ramp(t, 0, FOLD_MS, easeExit)),
    label: lerp(from.label, 1, ramp(t, LABEL_IN_DELAY_MS, LABEL_IN_MS, easeStandard)),
    placeholder: lerp(from.placeholder, 0, ramp(t, 0, PLACEHOLDER_OUT_MS, easeStandard)),
    hint: lerp(from.hint, 1, ramp(t, HINT_IN_DELAY_MS, HINT_IN_MS, easeStandard)),
  };
}

// -- Geometry --

const lerpRect = (a: Rect, b: Rect, k: number): Rect => ({
  x: lerp(a.x, b.x, k),
  y: lerp(a.y, b.y, k),
  w: lerp(a.w, b.w, k),
  h: lerp(a.h, b.h, k),
});

/**
 * The input row at progress k between the pill (`from`) and its resting place (`to`). The row keeps its
 * resting size: the clip cuts it to the in-between box, anchored at the left edge and centred vertically,
 * and the shift moves that box into place. An end larger than the row in either axis shows the whole row
 * in that axis, since a clip cannot grow a box.
 */
export function fieldFrame(from: MorphEnd, to: MorphEnd, k: number): FieldFrame {
  const target = lerpRect(from.box, to.box, k);
  const clipX = Math.max(0, to.box.w - target.w);
  const clipY = Math.max(0, (to.box.h - target.h) / 2);
  const w = to.box.w - clipX;
  const h = to.box.h - 2 * clipY;
  const centreY = target.y + target.h / 2;
  const labelX = lerp(from.textX, to.textX, k);
  return {
    box: { x: target.x, y: centreY - h / 2, w, h },
    shiftX: target.x - to.box.x,
    shiftY: centreY - (to.box.y + to.box.h / 2),
    clip: { top: clipY, right: clipX, bottom: clipY, left: 0 },
    radius: lerp(from.radius, to.radius, k),
    iconShift: lerp(from.iconX, to.iconX, k) - to.iconX,
    iconScale: lerp(from.iconSize, to.iconSize, k) / to.iconSize,
    textShift: labelX - to.textX,
    labelX,
    hintShift: -(clipX + from.hintGap),
  };
}

/**
 * The card's surface at unfold progress k: k 0 is the field's own box, k 1 the whole panel. Returned as
 * insets from the panel's edges, with the corner radius and the surface opacity. The surface is whole
 * from the first step out, so nothing under the palette reads through it; at k 0 it hides entirely,
 * since it would only sit behind the field.
 */
export function cardFrame(
  field: Rect,
  fieldRadius: number,
  panel: Rect,
  panelRadius: number,
  k: number,
): { inset: Insets; radius: number; opacity: number } {
  return {
    inset: {
      top: lerp(field.y - panel.y, 0, k),
      right: lerp(panel.x + panel.w - (field.x + field.w), 0, k),
      bottom: lerp(panel.y + panel.h - (field.y + field.h), 0, k),
      left: lerp(field.x - panel.x, 0, k),
    },
    radius: lerp(fieldRadius, panelRadius, k),
    opacity: k > 0 ? 1 : 0,
  };
}

/** The clip that shows only the part of `part` inside `area`, as insets from `part`'s own edges. */
export function revealClip(part: Rect, area: Rect): Insets {
  return {
    top: Math.max(0, area.y - part.y),
    right: Math.max(0, part.x + part.w - (area.x + area.w)),
    bottom: Math.max(0, part.y + part.h - (area.y + area.h)),
    left: Math.max(0, area.x - part.x),
  };
}

/** A box shrunk by insets. */
export function insetRect(box: Rect, inset: Insets): Rect {
  return {
    x: box.x + inset.left,
    y: box.y + inset.top,
    w: box.w - inset.left - inset.right,
    h: box.h - inset.top - inset.bottom,
  };
}

/** Whether `inner` has a size and lies wholly inside `outer`: a pill clipped by its rail is not an origin. */
export function rectInside(inner: Rect, outer: Rect): boolean {
  return (
    inner.w > 0 &&
    inner.h > 0 &&
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

// -- Colour --

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** A number, or a percentage of `whole`. */
function amount(text: string, whole: number): number {
  return text.endsWith("%") ? (parseFloat(text) / 100) * whole : Number(text);
}

/** Reads rgb() and rgba() in the comma form and in the space form with a slash alpha. */
function parseColor(value: string): Rgba | null {
  const match = /^rgba?\((.+)\)$/.exec(value.trim());
  if (!match) return null;
  const [channels, slashAlpha, extra] = match[1].split("/");
  if (extra !== undefined) return null;
  const parts = channels.split(/[\s,]+/).filter(Boolean);
  const alphaText = slashAlpha?.trim() ?? (parts.length === 4 ? parts.pop() : undefined);
  if (parts.length !== 3) return null;
  const [r, g, b] = parts.map((p) => amount(p, 255));
  const a = alphaText === undefined ? 1 : amount(alphaText, 1);
  if ([r, g, b, a].some(Number.isNaN)) return null;
  return { r, g, b, a };
}

const rgb = (c: Rgba) => `rgb(${c.r.toFixed(2)}, ${c.g.toFixed(2)}, ${c.b.toFixed(2)})`;

/**
 * The colour at k between two computed colours, mixed premultiplied so a near-transparent veil does not
 * pass through grey on its way to an opaque fill. A colour this cannot read is handed to the browser's
 * own color-mix(), which mixes the same way, so the change still runs smoothly.
 */
export function mixColor(from: string, to: string, k: number): string {
  if (k <= 0) return from;
  if (k >= 1) return to;
  const a = parseColor(from);
  const b = parseColor(to);
  if (!a || !b) return `color-mix(in srgb, ${to} ${(k * 100).toFixed(2)}%, ${from})`;
  const alpha = lerp(a.a, b.a, k);
  const channel = (c: "r" | "g" | "b") => (alpha === 0 ? 0 : lerp(a[c] * a.a, b[c] * b.a, k) / alpha).toFixed(2);
  return `rgba(${channel("r")}, ${channel("g")}, ${channel("b")}, ${alpha.toFixed(4)})`;
}

/**
 * A translucent colour laid over an opaque one, as one opaque colour. Always opaque: when one side cannot
 * be read, the other is used at full strength, and with neither, `under`, the opaque card surface.
 */
export function layColor(top: string, under: string): string {
  const a = parseColor(top);
  const b = parseColor(under);
  if (a && b) {
    return rgb({ r: a.r * a.a + b.r * (1 - a.a), g: a.g * a.a + b.g * (1 - a.a), b: a.b * a.a + b.b * (1 - a.a), a: 1 });
  }
  if (b) return rgb(b);
  if (a) return rgb(a);
  return under;
}

/**
 * The flying field's fill at k: from the pill's veil laid over the app's ground to the field's veil laid
 * over the card. Both ends are opaque and the mix keeps them so, so the page never reads through the
 * field, its label or its hint in flight. The ground is the plain background colour, without the ambient
 * washes painted over it, so the first frame can differ from the pill by that wash alone.
 */
export function flightBackground(
  colors: { pill: string; ground: string; field: string; card: string },
  k: number,
): string {
  return mixColor(layColor(colors.pill, colors.ground), layColor(colors.field, colors.card), k);
}

// -- Branches --

/** How the palette moves: the pill's flight, the card's own entrance and exit, or the reduced-motion fade. */
export type FinderMotion = "morph" | "card" | "fade";

/** Why the palette closed: a dismissal, a pick that goes somewhere, or a pick that plays in place. */
export type CloseReason = "dismiss" | "navigate" | "play";

// The dismissal flies the field back to the pill. Setting this false makes every close the card's own exit.
const DISMISS_FLIES_BACK = true;

/** Whether a flight can be drawn between these ends: both boxes and the field's icon need a size. */
export function measurable(from: MorphEnd, to: MorphEnd): boolean {
  return from.box.w > 0 && from.box.h > 0 && to.box.w > 0 && to.box.h > 0 && to.iconSize > 0;
}

/** The entrance: the fade under reduced motion, the flight when a pill is on screen, otherwise the card. */
export function openMotion(reduced: boolean, hasOrigin: boolean): FinderMotion {
  if (reduced) return "fade";
  return hasOrigin ? "morph" : "card";
}

/**
 * The exit: the fade under reduced motion; a dismissal flies back when the pill is still on screen; a pick
 * leaves with the card's own exit as the destination changes, and so does a dismissal whose pill has gone.
 * A non-flying exit during the entrance fades the frame on screen instead, so nothing snaps to rest first.
 */
export function closeMotion(
  reduced: boolean,
  reason: CloseReason,
  originOnScreen: boolean,
  entering = false,
): FinderMotion {
  if (reduced) return "fade";
  if (DISMISS_FLIES_BACK && reason === "dismiss" && originOnScreen) return "morph";
  return entering ? "fade" : "card";
}

/** Where focus goes once the palette is gone: back where it came from, unless a pick went somewhere new. */
export function focusAfterClose<T extends { isConnected: boolean }>(reason: CloseReason, returnFocus: T | null): T | null {
  if (reason === "navigate" || returnFocus == null || !returnFocus.isConnected) return null;
  return returnFocus;
}
