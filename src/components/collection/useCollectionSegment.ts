// -- State Imports --
import { useStoredCollectionSegment } from "../../state/collection/store";
import { useAppMode } from "../../state/player/store";

// -- Unit Imports --
import { resolveSegment, visibleSegments } from "./collectionSegments";

// -- Type Imports --
import type { CollectionSegment } from "../../state/collection/store";

/** The segment the Collection shows: the remembered one when the mode still shows it, else Albums. */
export function useCollectionSegment(): CollectionSegment {
  const stored = useStoredCollectionSegment();
  const appMode = useAppMode();
  return resolveSegment(stored, visibleSegments(appMode));
}
