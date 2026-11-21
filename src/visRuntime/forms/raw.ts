/*
 * The raw form: the kind owns its drawing entirely, on its own canvas or the DOM. It is ready once its
 * first frame returns.
 */

// -- Type Imports --
import type { RawHandlers, Registration } from "../lifecycle";

export function rawForm(handlers: RawHandlers): Registration {
  if (typeof handlers?.frame !== "function") throw new Error("a raw visualizer needs a frame handler");
  return () => ({ form: "raw", handlers });
}
