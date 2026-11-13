// -- Utils Imports --
import { tagKind } from "../../state/plugins/trust";

// -- Type Imports --
import type { PluginTagKind } from "../../state/plugins/trust";
import type { PluginToastEvent } from "../../state/plugins/uiQueue";
import type { PluginRow } from "../../types";

/** What a plugin toast pill shows. */
export interface ToastLine {
  /** The manifest name, never a name the plugin sent with the toast. */
  name: string;
  tag: PluginTagKind | null;
  text: string;
  action: string | null;
}

/**
 * The pill's content for a toast, or null when the plugin's row or manifest is gone and there is no
 * trustworthy name to draw it under.
 */
export function toastLine(row: PluginRow | undefined, event: PluginToastEvent): ToastLine | null {
  if (!row?.manifest) return null;
  return {
    name: row.manifest.name,
    tag: tagKind(row.tier),
    text: event.payload.text,
    action: event.payload.action,
  };
}
