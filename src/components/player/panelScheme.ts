/*
 * The Player panel's dark island. A dark-only visualizer makes the panel (or the ambient stage) stamp
 * `data-theme="dark"` in either theme, so the tokens below it resolve dark while the shell stays light.
 * The stamp is unconditional on the theme: in the dark theme it re-roots to the same values. The shared
 * context and stamp helpers live in `theme/scheme`.
 */

// -- Framework Imports --
import { useEffect, useState } from "react";

// -- Utils Imports --
import type { PanelScheme } from "../../theme/scheme";

// -- Style Imports --
import styles from "./panelScheme.module.css";

/** The scheme a panel takes while its shown kind is dark-only or not. */
export function panelScheme(darkOnly: boolean): PanelScheme {
  return darkOnly ? "dark" : null;
}

// How long the soft-swap class stays on: the colour transition's 0.3s plus a margin.
export const SWAP_HOLD_MS = 400;

interface SwapState {
  darkOnly: boolean;
  soft: boolean;
}

/** The swap state after a render with `darkOnly`: a flip turns the soft class on; the same value keeps `state`. */
export function stepSwap(state: SwapState, darkOnly: boolean): SwapState {
  return state.darkOnly === darkOnly ? state : { darkOnly, soft: true };
}

/** Calls `done` once the hold has run. Returns the cancel, so a flip inside the hold restarts it. */
export function holdSwap(done: () => void): () => void {
  const timer = setTimeout(done, SWAP_HOLD_MS);
  return () => clearTimeout(timer);
}

/**
 * The class that softens a swap of the island: it is on from the commit that flips the scheme until the
 * transition has run, and off at every other time. It rides the same commit as the stamp, so the colours
 * that change in that frame already transition.
 */
export function useSchemeSwap(darkOnly: boolean): string | undefined {
  const [state, setState] = useState<SwapState>({ darkOnly, soft: false });
  const next = stepSwap(state, darkOnly);
  if (next !== state) setState(next);
  const soft = next.soft;

  useEffect(() => {
    if (!soft) return;
    return holdSwap(() => setState((was) => ({ ...was, soft: false })));
  }, [soft, darkOnly]);

  return soft ? styles.swap : undefined;
}
