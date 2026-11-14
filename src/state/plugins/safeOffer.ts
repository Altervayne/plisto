/*
 * The answer to the held runtime. The gate lets one answer through: a second press while the first is in
 * flight, or the confirm's follow-up close, is ignored. A failed resolve reopens the gate so the user can
 * answer again, and a successful one hands the boot view on.
 */

// -- Type Imports --
import type { PluginBootState } from "../../types";

/** Returns the answer function: `true` starts the session without plugins, `false` starts normally. */
export function createOfferGate(
  resolve: (safe: boolean) => Promise<PluginBootState>,
  apply: (boot: PluginBootState) => void,
): (safe: boolean) => void {
  let answered = false;
  return (safe) => {
    if (answered) return;
    answered = true;
    resolve(safe)
      .then(apply)
      .catch(() => {
        answered = false;
      });
  };
}
