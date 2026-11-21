/*
 * What a mount draws through: a GL surface over the renderer and the compile gate, or a raw surface over
 * the handlers a kind registered.
 */

// -- Local Imports --
import { MountError, createGate, errorText } from "./gate";
import { deferredCompile } from "../components/player/visualizers/gl/compile";
import { ProgramPending } from "../components/player/visualizers/gl/kit";

// -- Type Imports --
import type { VisFrame } from "./frame";
import type { GlMount, LifecycleEnv, RawHandlers } from "./lifecycle";
import type { VisComposite, VisContext, VisInit } from "./protocol";
import type { SceneSource, SceneTraits } from "../components/player/visualizers/gl/renderer";

// The one kind a frame renders; the renderer keys its candidate by it.
const KIND = "mount";

const BLEND_OF: Record<VisComposite, SceneTraits["blend"]["light"]> = {
  light: "screen",
  ink: "multiply",
  image: "normal",
};

/** What a mount draws through, whichever form it is. */
export interface Surface {
  // Starts a frame: a compile submitted in an earlier one may now be polled.
  nextFrame: () => void;
  // Throws ProgramPending when nothing reached the canvas.
  draw: (frame: VisFrame) => void;
  // Draws the still frame; returns the canvas to read it from, the still itself, or null for none.
  still: (frame: VisFrame) => HTMLCanvasElement | ImageBitmap | null;
  update: (ctx: VisContext, changed: Partial<VisContext>) => void;
  // The canvas the kind draws on, which the meter watches, or null when there is none.
  canvas: HTMLCanvasElement | null;
  dispose: () => void;
}

export function glSurface(init: VisInit, mount: GlMount, env: LifecycleEnv, onLost: () => void): Surface {
  const canvas = env.createCanvas();
  const gate = createGate(mount.programs, mount.factory);
  const source: SceneSource = {
    factory: gate.factory,
    descriptor: {
      fillsStage: init.fillsStage,
      blend: { light: BLEND_OF[init.composite.light], dark: BLEND_OF[init.composite.dark] },
      composite: init.composite,
    },
  };
  const renderer = env.createRenderer<string>(canvas, () => source, deferredCompile);
  if (!renderer) {
    canvas.remove();
    throw new MountError("setup", "WebGL2 is unavailable");
  }
  const onContextLost = (e: Event) => {
    e.preventDefault();
    onLost();
  };
  canvas.addEventListener("webglcontextlost", onContextLost);
  renderer.fit(init.context.layout);

  // Runs a render only when no program is compiling, so an aborted draw never touches the trail.
  const guarded = (run: () => void) => {
    if (gate.blocked()) throw new ProgramPending(KIND);
    try {
      run();
    } catch (e) {
      if (e instanceof ProgramPending) gate.hold();
      throw e;
    }
  };

  return {
    nextFrame: gate.nextFrame,
    draw: (f) => guarded(() => renderer.render(KIND, f)),
    still(f) {
      guarded(() => renderer.still(KIND, f));
      return canvas;
    },
    update(ctx, changed) {
      if (changed.layout) renderer.fit(ctx.layout);
    },
    canvas,
    dispose() {
      canvas.removeEventListener("webglcontextlost", onContextLost);
      try {
        renderer.dispose();
      } finally {
        canvas.remove();
      }
    },
  };
}

export function rawSurface(init: VisInit, h: RawHandlers): Surface {
  let canvas: HTMLCanvasElement | null;
  try {
    canvas = h.setup?.(init.context) || null;
  } catch (e) {
    throw new MountError("setup", errorText(e));
  }
  return {
    nextFrame: () => {},
    draw: (f) => h.frame(f),
    still(f) {
      if (!h.still) {
        h.frame(f);
        return canvas;
      }
      return h.still(f) ?? canvas;
    },
    update(ctx, changed) {
      if (changed.layout) h.resize?.(ctx.layout);
      if (changed.settings) h.settings?.(ctx.settings);
      if (changed.light !== undefined || changed.palette || changed.colors || changed.cover !== undefined) {
        h.theme?.(ctx);
      }
    },
    canvas,
    dispose: () => h.dispose?.(),
  };
}
