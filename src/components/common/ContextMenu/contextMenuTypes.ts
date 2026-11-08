// -- Framework Imports --
import type { ReactNode } from "react";

/**
 * How an action reads: a plain neutral action, or a destructive one tinted with the warn token so a
 * delete or remove stands apart from the rest. Kept as a string union so more intents can join later
 * without touching call sites that only set the two.
 */
export type MenuActionStyle = "default" | "destructive";

/** An icon-only action in the menu's top bar. Its tooltip is both its hover label and accessible name. */
export interface TopAction {
  icon: ReactNode;
  onSelect: () => void;
  tooltip?: string;
  disabled?: boolean;
  style?: MenuActionStyle;
}

/** A row in the vertical list: an optional leading icon, a required label, and what selecting it does. */
export interface MenuItem {
  icon?: ReactNode;
  label: string;
  onSelect: () => void;
  tooltip?: string;
  disabled?: boolean;
  style?: MenuActionStyle;
  /**
   * Turns the row into the opener of a side panel beside the menu, whose content this returns; the row
   * then opens the panel instead of calling `onSelect`. `close` dismisses the panel and the menu; `back`
   * dismisses the panel only and refocuses the row.
   */
  panel?: (api: MenuPanelApi) => ReactNode;
}

/** What a side panel's content can do to the menu that opened it. */
export interface MenuPanelApi {
  close: () => void;
  back: () => void;
}

/** A divider between entries in either list; modelled as a sentinel so it rides in the same array. */
export interface MenuSeparator {
  separator: true;
}

export type TopEntry = TopAction | MenuSeparator;
export type MenuEntry = MenuItem | MenuSeparator;

/** Narrows an entry to a separator so the render and the focus order can skip it. */
export function isSeparator(entry: TopEntry | MenuEntry): entry is MenuSeparator {
  return "separator" in entry && entry.separator === true;
}
