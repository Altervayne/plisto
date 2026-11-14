/*
 * The pure side of the review flow: what a review sheet shows (a subject built from an inspection or an
 * installed row), which sheet it is, what must be ticked before confirming, and the arguments the
 * confirm sends. No component or command is touched here, so every decision is unit-testable.
 */

// -- Utils Imports --
import { sortCapabilities } from "./capabilities";
import { sheetVariant } from "./trust";
import { versionChange } from "./version";

// -- Type Imports --
import type { VersionChange } from "./version";
import type { ProbeOutcome, SheetVariant } from "./trust";
import type {
  PluginCapability,
  PluginCompat,
  PluginInspection,
  PluginRow,
  PluginTier,
  PluginUpdated,
} from "../../types";

/** What the confirm does: a new install, an update of an installed plugin, or consent for one on disk. */
export type ReviewMode = "install" | "update" | "consent";

/**
 * Why an installed plugin is up for review: Plisto adopted it, an update asked for more, or its files
 * changed since the user approved them. It picks the lead line of the sheet.
 */
export type ReviewLead = "adopted" | "updated" | "changed";

/** What was approved before, so the sheet can mark what is new. `capabilities` is null when nothing was. */
export interface ReviewPrevious {
  version: string;
  capabilities: PluginCapability[] | null;
  origins: string[];
}

/** Everything a review sheet renders, as plain data. */
export interface ReviewSubject {
  id: string;
  name: string;
  version: string;
  author: string;
  homepage: string | null;
  tier: PluginTier;
  /** In sheet order. */
  capabilities: PluginCapability[];
  origins: string[];
  nativeReason: string | null;
  compat: PluginCompat;
  previous: ReviewPrevious | null;
}

/**
 * What an installed plugin stands approved for. `version` overrides the row's when the inspection knows
 * it; capabilities are null unless the row is ready, since only a ready plugin was ever approved.
 */
export function previousFromRow(row: PluginRow | undefined, version = ""): ReviewPrevious {
  return {
    version: version || row?.version || "",
    capabilities: row && row.state === "ready" ? row.granted : null,
    origins: row?.manifest?.origins ?? [],
  };
}

/** The subject of an inspected plugin. An installed row of the same id supplies what was approved. */
export function subjectFromInspection(
  inspection: PluginInspection,
  installed?: PluginRow,
): ReviewSubject {
  return {
    id: inspection.id,
    name: inspection.name,
    version: inspection.version,
    author: inspection.author,
    homepage: inspection.homepage,
    tier: inspection.tier,
    capabilities: sortCapabilities(inspection.capabilities),
    origins: inspection.origins,
    nativeReason: inspection.native_reason,
    compat: inspection.compat,
    previous:
      inspection.installed === null ? null : previousFromRow(installed, inspection.installed),
  };
}

/** The subject of an installed row, or null when its manifest cannot be read. */
export function subjectFromRow(row: PluginRow, previous: ReviewPrevious | null = null): ReviewSubject | null {
  const m = row.manifest;
  if (!m) return null;
  return {
    id: row.id,
    name: m.name,
    version: row.version,
    author: m.author,
    homepage: m.homepage,
    tier: row.tier,
    capabilities: sortCapabilities(m.capabilities),
    origins: m.origins,
    nativeReason: m.native_reason,
    compat: m.compat,
    previous,
  };
}

/** Which of the three sheets the subject gets. */
export const variantOf = (subject: ReviewSubject, probe: ProbeOutcome): SheetVariant =>
  sheetVariant(subject.tier, probe);

/** Whether a capability was not part of what was approved before. False when nothing is known. */
export function isNewCapability(subject: ReviewSubject, capability: PluginCapability): boolean {
  const before = subject.previous?.capabilities;
  if (!before) return false;
  if (!before.includes(capability)) return true;
  // A network line is new too when it reaches an origin the approved version did not.
  return capability === "network" && subject.origins.some((o) => !subject.previous!.origins.includes(o));
}

/** Whether an origin is one the approved version did not declare. */
export function isNewOrigin(subject: ReviewSubject, origin: string): boolean {
  const prev = subject.previous;
  return !!prev?.capabilities && prev.capabilities.includes("network") && !prev.origins.includes(origin);
}

/** Whether the sheet marks anything as new. */
export const hasNewCapabilities = (subject: ReviewSubject): boolean =>
  subject.capabilities.some((c) => isNewCapability(subject, c));

/** How an update's version stands against the installed one. */
export const updateChange = (subject: ReviewSubject): VersionChange =>
  subject.previous ? versionChange(subject.previous.version, subject.version) : "unknown";

/** Whether the confirm turns the plugin on, which is when the user must say they understand. */
export function needsTick(subject: ReviewSubject, mode: ReviewMode, probe: ProbeOutcome): boolean {
  return mode !== "update" && variantOf(subject, probe) !== "calm";
}

/** Whether this Plisto can run the plugin. */
export const isCompatible = (subject: ReviewSubject): boolean => subject.compat.state === "compatible";

/** Whether the confirm button works. */
export function canConfirm(
  subject: ReviewSubject,
  mode: ReviewMode,
  ticked: boolean,
  busy: boolean,
  probe: ProbeOutcome,
): boolean {
  if (busy || !isCompatible(subject)) return false;
  return !needsTick(subject, mode, probe) || ticked;
}

/** The arguments of the `plugin_enable` that turns on what the sheet showed. */
export function enableArgs(subject: ReviewSubject, manifestHash: string, ticked: boolean) {
  return {
    id: subject.id,
    grants: subject.capabilities as string[],
    nativeAck: subject.tier === "native" ? ticked : undefined,
    manifestHash,
  };
}

/**
 * The consent command a mode ends in: an install records consent and leaves the plugin off, a review of
 * an installed plugin also turns it on, and an update has none until it asks for more.
 */
export function consentCommand(mode: ReviewMode): "approve" | "enable" | null {
  return mode === "install" ? "approve" : mode === "consent" ? "enable" : null;
}

/** What follows a finished update: done, or a review of permissions that changed. */
export function afterUpdate(updated: PluginUpdated): "done" | "consent" {
  return updated.row.state === "needs_consent" ? "consent" : "done";
}

/** An enable rejection that means the plugin changed under the sheet, so the review reopens fresh. */
export const reopensReview = (key: string): boolean => key === "manifest_changed" || key === "busy";
