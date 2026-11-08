/*
 * What the context-menu visualizer popover shows for one album or track: the tier a pick writes, the
 * kind stored there, the top row's label and check, the album default a track falls back to, the tab
 * markers and the tab it opens on. Pure, so every state is tested apart from the menu.
 *
 * A single has one tier, its album, so its track writes the album tier and offers no album default to
 * fall back to. A stored string that names no kind reads as no default.
 */

// -- State Imports --
import { descriptorOf, isVisualizerKind } from "../../../../state/player/visualizerRegistry";

// -- Type Imports --
import type { VisualizerGroupId } from "../../../../state/player/visualizerRegistry";
import type { VisualizerKind } from "../../../../state/player/visualizerKind";
import type { DefaultTier, TrackPlace } from "../../../../state/player/visualizerResolve";

/** What the popover targets: an album from its card or shelf record, or a track placed in the library. */
export type PopoverSubject = { kind: "album"; albumId: number } | { kind: "track"; place: TrackPlace };

/** The stored strings that apply to the subject, verbatim from the defaults store. */
export interface PopoverStored {
  trackDefault: string | null;
  albumDefault: string | null;
}

export interface PopoverModel {
  // The row a pick writes; null for a file opened from disk, which has nowhere to store one.
  target: { tier: DefaultTier; id: number } | null;
  single: boolean;
  // The kind stored at the target tier, Off included.
  stored: VisualizerKind | null;
  // On a track filed in an album, the album's default: what the track shows while it holds none.
  albumDefault: VisualizerKind | null;
  // The top row reads "Use album default" when there is one to fall back to, "Use global pick" otherwise.
  topLabel: { form: "global" } | { form: "albumDefault"; kind: VisualizerKind };
  // The top row is checked while the target tier holds no known kind.
  topChecked: boolean;
  // The album default's tile, outlined-tagged, when it is not the stored kind.
  setAside: VisualizerKind | null;
  markers: Record<VisualizerGroupId, { active: boolean; setAside: boolean }>;
  openTab: VisualizerGroupId;
}

function known(raw: string | null): VisualizerKind | null {
  return isVisualizerKind(raw) ? raw : null;
}

function groupOf(kind: VisualizerKind | null): VisualizerGroupId | null {
  return kind == null || kind === "off" ? null : descriptorOf(kind).group;
}

function tiersOf(
  subject: PopoverSubject,
  stored: PopoverStored,
): Pick<PopoverModel, "target" | "single" | "stored" | "albumDefault"> {
  if (subject.kind === "album") {
    return {
      target: { tier: "album", id: subject.albumId },
      single: false,
      stored: known(stored.albumDefault),
      albumDefault: null,
    };
  }
  const { place } = subject;
  switch (place.kind) {
    case "adhoc":
      return { target: null, single: false, stored: null, albumDefault: null };
    case "loose":
      return {
        target: { tier: "track", id: place.trackId },
        single: false,
        stored: known(stored.trackDefault),
        albumDefault: null,
      };
    case "single":
      return {
        target: { tier: "album", id: place.albumId },
        single: true,
        stored: known(stored.albumDefault),
        albumDefault: null,
      };
    case "album":
      return {
        target: { tier: "track", id: place.trackId },
        single: false,
        stored: known(stored.trackDefault),
        albumDefault: known(stored.albumDefault),
      };
  }
}

export function visualizerPopoverModel(subject: PopoverSubject, stored: PopoverStored): PopoverModel {
  const tiers = tiersOf(subject, stored);
  const setAside = tiers.albumDefault !== tiers.stored ? tiers.albumDefault : null;
  const activeGroup = groupOf(tiers.stored);
  const setAsideGroup = groupOf(setAside);
  const marker = (id: VisualizerGroupId) => ({ active: activeGroup === id, setAside: setAsideGroup === id });
  return {
    ...tiers,
    topLabel: tiers.albumDefault ? { form: "albumDefault", kind: tiers.albumDefault } : { form: "global" },
    topChecked: tiers.stored == null,
    setAside,
    markers: { classic: marker("classic"), dots: marker("dots"), fluid: marker("fluid"), cozy: marker("cozy") },
    openTab: activeGroup ?? groupOf(tiers.albumDefault) ?? "classic",
  };
}
