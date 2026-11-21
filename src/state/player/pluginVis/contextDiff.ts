/*
 * Finds what changed in a mount's context since the last one sent, so an `update` message carries only the
 * changed fields. Values are compared by content, except the cover, which is a bitmap compared by identity.
 * The tracker keeps its own copy of what it last reported, so a caller that mutates its context in place
 * still gets the change.
 */

// -- Type Imports --
import type { HostMessage, VisContext, VisLayout, VisRect } from "../../../visRuntime/protocol";

const rectEq = (a: VisRect | null, b: VisRect | null): boolean =>
  a === b || (a !== null && b !== null && a.every((v, i) => v === b[i]));

function layoutEq(a: VisLayout, b: VisLayout): boolean {
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.radius === b.radius &&
    a.floor === b.floor &&
    rectEq(a.cover, b.cover) &&
    rectEq(a.mask, b.mask) &&
    a.hush.length === b.hush.length &&
    a.hush.every((rect, i) => rectEq(rect, b.hush[i]))
  );
}

const arrayEq = (a: ArrayLike<number>, b: ArrayLike<number>): boolean =>
  a.length === b.length && Array.prototype.every.call(a, (v, i) => v === b[i]);

function settingsEq(a: VisContext["settings"], b: VisContext["settings"]): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => k in b && a[k] === b[k]);
}

function snapshot(context: VisContext): VisContext {
  const { layout } = context;
  return {
    ...context,
    layout: {
      ...layout,
      cover: [...layout.cover],
      mask: layout.mask ? [...layout.mask] : null,
      hush: layout.hush.map((rect) => [...rect] as VisRect),
    },
    palette: context.palette.slice(),
    colors: {
      ground: [...context.colors.ground],
      backing: [...context.colors.backing],
      ink: [...context.colors.ink],
    },
    settings: { ...context.settings },
  };
}

export interface ContextTracker {
  // The fields of `next` that differ from the last reported context, or null when none do.
  diff: (next: VisContext) => Partial<VisContext> | null;
}

/** Starts from the context sent whole at init. */
export function createContextTracker(initial: VisContext): ContextTracker {
  let last = snapshot(initial);
  return {
    diff(next) {
      const changed: Partial<VisContext> = {};
      let any = false;
      const mark = <K extends keyof VisContext>(key: K) => {
        (changed[key] as VisContext[K]) = next[key];
        any = true;
      };
      if (!layoutEq(last.layout, next.layout)) mark("layout");
      if (!arrayEq(last.palette, next.palette)) mark("palette");
      if (last.cover !== next.cover) mark("cover");
      if (
        !last.colors.ground.every((v, i) => v === next.colors.ground[i]) ||
        !last.colors.backing.every((v, i) => v === next.colors.backing[i]) ||
        !last.colors.ink.every((v, i) => v === next.colors.ink[i])
      ) {
        mark("colors");
      }
      if (last.light !== next.light) mark("light");
      if (last.reactivity !== next.reactivity) mark("reactivity");
      if (last.ambient !== next.ambient) mark("ambient");
      if (last.reducedMotion !== next.reducedMotion) mark("reducedMotion");
      if (!settingsEq(last.settings, next.settings)) mark("settings");
      if (!any) return null;
      last = snapshot(next);
      return changed;
    },
  };
}

/** Posts an `update` carrying the changed fields of each context pushed in, and nothing when none changed. */
export function createContextSync(
  initial: VisContext,
  post: (message: HostMessage) => void,
): { push: (next: VisContext) => void } {
  const tracker = createContextTracker(initial);
  return {
    push(next) {
      const context = tracker.diff(next);
      if (context) post({ type: "update", context });
    },
  };
}
