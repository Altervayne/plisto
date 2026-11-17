/*
 * The colour scheme a surface imposes on its subtree. A dark island stamps `data-theme="dark"` on its root
 * and provides this context, so a portal opened from inside it (which lands outside the stamped DOM)
 * can stamp its own root, and readers of the root theme alone can follow the island.
 */

// -- Framework Imports --
import { createContext, useContext } from "react";

/** `"dark"` inside a dark island; null when the surface follows the theme. */
export type PanelScheme = "dark" | null;

export const PanelSchemeContext = createContext<PanelScheme>(null);

/** The scheme the surrounding island imposes, or null. */
export function usePanelScheme(): PanelScheme {
  return useContext(PanelSchemeContext);
}

/** The attributes a root spreads for a scheme: the dark stamp inside an island, nothing otherwise. */
export function schemeStamp(scheme: PanelScheme): { "data-theme"?: "dark" } {
  return scheme === "dark" ? { "data-theme": "dark" } : {};
}

/** Whether the island or the root theme is dark. */
export function isDarkScheme(scheme: PanelScheme, rootDark: boolean): boolean {
  return scheme === "dark" || rootDark;
}
