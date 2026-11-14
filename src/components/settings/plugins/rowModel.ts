/*
 * What a hub row and its uninstall dialog say, decided from the registry row alone: the display name,
 * the status line, which one action the row offers, and the wording of the uninstall prompt. Pure, so
 * the components only translate and draw.
 */

// -- Utils Imports --
import { tagKind } from "../../../state/plugins/trust";

// -- Type Imports --
import type { PluginTagKind, ProbeOutcome } from "../../../state/plugins/trust";
import type { PluginInboxItem, PluginRow } from "../../../types";

/** The status line of a row, before translation. */
export type RowStatus =
  | { kind: "on"; background: boolean }
  | { kind: "off" }
  | { kind: "needsConsent" }
  | { kind: "unreadable" }
  | { kind: "broken"; reason: string | null }
  | { kind: "incompatible"; minVersion: string | null };

/** The one action a row offers inline: the enable switch, Review, or Uninstall. */
export type RowAction = "switch" | "review" | "uninstall";

export interface RowView {
  /** The manifest name, or the id when the manifest cannot be read. */
  name: string;
  /** Null when the manifest cannot be read: the registry then holds a placeholder. */
  version: string | null;
  tag: PluginTagKind | null;
  status: RowStatus;
  warn: boolean;
  action: RowAction;
  /** Whether a details panel opens under the row. */
  expandable: boolean;
  /** The switch is shown but cannot be flipped (a plugin this Plisto cannot run). */
  locked: boolean;
  grey: boolean;
}

export function rowView(row: PluginRow, probe: ProbeOutcome): RowView {
  const m = row.manifest;
  const base = {
    name: m?.name ?? row.id,
    version: m ? row.version : null,
    tag: m ? tagKind(row.tier, probe) : null,
  };
  switch (row.state) {
    case "ready":
      return {
        ...base,
        status: { kind: row.enabled ? "on" : "off", background: row.granted.includes("background") } as RowStatus,
        warn: false,
        action: "switch",
        expandable: true,
        locked: false,
        grey: false,
      };
    case "needs_consent":
      return {
        ...base,
        status: m ? { kind: "needsConsent" } : { kind: "unreadable" },
        warn: !m,
        action: m ? "review" : "uninstall",
        expandable: !!m,
        locked: false,
        grey: false,
      };
    case "broken":
      return {
        ...base,
        status: { kind: "broken", reason: row.problem },
        warn: true,
        action: "uninstall",
        expandable: false,
        locked: false,
        grey: false,
      };
    case "incompatible":
      return {
        ...base,
        status: {
          kind: "incompatible",
          minVersion: m?.compat.state === "needs_newer" ? m.compat.min_plisto : null,
        },
        warn: false,
        action: "switch",
        expandable: true,
        locked: true,
        grey: true,
      };
  }
}

/** Which prompt the uninstall dialog shows for a row. */
export type UninstallPrompt = "ui" | "uiOff" | "native" | "nativeOff" | "incompatible" | "broken";

export function uninstallPrompt(row: PluginRow): UninstallPrompt {
  if (row.state === "broken") return "broken";
  if (row.state === "incompatible") return "incompatible";
  const native = row.tier === "native";
  if (row.enabled) return native ? "native" : "ui";
  return native ? "nativeOff" : "uiOff";
}

/** Whether an inbox item is the file or folder an installed plugin came from (paths compare ignoring case). */
export function installedFrom(item: PluginInboxItem, rows: PluginRow[]): boolean {
  const path = item.path.toLowerCase();
  return rows.some((r) => r.source_path !== null && r.source_path.toLowerCase() === path);
}
