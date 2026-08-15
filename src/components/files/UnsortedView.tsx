// -- Component Imports --
import { LibraryBrowser } from "./LibraryBrowser";
import { EmptyState } from "../common/EmptyState";

// -- State Imports --
import { useUnsortedTracks } from "../../state/organize/store";

// -- i18n Imports --
import { useT } from "../../i18n";

/**
 * The Unsorted workspace: the folder browser scoped to the loose tracks - those with no album or single
 * membership. Only folders holding an unsorted track appear, so the hierarchy narrows to the still-to-sort
 * pile. It shares the store selection and the floating action bar, so Create album and Add to album
 * organize a track straight out of here and the list shrinks toward empty. When nothing is loose the whole
 * library is sorted, so a calm terminal state stands in for the browser.
 */
export function UnsortedView() {
  const t = useT();

  return (
    <LibraryBrowser
      tracks={useUnsortedTracks()}
      emptyState={
        <EmptyState
          tone="good"
          title={t((d) => d.unsorted.emptyTitle)}
          line={t((d) => d.unsorted.emptyLine)}
        />
      }
    />
  );
}
