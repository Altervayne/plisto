// -- Framework Imports --
import { createElement, useCallback, useMemo } from "react";
import type { ReactNode } from "react";

// -- Component Imports --
import { KindTag } from "../tiles/KindTag";

// -- State Imports --
import { defaultWaits } from "../../../../state/player/visualizerResolve";

// -- Type Imports --
import type { VisualizerKind } from "../../../../state/player/visualizerKind";
import type { DefaultTier, Resolution } from "../../../../state/player/visualizerResolve";
import type { ChipMarkers } from "./GroupChips";

// -- Local Imports --
import type { SheetGroup, SheetGroupId } from "./sheetGroups";

// -- i18n Imports --
import { useT } from "../../../../i18n";

export interface SheetTag {
  form: "filled" | "set-aside";
  tier: DefaultTier;
}

// The default an override or the global pick Off keeps from drawing.
function setAside(res: Resolution): boolean {
  return res.source === "override" || defaultWaits(res);
}

/** The tag on a kind's thumb: filled on the default in effect, outlined on a default set aside. */
export function tagOf(res: Resolution, kind: VisualizerKind): SheetTag | null {
  if (res.defaultTier == null || res.defaultKind == null) return null;
  if (setAside(res)) {
    return kind === res.defaultKind ? { form: "set-aside", tier: res.defaultTier } : null;
  }
  return kind === res.picked ? { form: "filled", tier: res.defaultTier } : null;
}

function groupOf(groups: readonly SheetGroup[], kind: VisualizerKind): SheetGroupId | undefined {
  return groups.find((g) => g.kinds.includes(kind))?.id;
}

/** The chip dots: filled on the picked kind's group, ringed on the set-aside default's group. */
export function markersOf(res: Resolution, groups: readonly SheetGroup[]): ChipMarkers {
  const markers: ChipMarkers = {};
  const active = groupOf(groups, res.picked);
  if (active) markers[active] = { active: true };
  const aside = setAside(res) && res.defaultKind ? groupOf(groups, res.defaultKind) : undefined;
  if (aside) markers[aside] = { ...markers[aside], setAside: true };
  return markers;
}

/** The strip's tag renderer and the chips' markers for a resolution, both updating in place. */
export function useSheetDefaults(res: Resolution, groups: readonly SheetGroup[]): {
  tagFor: (kind: VisualizerKind) => ReactNode;
  markers: ChipMarkers;
} {
  const t = useT();
  const tagFor = useCallback(
    (kind: VisualizerKind) => {
      const tag = tagOf(res, kind);
      if (!tag) return undefined;
      const label = tag.tier === "track" ? t((d) => d.player.visualizerTagTrack) : t((d) => d.player.visualizerTagAlbum);
      return createElement(KindTag, { form: tag.form, label });
    },
    [res, t],
  );
  const markers = useMemo(() => markersOf(res, groups), [res, groups]);
  return { tagFor, markers };
}
