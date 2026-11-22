/*
 * The reduced-motion still of a plugin kind. Under the preference a kind draws no live frame: one
 * short-lived mount renders a still, which is painted on a canvas of Plisto's own, and a changed size,
 * theme, palette or setting repaints it through one new mount after a quiet period. The session in
 * stillSession.ts decides what each outcome does; this hook wires it to the page. The phase it reports lets
 * the dip swap the kind in once the first outcome is in.
 */

// -- Framework Imports --
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { RefObject } from "react";

// -- Local Imports --
import { leavePhase, type StageSurface } from "./frameCache";
import { useKindStopped, useNetPolicy } from "./netPolicy";
import { createStillSession, stillGate, type StillPhase, type StillSession } from "./stillSession";

// -- State Imports --
import { usePluginRuntime } from "../../plugins/store";

// -- Type Imports --
import type { VisContext } from "../../../visRuntime/protocol";
import type { PluginVisualizerDescriptor } from "../pluginVisualizers";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

/** Whether the user prefers reduced motion, following a change as it happens. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia(REDUCED_MOTION);
      query.addEventListener("change", notify);
      return () => query.removeEventListener("change", notify);
    },
    () => window.matchMedia(REDUCED_MOTION).matches,
  );
}

export interface StillOptions {
  descriptor: PluginVisualizerDescriptor;
  surface: StageSurface;
  // The mount's key: the watchers and the session are made once per key.
  mountKey: string;
  slotRef: RefObject<HTMLElement | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  // The context as of now; read when a render starts.
  context: () => VisContext;
  // Values whose change repaints the still: the palette, the cover and the kind's resolved settings.
  inputs: readonly unknown[];
  // A mount failed before the first still, as a live frame's error does.
  onFail: () => void;
}

/** Paints a bitmap on the canvas at its own size, or clears the canvas for none. */
function paintStill(canvas: HTMLCanvasElement | null, bitmap: ImageBitmap | null): void {
  if (canvas) {
    canvas.width = bitmap?.width ?? 0;
    canvas.height = bitmap?.height ?? 0;
    if (bitmap) canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
  }
  bitmap?.close();
}

const sameInputs = (a: readonly unknown[], b: readonly unknown[]) =>
  a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

/** Renders and keeps current one plugin kind's still; the phase is `ready` once the first answer is in. */
export function useStill(options: StillOptions): StillPhase {
  const { descriptor, surface, mountKey, slotRef } = options;
  const live = useRef(options);
  live.current = options;
  const session = useRef<StillSession | null>(null);
  const [phase, setPhase] = useState<StillPhase>("mounting");
  const kind = descriptor.id;
  const marksLoaded = useNetPolicy((s) => s.loaded);
  const gate = stillGate(usePluginRuntime(), marksLoaded, useKindStopped(kind));

  useEffect(() => {
    let lastSize = "";
    const made = createStillSession({
      descriptor,
      surface,
      context: () => {
        const context = live.current.context();
        lastSize = `${context.layout.width}x${context.layout.height}`;
        return context;
      },
      paint: (bitmap) => paintStill(live.current.canvasRef.current, bitmap),
      setPhase,
      onFail: () => live.current.onFail(),
    });
    session.current = made;
    const trigger = made.trigger;

    const slot = slotRef.current;
    // Before any render read the context, the one that runs will read the size as it is then.
    const resize = new ResizeObserver(() => {
      const box = slot?.getBoundingClientRect();
      if (box && lastSize !== "" && `${box.width}x${box.height}` !== lastSize) trigger();
    });
    if (slot) resize.observe(slot);
    const themeWatch = new MutationObserver(trigger);
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    scheme.addEventListener("change", trigger);

    return () => {
      session.current = null;
      made.dispose();
      resize.disconnect();
      themeWatch.disconnect();
      scheme.removeEventListener("change", trigger);
      leavePhase(surface, kind);
    };
    // One session and set of watchers per key; what they read comes through `live`.
  }, [mountKey]);

  // An open gate runs a render that is owed; a blocked one cancels the render in flight.
  useEffect(() => {
    if (gate === "open") session.current?.open();
    else if (gate === "blocked") session.current?.block();
  }, [gate, mountKey]);

  // A changed palette, cover or setting repaints; comparing with the inputs seen last keeps a repeated
  // effect run from repainting.
  const seen = useRef(options.inputs);
  useEffect(() => {
    const before = seen.current;
    seen.current = options.inputs;
    if (!sameInputs(before, options.inputs)) session.current?.trigger();
  }, options.inputs);

  return phase;
}
