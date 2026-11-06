/*
 * The shelf placement: where each record sits for a focus. Distance from the focus sets the offset,
 * depth and fade, and every group boundary between a record and the focus adds a gap. Group labels
 * ride above each group's first record at a gentler tilt than its cover. Pure, in pixels and degrees.
 */

export const SHELF = {
  angle: 64,
  gap: 0.66,
  step: 0.16,
  z0: 210,
  dz: 26,
  veil: 0.06,
  groupGap: 0.42,
  labelTilt: 0.42,
} as const;

/** Records kept mounted on each side of the focus. */
export const WINDOW_RADIUS = 12;

/** A focus move longer than this cross-fades the shelf instead of sliding it. */
export const FAR_JUMP = 14;

export interface Placement {
  x: number;
  z: number;
  /** Rotation about the vertical axis, in degrees. */
  ry: number;
  /** Uniform scale; 1 on the tilted shelf. */
  s: number;
  /** Darkening over the cover, 0 to 1. */
  veil: number;
  /** CSS transform for the record. */
  transform: string;
}

/** The inclusive index range to mount around the focus; lo > hi when there is nothing to mount. */
export function windowRange(focus: number, count: number): { lo: number; hi: number } {
  if (count <= 0) return { lo: 0, hi: -1 };
  return {
    lo: Math.max(0, focus - WINDOW_RADIUS),
    hi: Math.min(count - 1, focus + WINDOW_RADIUS),
  };
}

export const isFarJump = (from: number, to: number): boolean => Math.abs(to - from) > FAR_JUMP;

/**
 * Places record `i` for the focus. `cs` is the cover size. Reduced motion lays a flat strip: no depth,
 * no rotation, neighbours shrunk, the group gaps kept.
 */
export function place(
  i: number,
  focus: number,
  groupOf: ArrayLike<number>,
  cs: number,
  reduced: boolean,
): Placement {
  const d = i - focus;
  const a = Math.abs(d);
  const sg = Math.sign(d);
  const t = Math.min(1, a);
  const rest = Math.max(0, a - 1);
  const boundaries = Math.abs(groupOf[i] - groupOf[focus]);
  if (reduced) {
    const x = sg * (t * cs * 0.82 + rest * (cs * 0.62 + 14) + boundaries * cs * 0.3);
    const s = 1 - 0.38 * t;
    return {
      x,
      z: 0,
      ry: 0,
      s,
      veil: Math.min(0.5, a * 0.05),
      transform: `translate3d(${x}px, 0, 0) scale(${s})`,
    };
  }
  const x = sg * (t * SHELF.gap * cs + rest * SHELF.step * cs + boundaries * SHELF.groupGap * cs);
  const z = -(t * SHELF.z0 + rest * SHELF.dz + boundaries * 14);
  const ry = -sg * t * SHELF.angle;
  return {
    x,
    z,
    ry,
    s: 1,
    veil: Math.min(0.82, a * SHELF.veil),
    transform: `translate3d(${x}px, 0, ${z}px) rotateY(${ry}deg)`,
  };
}

/** Stacking order: the focus on top, falling with distance. */
export const zIndexOf = (i: number, focus: number): number => 1000 - Math.abs(i - focus) * 2;

export interface LabelPlacement {
  /** The group's first record index. */
  start: number;
  transform: string;
  /** The room before the next label, so a label ellipsizes instead of overlapping it. */
  maxWidth: number;
  opacity: number;
  /** True for the focused record's group. */
  current: boolean;
}

/**
 * Lays out the labels of the groups whose first record is mounted (`starts`, ascending). A label
 * anchors at its record's visible left edge.
 */
export function layoutLabels(
  starts: number[],
  placed: (i: number) => Placement,
  focus: number,
  groupOf: ArrayLike<number>,
  cs: number,
  reduced: boolean,
): LabelPlacement[] {
  const edges = starts.map((start) => {
    const p = placed(start);
    const half = (cs / 2) * (reduced ? p.s : Math.cos((p.ry * Math.PI) / 180));
    return { start, p, left: p.x - half };
  });
  return edges.map(({ start, p, left }, k) => {
    const next = edges[k + 1];
    const room = next ? next.left - left - 10 : cs * 1.6;
    const top = -(cs / 2) * (reduced ? p.s : 1) - 12;
    const transform = reduced
      ? `translate3d(${left}px, ${top}px, 0) translateY(-100%)`
      : `translate3d(${left}px, ${top}px, ${p.z}px) rotateY(${p.ry * SHELF.labelTilt}deg) translateY(-100%)`;
    return {
      start,
      transform,
      maxWidth: Math.max(28, room),
      opacity: Math.max(0.42, 1 - Math.abs(start - focus) * 0.06),
      current: groupOf[focus] === groupOf[start],
    };
  });
}
