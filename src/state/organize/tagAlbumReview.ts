/*
 * The review rules over albums-from-tags proposals: where each one files by default, what makes a row
 * start unchecked, and how the checked rows become the plans the backend writes. Pure, so the review
 * sheet only holds the user's choices and renders.
 */

// -- Type Imports --
import type { TagAlbumPlan } from "../../types";
import type { ProposalNote, ProposalWarning, TagAlbumProposal } from "./groupByAlbumTags";

/** Where a proposal files: a new album, an existing one, or not yet chosen among several matches. */
export type TargetChoice = { kind: "new" } | { kind: "existing"; albumId: number } | { kind: "unset" };

/** One existing match files there by default; several wait for a pick; none makes a new album. */
export function defaultChoice(p: TagAlbumProposal): TargetChoice {
  if (p.matches.length === 1) return { kind: "existing", albumId: p.matches[0].album.id };
  if (p.matches.length > 1) return { kind: "unset" };
  return { kind: "new" };
}

/** The check-first warnings for a proposal under a target: its own, plus a numbering clash with it. */
export function checkFirst(p: TagAlbumProposal, choice: TargetChoice): ProposalWarning[] {
  if (choice.kind !== "existing") return p.warnings;
  const match = p.matches.find((m) => m.album.id === choice.albumId);
  return match?.collides ? [...p.warnings, { kind: "collides" }] : p.warnings;
}

/**
 * The notes shown for a proposal under a target. A numbering gap is expected when tracks continue an
 * existing album, so it only shows for a new one.
 */
export function visibleNotes(p: TagAlbumProposal, choice: TargetChoice): ProposalNote[] {
  return choice.kind === "existing" ? p.notes.filter((n) => n.kind !== "gap") : p.notes;
}

/** True when a proposal deserves a look before filing, judged on its default target. */
export function needsLook(p: TagAlbumProposal): boolean {
  const choice = defaultChoice(p);
  return choice.kind === "unset" || checkFirst(p, choice).length > 0;
}

/** A row starts checked only with a resolved target and nothing to check first. */
export function defaultChecked(p: TagAlbumProposal): boolean {
  const choice = defaultChoice(p);
  return choice.kind !== "unset" && checkFirst(p, choice).length === 0;
}

/**
 * The plans for every checked proposal with a resolved target, in proposal order. A proposal left on
 * `unset` is never sent, whatever its checkbox says.
 */
export function buildPlans(
  proposals: TagAlbumProposal[],
  checked: ReadonlySet<string>,
  choices: ReadonlyMap<string, TargetChoice>,
): TagAlbumPlan[] {
  const plans: TagAlbumPlan[] = [];
  for (const p of proposals) {
    if (!checked.has(p.key)) continue;
    const choice = choices.get(p.key) ?? defaultChoice(p);
    if (choice.kind === "unset") continue;
    plans.push({
      track_ids: p.tracks.map((t) => t.id),
      target:
        choice.kind === "new"
          ? { kind: "new", fields: p.fields }
          : { kind: "existing", album_id: choice.albumId },
    });
  }
  return plans;
}

/** How many new albums and how many existing ones a set of plans touches. */
export function planCounts(plans: TagAlbumPlan[]): { created: number; extended: number } {
  const created = plans.filter((p) => p.target.kind === "new").length;
  const extended = new Set(
    plans.flatMap((p) => (p.target.kind === "existing" ? [p.target.album_id] : [])),
  ).size;
  return { created, extended };
}
