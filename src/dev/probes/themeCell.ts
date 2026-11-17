/*
 * The runner's own copy of the current theme. A probe's setTheme takes effect here at once, so the next
 * probe's context and a forced reset read the right theme without waiting for the page to render; `onSet`
 * carries the change on to the page.
 */

// -- Type Imports --
import type { Theme } from "./types";

export interface ThemeCell {
  get(): Theme;
  /** Sets the theme now and tells the page. */
  set(theme: Theme): void;
  /** Takes the page's own value (a render) without telling the page back. */
  adopt(theme: Theme): void;
}

export function createThemeCell(initial: Theme, onSet: (theme: Theme) => void): ThemeCell {
  let value = initial;
  return {
    get: () => value,
    set(theme) {
      value = theme;
      onSet(theme);
    },
    adopt(theme) {
      value = theme;
    },
  };
}
