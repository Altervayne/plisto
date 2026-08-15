// -- Component Imports --
import { LibraryBrowser } from "./LibraryBrowser";

// -- State Imports --
import { useTracks } from "../../state/store";

/**
 * All Tracks mode: the folder browser over every scanned file. It anchors on the roots and, with no
 * terminal state passed, an empty library rests on the browser's own quiet empty grid.
 */
export function FilesView() {
  return <LibraryBrowser tracks={useTracks()} />;
}
