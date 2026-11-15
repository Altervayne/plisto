// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import {
  CLOSE_MS,
  OPEN_MS,
  REST_FRAME,
  cardFrame,
  closeFrame,
  closeMotion,
  cubicBezier,
  fieldFrame,
  flightBackground,
  focusAfterClose,
  insetRect,
  layColor,
  measurable,
  mixColor,
  openFrame,
  openMotion,
  rectInside,
  revealClip,
} from "./finderMorph";
import type { MorphEnd, Rect } from "./finderMorph";

// A 222x32 pill in the rail and a 536x37 input row at rest in the palette.
const pill: MorphEnd = { box: { x: 20, y: 74, w: 222, h: 32 }, radius: 16, iconX: 12, iconSize: 16, textX: 37, hintGap: 12 };
const row: MorphEnd = { box: { x: 382, y: 124, w: 536, h: 37 }, radius: 12, iconX: 10, iconSize: 17, textX: 37, hintGap: 0 };

/** Where the transformed, clipped row actually shows. */
function shown(to: MorphEnd, k: number): Rect {
  const f = fieldFrame(pill, to, k);
  const moved = { ...to.box, x: to.box.x + f.shiftX, y: to.box.y + f.shiftY };
  return insetRect(moved, f.clip);
}

describe("fieldFrame", () => {
  it("shows the pill's exact box on the first frame", () => {
    expect(shown(row, 0)).toEqual(pill.box);
    const f = fieldFrame(pill, row, 0);
    expect(f.radius).toBe(16);
    expect(f.iconScale).toBeCloseTo(16 / 17);
    expect(f.labelX).toBe(37);
  });

  it("leaves the row untouched at rest", () => {
    const f = fieldFrame(pill, row, 1);
    expect(shown(row, 1)).toEqual(row.box);
    expect([f.shiftX, f.shiftY, f.iconShift, f.textShift]).toEqual([0, 0, 0, 0]);
    expect(f.clip).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    expect(f.iconScale).toBe(1);
    expect(f.radius).toBe(12);
  });

  it("passes through the in-between box halfway", () => {
    expect(shown(row, 0.5)).toEqual({ x: 201, y: 99, w: 379, h: 34.5 });
  });

  it("keeps the pill hint at its own gap from the shown right edge", () => {
    const f = fieldFrame(pill, row, 0);
    // The hint is anchored to the row's right edge, then shifted.
    expect(row.box.w + f.hintShift).toBe(pill.box.w - pill.hintGap);
  });

  it("never clips past zero when the origin is taller than the row", () => {
    const tall: MorphEnd = { ...row, box: { ...row.box, h: 24 } };
    const f = fieldFrame(pill, tall, 0);
    expect(f.clip.top).toBe(0);
    expect(f.clip.bottom).toBe(0);
    const box = shown(tall, 0);
    expect(box.h).toBe(24);
    expect(box.y + box.h / 2).toBe(pill.box.y + pill.box.h / 2);
  });
});

describe("cardFrame and revealClip", () => {
  const panel: Rect = { x: 370, y: 112, w: 560, h: 400 };

  it("starts as the field's own box and ends as the whole panel", () => {
    const start = cardFrame(row.box, 12, panel, 16, 0);
    expect(insetRect(panel, start.inset)).toEqual(row.box);
    expect(start.radius).toBe(12);
    expect(start.opacity).toBe(0);
    const end = cardFrame(row.box, 12, panel, 16, 1);
    expect(end.inset).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    expect(end.radius).toBe(16);
    expect(end.opacity).toBe(1);
  });

  it("is solid from its first step out, so the page never reads through it", () => {
    for (const k of [0.001, 0.05, 0.3, 0.9]) expect(cardFrame(row.box, 12, panel, 16, k).opacity).toBe(1);
  });

  it("hides a part the surface has not reached and shows one it covers", () => {
    const body: Rect = { x: 382, y: 171, w: 536, h: 300 };
    expect(revealClip(body, row.box).bottom).toBeGreaterThanOrEqual(body.h);
    expect(revealClip(body, panel)).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    expect(revealClip(body, { ...panel, h: 159 }).bottom).toBe(200);
  });
});

describe("rectInside", () => {
  const rail: Rect = { x: 0, y: 48, w: 256, h: 552 };

  it("takes a pill wholly inside its rail", () => {
    expect(rectInside(pill.box, rail)).toBe(true);
  });

  it("refuses a clipped or sizeless pill", () => {
    expect(rectInside({ ...pill.box, y: 40 }, rail)).toBe(false);
    expect(rectInside({ ...pill.box, w: 0 }, rail)).toBe(false);
    expect(rectInside(pill.box, { ...rail, w: 0 })).toBe(false);
  });
});

describe("timelines", () => {
  it("opens from the pill and lands at rest", () => {
    expect(openFrame(0)).toEqual({ k: 0, scrim: 0, card: 0, label: 1, placeholder: 0, hint: 1 });
    expect(openFrame(OPEN_MS)).toEqual(REST_FRAME);
  });

  it("holds the card until the field is nearly in place", () => {
    expect(openFrame(160).card).toBe(0);
    expect(openFrame(160).k).toBeGreaterThan(0.9);
    expect(openFrame(200).card).toBeGreaterThan(0);
  });

  it("moves every value one way, once, with no overshoot", () => {
    let last = openFrame(0);
    for (let t = 10; t <= OPEN_MS; t += 10) {
      const now = openFrame(t);
      expect(now.k).toBeGreaterThanOrEqual(last.k);
      expect(now.card).toBeGreaterThanOrEqual(last.card);
      expect(now.label).toBeLessThanOrEqual(last.label);
      expect(Math.max(now.k, now.card, now.scrim)).toBeLessThanOrEqual(1);
      last = now;
    }
  });

  it("flies back from rest to the pill", () => {
    expect(closeFrame(0)).toEqual(REST_FRAME);
    expect(closeFrame(CLOSE_MS)).toEqual({ k: 0, scrim: 0, card: 0, label: 1, placeholder: 0, hint: 1 });
  });

  it("starts a mid-flight close where the entrance stood", () => {
    const mid = openFrame(120);
    expect(closeFrame(0, mid)).toEqual(mid);
    expect(closeFrame(CLOSE_MS, mid).k).toBe(0);
  });

  it("closes from mid-entrance smoothly and one way across the whole run", () => {
    for (const startedAt of [40, 120, 200, 300]) {
      const mid = openFrame(startedAt);
      let last = closeFrame(0, mid);
      expect(last).toEqual(mid);
      for (let t = 1; t <= CLOSE_MS; t += 1) {
        const now = closeFrame(t, mid);
        // One way: everything heads to the pill and never turns back.
        expect(now.k).toBeLessThanOrEqual(last.k);
        expect(now.scrim).toBeLessThanOrEqual(last.scrim);
        expect(now.card).toBeLessThanOrEqual(last.card);
        expect(now.placeholder).toBeLessThanOrEqual(last.placeholder);
        expect(now.label).toBeGreaterThanOrEqual(last.label);
        expect(now.hint).toBeGreaterThanOrEqual(last.hint);
        // Smooth: no value moves more than a small step per millisecond.
        for (const key of ["k", "scrim", "card", "label", "placeholder", "hint"] as const) {
          expect(Math.abs(now[key] - last[key])).toBeLessThan(0.05);
        }
        last = now;
      }
      expect(last).toEqual({ k: 0, scrim: 0, card: 0, label: 1, placeholder: 0, hint: 1 });
    }
  });
});

describe("flightBackground", () => {
  // The light and dark token values as a browser computes them.
  const themes = {
    light: { pill: "rgba(28, 26, 64, 0.045)", ground: "rgb(244, 244, 248)", field: "rgba(28, 26, 64, 0.045)", card: "rgb(255, 255, 255)" },
    dark: { pill: "rgba(255, 255, 255, 0.09)", ground: "rgb(12, 12, 16)", field: "rgba(255, 255, 255, 0.05)", card: "rgb(23, 23, 29)" },
  };
  const alpha = (color: string) => {
    const parts = /^rgba?\(([^)]+)\)$/.exec(color)![1].split(",").map(Number);
    return parts.length > 3 ? parts[3] : 1;
  };

  it("starts on the pill's veil over the ground", () => {
    expect(flightBackground(themes.light, 0)).toBe("rgb(234.28, 234.19, 239.72)");
  });

  it("is opaque at every instant of the entrance and the fly-back, in both themes", () => {
    for (const colors of Object.values(themes)) {
      for (let t = 0; t <= OPEN_MS; t += 1) expect(alpha(flightBackground(colors, openFrame(t).k))).toBe(1);
      for (let t = 0; t <= CLOSE_MS; t += 1) expect(alpha(flightBackground(colors, closeFrame(t).k))).toBe(1);
      const mid = openFrame(100);
      for (let t = 0; t <= CLOSE_MS; t += 1) expect(alpha(flightBackground(colors, closeFrame(t, mid).k))).toBe(1);
    }
  });
});

describe("measurable", () => {
  it("takes two sized ends", () => {
    expect(measurable(pill, row)).toBe(true);
  });

  it("refuses a sizeless pill, field or field icon", () => {
    expect(measurable({ ...pill, box: { ...pill.box, w: 0 } }, row)).toBe(false);
    expect(measurable(pill, { ...row, box: { ...row.box, h: 0 } })).toBe(false);
    expect(measurable(pill, { ...row, iconSize: 0 })).toBe(false);
  });
});

describe("cubicBezier", () => {
  it("pins the ends and matches the CSS ease curve", () => {
    const ease = cubicBezier(0.25, 0.1, 0.25, 1);
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(0.5)).toBeCloseTo(0.8024, 3);
  });
});

describe("colour", () => {
  it("mixes premultiplied, so a clear start does not pass through grey", () => {
    expect(mixColor("rgba(0, 0, 0, 0)", "rgb(255, 255, 255)", 0.5)).toBe("rgba(255.00, 255.00, 255.00, 0.5000)");
    expect(mixColor("rgba(1, 2, 3, 0.5)", "rgb(4, 5, 6)", 0)).toBe("rgba(1, 2, 3, 0.5)");
    expect(mixColor("rgba(1, 2, 3, 0.5)", "rgb(4, 5, 6)", 1)).toBe("rgb(4, 5, 6)");
  });

  it("reads the space form with a slash alpha and a percentage alpha", () => {
    const comma = layColor("rgba(0, 0, 0, 0.5)", "rgb(255, 255, 255)");
    expect(layColor("rgb(0 0 0 / 0.5)", "rgb(255 255 255)")).toBe(comma);
    expect(layColor("rgb(0 0 0 / 50%)", "rgb(255, 255, 255)")).toBe(comma);
    expect(layColor("rgba(0, 0, 0, 50%)", "rgb(255, 255, 255)")).toBe(comma);
    expect(mixColor("rgb(0 0 0 / 0)", "rgb(255 255 255)", 0.5)).toBe("rgba(255.00, 255.00, 255.00, 0.5000)");
  });

  it("hands an unreadable colour to the browser's mix, with no jump on the second frame", () => {
    const from = "color(srgb 0 0 0 / 0.1)";
    expect(mixColor(from, "rgb(4, 5, 6)", 0)).toBe(from);
    expect(mixColor(from, "rgb(4, 5, 6)", 0.02)).toBe(`color-mix(in srgb, rgb(4, 5, 6) 2.00%, ${from})`);
    expect(mixColor(from, "rgb(4, 5, 6)", 1)).toBe("rgb(4, 5, 6)");
  });

  it("lays a veil over the card as one opaque colour", () => {
    expect(layColor("rgba(0, 0, 0, 0.5)", "rgb(255, 255, 255)")).toBe("rgb(127.50, 127.50, 127.50)");
  });

  it("never hands back a translucent field colour, whichever side cannot be read", () => {
    expect(layColor("color(srgb 0 0 0 / 0.05)", "rgb(255, 255, 255)")).toBe("rgb(255.00, 255.00, 255.00)");
    expect(layColor("rgba(28, 26, 64, 0.045)", "color(srgb 1 1 1)")).toBe("rgb(28.00, 26.00, 64.00)");
    expect(layColor("color(srgb 0 0 0 / 0.05)", "color(srgb 1 1 1)")).toBe("color(srgb 1 1 1)");
  });
});

describe("motion branches", () => {
  it("fades under reduced motion, whatever opened it", () => {
    expect(openMotion(true, true)).toBe("fade");
    expect(openMotion(true, false)).toBe("fade");
    expect(closeMotion(true, "dismiss", true)).toBe("fade");
  });

  it("flies from an on-screen pill and plays the card's own entrance without one", () => {
    expect(openMotion(false, true)).toBe("morph");
    expect(openMotion(false, false)).toBe("card");
  });

  it("flies back only on a dismissal with the pill still on screen", () => {
    expect(closeMotion(false, "dismiss", true)).toBe("morph");
    expect(closeMotion(false, "dismiss", false)).toBe("card");
    expect(closeMotion(false, "navigate", true)).toBe("card");
    expect(closeMotion(false, "play", true)).toBe("card");
  });

  it("fades the frame on screen when a pick lands during the entrance", () => {
    expect(closeMotion(false, "navigate", true, true)).toBe("fade");
    expect(closeMotion(false, "dismiss", false, true)).toBe("fade");
    expect(closeMotion(false, "dismiss", true, true)).toBe("morph");
  });
});

describe("focusAfterClose", () => {
  const pillButton = { isConnected: true };

  it("hands focus back after a dismissal or a pick that stays in place", () => {
    expect(focusAfterClose("dismiss", pillButton)).toBe(pillButton);
    expect(focusAfterClose("play", pillButton)).toBe(pillButton);
  });

  it("leaves focus to the destination after a pick that goes somewhere", () => {
    expect(focusAfterClose("navigate", pillButton)).toBeNull();
  });

  it("skips a target that has left the page or was never set", () => {
    expect(focusAfterClose("dismiss", { isConnected: false })).toBeNull();
    expect(focusAfterClose("dismiss", null)).toBeNull();
  });
});
