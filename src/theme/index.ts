/*
 * The theme runtime. The active choice lives in the preferences store, so it persists through the
 * settings kv and hydrates on mount like every other pref. Applying it stamps `data-theme` on the
 * document root: "light" and "dark" force that theme, "system" clears the stamp so the token CSS
 * falls back to prefers-color-scheme.
 */

// -- Framework Imports --
import { useEffect } from "react";

// -- State Imports --
import { PREF_KEYS, usePreference, useSetPreference } from "../state/preferences/store";

/** The theme options: an explicit light or dark stamp, or system to follow prefers-color-scheme. */
export type ThemeChoice = "system" | "light" | "dark";

function isThemeChoice(value: string | undefined): value is ThemeChoice {
  return value === "system" || value === "light" || value === "dark";
}

/** The active theme from the pref, validated and defaulted to system. */
export function useTheme(): ThemeChoice {
  const stored = usePreference(PREF_KEYS.theme);
  return isThemeChoice(stored) ? stored : "system";
}

/** Sets the active theme through the persisted pref. */
export function useSetTheme(): (theme: ThemeChoice) => void {
  const setPreference = useSetPreference();
  return (theme) => setPreference(PREF_KEYS.theme, theme);
}

/** Stamps the document root from the active theme: light/dark set data-theme, system removes it. */
export function useApplyTheme(): void {
  const theme = useTheme();
  useEffect(() => {
    if (theme === "system") {
      delete document.documentElement.dataset.theme;
    } else {
      document.documentElement.dataset.theme = theme;
    }
  }, [theme]);
}
