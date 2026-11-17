// -- State Imports --
import { offeredGroups, type Catalog } from "../../../../state/player/visualizerCatalog";
import { groupLabel, isVisualizerKind } from "../../../../state/player/visualizerRegistry";

// -- Type Imports --
import type { Translate } from "../../../../i18n";
import type { VisualizerKind } from "../../../../state/player/visualizerKind";

/** A run of the strip: a family's id, or "off" for Off on its own at the end. */
export type SheetGroupId = string;

export interface SheetGroup {
  id: SheetGroupId;
  kinds: readonly VisualizerKind[];
}

/** The strip's runs: the families with an offered kind in registry order, then Off. */
export function sheetGroupsOf(catalog: Catalog): readonly SheetGroup[] {
  return [
    ...offeredGroups(catalog).map((g) => ({ id: g.id, kinds: g.kinds.filter(isVisualizerKind) })),
    { id: "off", kinds: ["off"] },
  ];
}

/** A run's localized name. */
export function sheetGroupLabel(id: SheetGroupId, t: Translate): string {
  return id === "off" ? t((d) => d.player.visualizerOff) : groupLabel(id, t);
}

/** The run the chips read as current: `picked` while it still exists, else the first. */
export function currentGroup(groups: readonly SheetGroup[], picked: SheetGroupId): SheetGroupId {
  return groups.some((g) => g.id === picked) ? picked : groups[0].id;
}

/** Whether the chip row has anything to jump between: one family and Off would only repeat the headings. */
export function showsChips(groups: readonly SheetGroup[]): boolean {
  return groups.length > 2;
}
