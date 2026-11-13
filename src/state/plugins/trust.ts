/*
 * What the sandbox check proved, and the review sheet and tag each plugin tier earns from it. The check
 * is a build-time fact, so the outcome is a constant. A native plugin is always heavy; a UI plugin is
 * calm only once the sandbox is proven, and until then it carries the unsandboxed wording and tag.
 */

// -- Type Imports --
import type { PluginTier } from "../../types";

/** Whether the sandbox check passed. */
export type ProbeOutcome = "passed" | "not_passed";

/** The recorded outcome of the sandbox check. */
export const SANDBOX_PROBE: ProbeOutcome = "passed";

/** The review sheet a plugin gets. */
export type SheetVariant = "calm" | "heavy" | "unsandboxed";

/** The tag a plugin wears next to its name. */
export type PluginTagKind = "native" | "unsandboxed";

export function sheetVariant(tier: PluginTier, probe: ProbeOutcome = SANDBOX_PROBE): SheetVariant {
  if (tier === "native") return "heavy";
  return probe === "passed" ? "calm" : "unsandboxed";
}

/** The tag for a tier, or null when the plugin is sandboxed and proven so. */
export function tagKind(tier: PluginTier, probe: ProbeOutcome = SANDBOX_PROBE): PluginTagKind | null {
  if (tier === "native") return "native";
  return probe === "passed" ? null : "unsandboxed";
}
