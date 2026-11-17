// -- State Imports --
import { useVisualizerCatalog } from "../../../../state/preferences/store";
import type { Catalog } from "../../../../state/player/visualizerCatalog";

// -- Local Imports --
import { sheetGroupsOf, type SheetGroup } from "./sheetGroups";

let memoCatalog: Catalog | null = null;
let memoGroups: readonly SheetGroup[] = [];

/** The strip's runs for the current catalog, one reference until the catalog changes. */
export function useSheetGroups(): readonly SheetGroup[] {
  const catalog = useVisualizerCatalog();
  if (catalog !== memoCatalog) {
    memoCatalog = catalog;
    memoGroups = sheetGroupsOf(catalog);
  }
  return memoGroups;
}
