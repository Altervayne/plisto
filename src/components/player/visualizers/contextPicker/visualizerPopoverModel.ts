/*
 * What the context-menu visualizer popover shows for one album or track: the tier a pick writes, the
 * kind stored there, the top row's label and check, the album default a track falls back to, the tab
 * markers and the tab it opens on. Pure, so every state is tested apart from the menu.
 *
 * A single has one tier, its album, so its track writes the album tier and offers no album default to
 * fall back to. A stored string that names no kind reads as no default. A stored kind the catalog turns
 * off reads as no default too, and is reported apart so the popover can say so.
 */

// -- State Imports --
import { isOffered, offeredGroups, type Catalog } from "../../../../state/player/visualizerCatalog";
import { isVisualizerKind } from "../../../../state/player/visualizerRegistry";

// -- Type Imports --
import type { VisualizerKind } from "../../../../state/player/visualizerKind";
import type { DefaultTier, SkippedDefault, TrackPlace } from "../../../../state/player/visualizerResolve";

/** What the popover targets: an album from its card or shelf record, or a track placed in the library. */
export type PopoverSubject = { kind: "album"; albumId: number } | { kind: "track"; place: TrackPlace };

/** The stored strings that apply to the subject, verbatim from the defaults store. */
export interface PopoverStored {
  trackDefault: string | null;
  albumDefault: string | null;
}

/** A tab: a family with an offered kind, and those kinds. */
export interface PopoverGroup {
  id: string;
  kinds: readonly VisualizerKind[];
}

export interface PopoverModel {
  // The row a pick writes; null for a file opened from disk, which has nowhere to store one.
  target: { tier: DefaultTier; id: number } | null;
  single: boolean;
  // The kind stored at the target tier when the catalog offers it, Off included.
  stored: VisualizerKind | null;
  // The kind stored at the target tier when the catalog turns it off.
  turnedOff: SkippedDefault | null;
  // On a track filed in an album, the album's default: what the track shows while it holds none.
  albumDefault: VisualizerKind | null;
  // The album's default when the catalog turns it off, on a track filed in an album.
  albumDefaultOff: VisualizerKind | null;
  // The top row reads "Use album default" when there is one to fall back to, "Use global pick" otherwise.
  topLabel: { form: "global" } | { form: "albumDefault"; kind: VisualizerKind };
  // The top row is checked while the target tier holds no offered kind.
  topChecked: boolean;
  // The album default's tile, outlined-tagged, when it is not the stored kind.
  setAside: VisualizerKind | null;
  // The tabs, in family order.
  groups: readonly PopoverGroup[];
  markers: Record<string, { active: boolean; setAside: boolean }>;
  openTab: string;
}

/** A stored string split by the catalog: the kind when offered, else the known kind it turns off. */
function read(raw: string | null, catalog: Catalog): { offered: VisualizerKind | null; off: VisualizerKind | null } {
  if (!isVisualizerKind(raw)) return { offered: null, off: null };
  return isOffered(catalog, raw) ? { offered: raw, off: null } : { offered: null, off: raw };
}

function groupOf(catalog: Catalog, kind: VisualizerKind | null): string | null {
  return kind == null ? null : (catalog.entries.find((e) => e.id === kind)?.group ?? null);
}

function tiersOf(
  subject: PopoverSubject,
  stored: PopoverStored,
  catalog: Catalog,
): Pick<PopoverModel, "target" | "single" | "stored" | "turnedOff" | "albumDefault" | "albumDefaultOff"> {
  const own = (tier: DefaultTier, raw: string | null) => {
    const { offered, off } = read(raw, catalog);
    return { stored: offered, turnedOff: off ? { kind: off, tier } : null };
  };
  if (subject.kind === "album") {
    return {
      target: { tier: "album", id: subject.albumId },
      single: false,
      ...own("album", stored.albumDefault),
      albumDefault: null,
      albumDefaultOff: null,
    };
  }
  const { place } = subject;
  switch (place.kind) {
    case "adhoc":
      return {
        target: null,
        single: false,
        stored: null,
        turnedOff: null,
        albumDefault: null,
        albumDefaultOff: null,
      };
    case "loose":
      return {
        target: { tier: "track", id: place.trackId },
        single: false,
        ...own("track", stored.trackDefault),
        albumDefault: null,
        albumDefaultOff: null,
      };
    case "single":
      return {
        target: { tier: "album", id: place.albumId },
        single: true,
        ...own("album", stored.albumDefault),
        albumDefault: null,
        albumDefaultOff: null,
      };
    case "album": {
      const album = read(stored.albumDefault, catalog);
      return {
        target: { tier: "track", id: place.trackId },
        single: false,
        ...own("track", stored.trackDefault),
        albumDefault: album.offered,
        albumDefaultOff: album.off,
      };
    }
  }
}

export function visualizerPopoverModel(
  subject: PopoverSubject,
  stored: PopoverStored,
  catalog: Catalog,
): PopoverModel {
  const tiers = tiersOf(subject, stored, catalog);
  const setAside = tiers.albumDefault !== tiers.stored ? tiers.albumDefault : null;
  const groups = offeredGroups(catalog).map((g) => ({ id: g.id, kinds: g.kinds.filter(isVisualizerKind) }));
  const activeGroup = groupOf(catalog, tiers.stored);
  const setAsideGroup = groupOf(catalog, setAside);
  const markers: PopoverModel["markers"] = {};
  for (const { id } of groups) markers[id] = { active: activeGroup === id, setAside: setAsideGroup === id };
  return {
    ...tiers,
    topLabel: tiers.albumDefault ? { form: "albumDefault", kind: tiers.albumDefault } : { form: "global" },
    topChecked: tiers.stored == null,
    setAside,
    groups,
    markers,
    openTab: activeGroup ?? groupOf(catalog, tiers.albumDefault) ?? groups[0]?.id ?? "",
  };
}
