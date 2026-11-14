/*
 * What the sandbox check proved, and the review sheet and tag each plugin tier earns from it. The check
 * is a canary at every start: only a detected leak reads as not passed, so a check that is still running
 * or could not run changes nothing. A native plugin is always heavy; a UI plugin is calm unless the
 * sandbox is not passed, and then it carries the unsandboxed wording and tag.
 */

// -- Type Imports --
import type { PluginTier } from "../../types";

/** Whether the sandbox check passed. */
export type ProbeOutcome = "passed" | "not_passed";

/** What the check found, as the trust model reads it. */
export function probeOutcome(check: "pending" | "passed" | "leaking" | "unverified"): ProbeOutcome {
  return check === "leaking" ? "not_passed" : "passed";
}

/** The review sheet a plugin gets. */
export type SheetVariant = "calm" | "heavy" | "unsandboxed";

/** The tag a plugin wears next to its name. */
export type PluginTagKind = "native" | "unsandboxed";

export function sheetVariant(tier: PluginTier, probe: ProbeOutcome): SheetVariant {
  if (tier === "native") return "heavy";
  return probe === "passed" ? "calm" : "unsandboxed";
}

/** The tag for a tier, or null for a UI plugin unless the check found a leak. */
export function tagKind(tier: PluginTier, probe: ProbeOutcome): PluginTagKind | null {
  if (tier === "native") return "native";
  return probe === "passed" ? null : "unsandboxed";
}
