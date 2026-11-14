/*
 * What each surface shows for a plugin's supervised status, as pure code: the rail dot and its words, the
 * page body, and the hub line with its Restart. One function reads (runtime, row, status) and every
 * surface draws from the result, so the dot, the page and the hub cannot disagree. Held and safe runtimes
 * show nothing: no plugin has started. A takeover holder reads cyan whatever it reported. Components
 * translate the kinds; nothing here is user text except the plugin's own capped report.
 */

// -- Type Imports --
import type { FramePhase } from "./frameModel";
import type { PluginRow, PluginRuntime, PluginStatus } from "../../types";

export type DotTone = "idle" | "on" | "warn";

type FailReason = Extract<PluginStatus, { host: "failed" }>["reason"];

/** The words beside a dot or in a page header. `reported` is the plugin's own text, plain and capped. */
export type StatusText =
  | { kind: "reported"; text: string }
  | { kind: "starting" | "notResponding" | "stopped" | "failed" };

/** What a plugin page shows in place of, or over, its content. */
export type PageBody =
  | { kind: "none" }
  | { kind: "starting" }
  | { kind: "frame" }
  /** `takeoverLine`: Plisto took its speakers back from this plugin, so the overlay says so. */
  | { kind: "notResponding"; takeoverLine: boolean }
  | { kind: "restarting" }
  | { kind: "stopped" }
  | { kind: "failed"; reason: FailReason }
  | { kind: "gone" };

/** The status line of a hub row. */
export type HubLine =
  | { kind: "reported"; text: string }
  | { kind: "starting" | "notResponding" | "restarting" | "stopped" | "crashLoop" }
  | { kind: "failed"; reason: FailReason };

export interface StatusView {
  dot: DotTone | null;
  tip: StatusText | null;
  body: PageBody;
  hub: HubLine | null;
  /** Whether the hub row offers Restart. */
  restart: boolean;
}

const NOTHING: StatusView = { dot: null, tip: null, body: { kind: "none" }, hub: null, restart: false };

/** The one report line of a running plugin, or null when it reported no text. */
function reportedText(status: PluginStatus): string | null {
  const text = status.reported?.text?.trim();
  return text ? text : null;
}

/** Implements the status table row by row. */
export function statusView(
  runtime: PluginRuntime | null,
  row: PluginRow,
  status: PluginStatus | undefined,
): StatusView {
  if (runtime !== "running" || !status) return NOTHING;
  // An auto-disabled plugin is off by definition; its line survives until it is enabled again.
  if (status.host === "crash_loop") {
    return { ...NOTHING, body: { kind: "gone" }, hub: { kind: "crashLoop" } };
  }
  if (!row.enabled) return NOTHING;

  switch (status.host) {
    case "off":
      return NOTHING;
    case "starting":
      return {
        dot: null,
        tip: { kind: "starting" },
        body: { kind: "starting" },
        hub: { kind: "starting" },
        restart: false,
      };
    case "stopping":
      // An update swaps the process under an open page: the page reads as starting, with no dot.
      return { ...NOTHING, body: { kind: "starting" } };
    case "running": {
      const text = reportedText(status);
      const tone: DotTone | null = status.takeover ? "on" : (status.reported?.state ?? null);
      return {
        dot: tone,
        tip: text ? { kind: "reported", text } : null,
        body: { kind: "frame" },
        hub: text ? { kind: "reported", text } : null,
        restart: false,
      };
    }
    case "not_responding":
      return {
        dot: "warn",
        tip: { kind: "notResponding" },
        body: { kind: "notResponding", takeoverLine: status.takeover_revoked === "not_responding" },
        hub: { kind: "notResponding" },
        restart: true,
      };
    case "restarting":
      return {
        dot: "warn",
        tip: { kind: "stopped" },
        body: { kind: "restarting" },
        hub: { kind: "restarting" },
        restart: false,
      };
    case "stopped":
      return {
        dot: "warn",
        tip: { kind: "stopped" },
        body: { kind: "stopped" },
        hub: { kind: "stopped" },
        restart: true,
      };
    case "failed":
      return {
        dot: "warn",
        tip: { kind: "failed" },
        body: { kind: "failed", reason: status.reason },
        hub: { kind: "failed", reason: status.reason },
        restart: false,
      };
  }
}

/** The page of a plugin as drawn: its body, the header words and whether the header carries a warn dot. */
export interface PageState {
  body: PageBody;
  head: StatusText | null;
  warn: boolean;
}

/**
 * Settles the page of a plugin from its status view and, for a framed (UI) plugin, the local phase of
 * its frame. The frame layer owns a frame's own life, so for a framed plugin its phase decides starting,
 * live, not responding and stopped; Rust's `restarting`, `failed` and `gone` still win because the frame
 * is unmounted then. A plugin without a frame takes its body from the status alone.
 */
export function pageState(view: StatusView, framed: boolean, phase: FramePhase | undefined): PageState {
  const warn = view.dot === "warn";
  if (!framed) return { body: view.body, head: view.tip, warn };

  const { kind } = view.body;
  if (kind === "restarting" || kind === "failed" || kind === "gone") {
    return { body: view.body, head: view.tip, warn };
  }
  switch (phase) {
    case "crashed":
      return { body: { kind: "stopped" }, head: { kind: "stopped" }, warn: true };
    case "not_responding":
      return { body: { kind: "frame" }, head: { kind: "notResponding" }, warn: true };
    case "unavailable":
      return { body: { kind: "none" }, head: null, warn: false };
    case "live":
      return { body: { kind: "frame" }, head: view.tip, warn };
    default:
      return { body: { kind: "starting" }, head: { kind: "starting" }, warn: false };
  }
}

/** One crash as the details line needs it: the reason, the exit code in hex and the local time. */
export interface CrashDetail {
  reason: string;
  /** `0x` and eight upper-case hex digits, or null when the process left no code. */
  code: string | null;
  /** `HH:MM:SS` local time, or null when no time is known. */
  time: string | null;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Formats a crash record for the details line. */
export function crashDetail(crash: PluginStatus["crash"], fallbackReason: string | null): CrashDetail | null {
  if (!crash) return fallbackReason ? { reason: fallbackReason, code: null, time: null } : null;
  const at = new Date(crash.at_ms);
  return {
    reason: crash.reason,
    code: crash.exit_code == null ? null : `0x${(crash.exit_code >>> 0).toString(16).toUpperCase().padStart(8, "0")}`,
    time: `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`,
  };
}
